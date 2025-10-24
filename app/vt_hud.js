#!/usr/bin/env node
// app/vt_hud.js — steady VT100 HUD (no flashing) + quote-as-bar
//
// - Draws static frame once (no full-screen clears per tick)
// - Updates only changed cells using cursor addressing
// - Single horizontal bar = YES quote (fill). Remaining = NO.
// - Large numeric quotes printed next to the bar
// - Two trader tapes (UserA/UserB) without clearing whole screen
//
// Usage:
//   node app/vt_hud.js --wallets "./userA.json,./userB.json" --steps 120 --mode mixed --b 8000
//
// Requires trade.js with --jsonl (from our prior patch)

const { spawn } = require("child_process");

// ---- CLI passthrough to trade.js
const argv = process.argv.slice(2);
const TRADE_CMD  = process.execPath;
const TRADE_ARGS = ["app/trade.js", "run", ...argv.filter(x=>x!=="--jsonl"), "--jsonl"];

// ---- VT helpers
const esc=(s)=>`\x1b[${s}`;
const HIDE=esc("?25l"), SHOW=esc("?25h");
const CLEAR=esc("2J"), RESET=esc("0m"), BOLD=esc("1m"), DIM=esc("2m");
const FG=(n)=>esc(`38;5;${n}m`), BG=(n)=>esc(`48;5;${n}m`);
const GOTO=(r,c)=>esc(`${r};${c}H`);

function clamp(n,a,b){return Math.max(a,Math.min(b,n));}
function padR(s,n){s=String(s); return s.length>=n? s.slice(0,n) : s+" ".repeat(n-s.length);}
function padL(s,n){s=String(s); return s.length>=n? s.slice(-n) : " ".repeat(n-s.length)+s;}
function fmtScaled(n,dec){return (n/10**dec).toFixed(dec);}
function fmtUSD(x){
  x=Number(x); if(!isFinite(x)) return "—";
  if(x>=1e9) return `$${(x/1e9).toFixed(2)}B`;
  if(x>=1e6) return `$${(x/1e6).toFixed(2)}M`;
  if(x>=1e3) return `$${(x/1e3).toFixed(1)}k`;
  return `$${x.toFixed(2)}`;
}
function nowStr(){ const d=new Date(); return d.toISOString().split("T")[1].split(".")[0]; }

// ---- Layout constants (rows/cols)
// ---- Layout constants (rows/cols)
const L = {
  titleRow: 1,
  headerTimeCol: 2,

  // Market panel
  boxTopRow: 2,
  boxLeftCol: 2,
  boxWidth: () => (process.stdout.columns || 100) - 3,
  boxHeight: 9,

  // Quote bar region
  qRow: 4,                 // row for the bar
  qCol: 6,                 // starting col for the bar (NOTE: number, not function)
  qWidth: () => Math.min(50, Math.floor((process.stdout.columns || 100) * 0.3)),

  // Quote numbers (use qCol as a number)
  qNumYesRow: 4,
  qNumYesCol: () => L.qCol + L.qWidth() + 4,
  qNumNoRow: 5,
  qNumNoCol: () => L.qCol + L.qWidth() + 4,

  // Stats rows
  statRow1: 7,             // vault/fees/inv
  statRow2: 8,             // W/pps/b/feeBps
  statLeftCol: 6,
  statRightCol: () => Math.floor((process.stdout.columns || 100) / 2) + 2,

  // Tapes
  paneTopRow: () => L.boxTopRow + L.boxHeight + 1,
  paneHeight: () => (process.stdout.rows || 40) - (L.boxTopRow + L.boxHeight + 3),
  paneWidth: () => Math.floor(((process.stdout.columns || 100) - 6) / 2),
  aPaneCol: 2,
  bPaneCol: () => 4 + L.paneWidth(),
};


// ---- Live state
const state = {
  dec: 6,
  quotes: { yes: 0.5, no: 0.5 },
  inv: { yes: 0, no: 0 },
  vault: 0,
  fees: 0,
  wTotal: 0,
  pps: 0,
  bHuman: null,
  feeBps: null,
  winner: null,
  lastPass: null,

  tape: { UserA: [], UserB: [] },
  maxTape: ()=> Math.max(5, L.paneHeight()-2),

  // last drawn to avoid rewriting unchanged content
  _drawn: {}
};

function pushTape(user,row){
  const arr = state.tape[user] || (state.tape[user]=[]);
  arr.push(row);
  const cap = state.maxTape();
  while (arr.length > cap) arr.shift();
}

// ---- Drawing primitives (no full-clear per tick)
function drawBox(x,y,w,h,title=""){
  const horiz = "─".repeat(Math.max(0,w-2));
  process.stdout.write(
    GOTO(y,x) + "┌" + horiz + "┐" +
    GOTO(y+h-1,x) + "└" + horiz + "┘"
  );
  for(let i=1;i<=h-2;i++) {
    process.stdout.write(GOTO(y+i,x) + "│" + " ".repeat(Math.max(0,w-2)) + "│");
  }
  if(title){
    process.stdout.write(GOTO(y,x+2) + esc("7m") + ` ${title} ` + RESET);
  }
}
function put(r,c,text){ process.stdout.write(GOTO(r,c) + text); }
function putPad(r,c,text,width){ process.stdout.write(GOTO(r,c) + padR(text,width)); }
function fill(r,c,width,ch=" "){ process.stdout.write(GOTO(r,c) + ch.repeat(Math.max(0,width))); }

// draw only when value changes
function putOnce(key, r, c, width, text){
  const prev = state._drawn[key];
  if (prev === text) return;
  state._drawn[key] = text;
  putPad(r,c,text,width);
}

// ---- Static frame (once)
function renderStatic(){
  const W = process.stdout.columns || 100;
  const H = process.stdout.rows || 40;

  process.stdout.write(CLEAR + HIDE);

  // Title
  const title = "X1 AMM — Live HUD";
  const tcol = Math.max(2, Math.floor((W - title.length)/2));
  put(L.titleRow, tcol, BOLD + title + RESET);
  put(L.titleRow, L.headerTimeCol, DIM + nowStr() + RESET);

  // Market box
  drawBox(L.boxLeftCol, L.boxTopRow, L.boxWidth(), L.boxHeight, "Market");

  // Tape boxes
  drawBox(L.aPaneCol, L.paneTopRow(), L.paneWidth(), L.paneHeight(), "UserA (tape)");
  drawBox(L.bPaneCol(), L.paneTopRow(), L.paneWidth(), L.paneHeight(), "UserB (tape)");
}

// ---- Dynamic regions
function renderClock(){
  put(L.titleRow, L.headerTimeCol, DIM + nowStr() + RESET);
}

function renderQuotes(){
  const barW = L.qWidth();
  const yes = clamp(state.quotes.yes, 0, 1);
  const no  = 1 - yes;
  const yesFill = Math.round(barW * yes);
  const noFill  = barW - yesFill;

  // YES/NO bar — single line, no clearing entire screen
  fill(L.qRow, L.qCol, barW, " "); // wipe bar area
  const yesBar = BG(28) + " ".repeat(Math.max(0,yesFill)) + RESET;
  const noBar  = BG(196)+ " ".repeat(Math.max(0,noFill))  + RESET;
  put(L.qRow, L.qCol, yesBar + noBar);

  // Big numeric quotes next to bar
  const yesPct = (yes*100).toFixed(2);
  const noPct  = (no *100).toFixed(2);

  putOnce("qYesNum", L.qNumYesRow, L.qNumYesCol(), 18, `${BOLD}${FG(28)}YES ${yesPct}%${RESET}`);
  putOnce("qNoNum",  L.qNumNoRow,  L.qNumNoCol(),  18, `${BOLD}${FG(196)}NO  ${noPct}%${RESET}`);
}

function renderStats(){
  const dec = state.dec;
  const vault = Number(fmtScaled(state.vault, dec));
  const fees  = Number(fmtScaled(state.fees, dec));
  const invY  = Number(fmtScaled(state.inv.yes, dec));
  const invN  = Number(fmtScaled(state.inv.no,  dec));

  const left = `Vault ${fmtUSD(vault)}   Fees $${fees.toFixed(dec)}   InvY ${invY.toLocaleString()}   InvN ${invN.toLocaleString()}`;
  const right= `W ${fmtScaled(state.wTotal, dec)} sh   pps $${fmtScaled(state.pps, dec)}   ${state.bHuman!=null?`b=${state.bHuman}   `:""}${state.feeBps!=null?`fee=${state.feeBps}bps`:""}`;

  putOnce("statsL", L.statRow1, L.statLeftCol,  Math.floor((process.stdout.columns||100)/2)-10, left);
  putOnce("statsR", L.statRow2, L.statLeftCol,  Math.floor((process.stdout.columns||100)/2)-10, right);

  // Winner / PASS-FAIL (same spot, single line)
  let banner = "";
  if (state.winner) banner += `Winner ${state.winner}`;
  if (state.lastPass === true)  banner += `${banner?"  |  ":""}PASS ✅`;
  if (state.lastPass === false) banner += `${banner?"  |  ":""}FAIL ❌`;
  putOnce("banner", L.statRow2, L.statRightCol(), 30, banner);
}

function renderTape(user, x, y){
  const arr = state.tape[user] || [];
  const rows = state.maxTape();
  // erase region once
  for (let i=0;i<rows;i++) fill(y+i, x, L.paneWidth()-2, " ");

  const start = Math.max(0, arr.length - rows);
  let r = 0;
  for (let i=start;i<arr.length;i++){
    const t = arr[i];
    const amt = Number(fmtScaled(t.amount_scaled, t.decimals));
    const qY = t.quotes?.yes ?? null;
    const qN = t.quotes?.no  ?? null;
    const qStr = (qY!=null && qN!=null) ? `Q ${qY.toFixed(4)}/${qN.toFixed(4)}` : "";
    const line = `${padL(t.step??"?",3)} ${padR(t.action,4)} ${padR(t.side,3)} ${amt.toFixed(t.decimals)}  ${qStr}`;
    const color = t.side==="YES"? FG(34) : t.side==="NO"? FG(160) : "";
    putPad(y+r, x, `${color}${line}${RESET}`, L.paneWidth()-2);
    r++;
  }
}

function renderDynamic(){
  renderClock();
  renderQuotes();
  renderStats();
  renderTape("UserA", L.aPaneCol+1, L.paneTopRow()+1);
  renderTape("UserB", L.bPaneCol()+1, L.paneTopRow()+1);
}

// ---- Child process
const child = spawn(TRADE_CMD, TRADE_ARGS, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let buf = "";
child.stdout.on("data", (chunk)=>{
  buf += chunk;
  let idx;
  while((idx = buf.indexOf("\n"))>=0){
    const line = buf.slice(0,idx); buf = buf.slice(idx+1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }

    if (msg.type === "trade"){
      if (typeof msg.decimals === "number") state.dec = msg.decimals;
      if (msg.quotes) state.quotes = msg.quotes;
      if (msg.vault_scaled != null) state.vault = msg.vault_scaled;
      if (msg.inv_scaled) state.inv = { yes: msg.inv_scaled.yes, no: msg.inv_scaled.no };
      if (msg.fees_scaled != null) state.fees = msg.fees_scaled;
      // Optional (if you emit these via JSONL events)
      if (msg.b_human != null) state.bHuman = msg.b_human;
      if (msg.fee_bps  != null) state.feeBps = msg.fee_bps;

      const row = {
        step: msg.step,
        side: msg.side,
        action: msg.action,
        amount_scaled: msg.amount_scaled,
        decimals: msg.decimals,
        quotes: msg.quotes
      };
      if (msg.user === "UserA") pushTape("UserA", row);
      else if (msg.user === "UserB") pushTape("UserB", row);

      renderDynamic();
    }
    else if (msg.type === "event" && msg.name === "resolve"){
      state.winner = msg.winner;
      renderDynamic();
    }
    else if (msg.type === "final"){
      state.lastPass = !!msg.equal;
      renderDynamic();
    }
  }
});

// minimal stderr surfacing (kept off-screen)
child.on("exit",(code)=>{ cleanup(); console.log(`\ntrade.js exited with code ${code}`); process.exit(code||0); });

// ---- Input: q to quit
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data",(b)=>{
  const ch = b.toString("utf8");
  if (ch === "q" || ch === "\u0003"){ child.kill("SIGINT"); cleanup(); process.exit(0); }
});

// ---- Init
function cleanup(){ try{ process.stdout.write(SHOW+RESET+"\n"); }catch{} }
process.on("exit", cleanup);
process.on("SIGINT", ()=>{ cleanup(); process.exit(0); });
process.on("SIGTERM", ()=>{ cleanup(); process.exit(0); });

renderStatic();
renderDynamic();

