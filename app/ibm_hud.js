#!/usr/bin/env node
/**
 * app/ibm_hud.js — IBM-style VT100 HUD for Coverage-LMSR AMM (CommonJS)
 * - Alternate-screen, green-on-black VT100
 * - watch: show live on-chain state every tick
 * - random-duel: A mostly buys YES, B mostly buys NO; STOP→SETTLE→REDEEM; final report
 *
 * Flags:
 *   --wallets a.json[,b.json]
 *   --mode watch|random-duel            (positional also accepted)
 *   --n 400                             (random-duel rounds per user)
 *   --a-yes-prob 0.7  --b-no-prob 0.7
 *   --min-usd 5   --max-usd 200
 *   --force-winner auto|yes|no
 *   --full-state on|off                 (default: off); when on, fetch full state every frame
 *   --cadence 900                       (ms refresh)
 *   --verbose --pretty
 *
 * Keys while HUD runs:
 *   q         quit
 *   space     pause/resume trading in duel mode
 *   s         STOP on-chain
 *   y / n     SETTLE YES / SETTLE NO
 *   d         REDEEM all (A & B) on-chain
 */

const fs = require("fs");
const crypto = require("crypto");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

/* ========= CONFIG ========= */
const RPC     = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const PID     = new PublicKey("7h22sUva8ntjjsoa858Qx6Kxg92JoLH8ryiPgGTXm4ja");
const ORACLE_PID  = new PublicKey("7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE");
const AMM_SEED    = Buffer.from("amm_btc");
const POS_SEED    = Buffer.from("pos");
const ORACLE_SEED = Buffer.from("state_v2");
const CU_LIMIT = 800_000;
const CU_PRICE = 1;

/* ========= CLI ========= */
function hasFlag(name, short){ const a=process.argv; return a.includes(name) || (short && a.includes(short)); }
const VERBOSE = hasFlag("--verbose","-v") || process.env.VERBOSE==="1";
const PRETTY  = hasFlag("--pretty") || process.env.PRETTY==="1";
function argvGet(k, d){ const a=process.argv, i=a.indexOf(k); return (i>=0 && i+1<a.length)? a[i+1] : d; }

const MODE         = (process.argv[2] && !process.argv[2].startsWith("--")) ? process.argv[2] : argvGet("--mode","watch");
const CADENCE_MS   = Math.max(200, parseInt(argvGet("--cadence","900"),10));
const FULL_STATE   = (argvGet("--full-state","off").toLowerCase()==="on");
const N            = Math.max(1, parseInt(argvGet("--n","400"),10));
const A_YES_PROB   = Math.max(0, Math.min(1, parseFloat(argvGet("--a-yes-prob","0.7"))));
const B_NO_PROB    = Math.max(0, Math.min(1, parseFloat(argvGet("--b-no-prob","0.7"))));
const MIN_USD      = Math.max(1, parseFloat(argvGet("--min-usd","5")));
const MAX_USD      = Math.max(MIN_USD, parseFloat(argvGet("--max-usd","200")));
const FORCE_WIN    = argvGet("--force-winner","auto").toLowerCase();
const WALLETS_ARG  = argvGet("--wallets","");

/* ========= VT100 IBM-ish ========= */
const ESC="\x1b", CSI=ESC+"[";
const ALT_ON=CSI+"?1049h", ALT_OFF=CSI+"?1049l";
const HIDE=CSI+"?25l", SHOW=CSI+"?25h";
const RESET=CSI+"0m";
const GREEN=CSI+"32m", BOLD=CSI+"1m", DIM=CSI+"2m", REV=CSI+"7m";
function put(r,c,s){ process.stdout.write(CSI+r+";"+c+"H"+s+CSI+"0K"); }
function clear(){ process.stdout.write(CSI+"2J"+CSI+"H"); }
function enter(){ process.stdout.write(ALT_ON+HIDE+GREEN); }
function leave(){ process.stdout.write(RESET+SHOW+ALT_OFF); }

function pad(s,n){ s=String(s); return s + " ".repeat(Math.max(0, n - s.length)); }
function fmtUSD6(micro){ return (micro/1e6).toLocaleString(undefined,{minimumFractionDigits:6,maximumFractionDigits:6}); }
function fmtSH6(micro){ return (micro/1e6).toLocaleString(undefined,{minimumFractionDigits:6,maximumFractionDigits:6}); }
function fmtInt(x){ return Number(Math.round(x)).toLocaleString(); }
function rng(min,max){ return min + Math.random()*(max-min); }

/* ========= Program helpers ========= */
function disc(name){ return crypto.createHash("sha256").update("global:"+name).digest().subarray(0,8); }
const DISC_INIT_AMM = disc("init_amm");
const DISC_INIT_POS = disc("init_position");
const DISC_QUOTE    = disc("quote");
const DISC_TRADE    = disc("trade");
const DISC_STOP     = disc("stop_market");
const DISC_SETTLE   = disc("settle_market");
const DISC_REDEEM   = disc("redeem");
const DISC_CLOSE    = disc("close_amm");

function u8(n){ const b=Buffer.alloc(1); b.writeUInt8(n); return b; }
function u16le(n){ const b=Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function i64le(n){ let x=BigInt(n); if(x<0n) x=(1n<<64n)+x; const b=Buffer.alloc(8); b.writeBigUInt64LE(x); return b; }

async function ammPda(){ return PublicKey.findProgramAddressSync([AMM_SEED], PID)[0]; }
function posPda(owner, amm){ return PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), owner.toBuffer()], PID)[0]; }
function oraclePda(){ return PublicKey.findProgramAddressSync([ORACLE_SEED], ORACLE_PID)[0]; }

function readI64LE(buf, off){
  const u = buf.readBigUInt64LE(off);
  const max = (1n<<63n)-1n;
  return (u>max)? Number(u - (1n<<64n)) : Number(u);
}
function readU8(buf, off){ return buf.readUInt8(off); }
function readU16LE(buf, off){ return buf.readUInt16LE(off); }

/* ========= RPC & TX ========= */
async function sendTx(conn, tx, signers, label="TX"){
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { skipPreflight:false, commitment:"processed" });
    if (VERBOSE) process.stdout.write(CSI+"999;1H"+RESET+`\n[tx/${label}] ${sig}\n`+GREEN);
    return sig;
  } catch (e) {
    const logs = e?.logs || e?.simulationResponse?.logs || e?.message || e;
    process.stdout.write(CSI+"999;1H"+RESET+`\n[tx/${label}] Simulation failed:\n${logs}\n`+GREEN);
    throw e;
  }
}
function budgetIxs(units=CU_LIMIT, microLamports=CU_PRICE){
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

/* ========= State fetchers ========= */
async function fetchAmmState(conn, amm){
  const info = await conn.getAccountInfo(amm, "processed");
  if (!info) throw new Error("AMM account not found");
  const d = info.data; if (!d || d.length < 8+62) throw new Error("AMM account too small");
  const p = d.subarray(8); let o=0;
  const bump     = readU8(p,o);    o+=1;
  const decimals = readU8(p,o);    o+=1;
  const bScaled  = readI64LE(p,o); o+=8;
  const feeBps   = readU16LE(p,o); o+=2;
  const qY       = readI64LE(p,o); o+=8;
  const qN       = readI64LE(p,o); o+=8;
  const fees     = readI64LE(p,o); o+=8;
  const vault    = readI64LE(p,o); o+=8;
  const status   = readU8(p,o);    o+=1;
  const winner   = readU8(p,o);    o+=1;
  const wTotal   = readI64LE(p,o); o+=8;
  const pps      = readI64LE(p,o); o+=8;
  return { bump, decimals, bScaled, feeBps, qY, qN, fees, vault, status, winner, wTotal, pps };
}

async function fetchPosition(conn, owner, amm){
  const pos = posPda(owner, amm);
  const info = await conn.getAccountInfo(pos, "processed");
  if (!info || info.data.length < 8+32+8+8) return { pos, yes:0, no:0 };
  const p = info.data.subarray(8); let o=0; o+=32;
  const yes = Number(p.readBigInt64LE(o)); o+=8;
  const no  = Number(p.readBigInt64LE(o)); o+=8;
  return { pos, yes:Math.max(0,yes), no:Math.max(0,no) };
}

async function fetchOracleBTC(conn){
  const info = await conn.getAccountInfo(oraclePda(), "processed");
  if (!info) return { price: NaN };
  const p = info.data.subarray(8);
  let o=0; o+=32;
  const p1 = readI64LE(p,o+0), p2 = readI64LE(p,o+8), p3 = readI64LE(p,o+16);
  o += 48 + 48 + 48;
  const dec = readU8(p,o);
  const vals=[p1,p2,p3].filter(x=>x!==0);
  const px = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length)/(10**dec) : NaN;
  return { price: px };
}

/* ========= Instructions ========= */
async function initAmmIx(conn, payer, bScaled, feeBps){
  const amm = await ammPda();
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.concat([DISC_INIT_AMM, i64le(bScaled), u16le(feeBps)]) });
  const tx = new Transaction().add(...budgetIxs(), ix);
  return await sendTx(conn, tx, [payer], "init");
}

async function closeAmmIx(conn, payer){
  const amm = await ammPda();
  const info = await conn.getAccountInfo(amm,"processed");
  if (!info) return null;
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_CLOSE) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  return await sendTx(conn, tx, [payer], "close");
}

async function initPosIx(conn, payer){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const info = await conn.getAccountInfo(pos,"processed");
  if (info) return null;
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:false },
    { pubkey: pos, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_INIT_POS) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  return await sendTx(conn, tx, [payer], "init-pos");
}

async function tradeIx(conn, payer, side, usd){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const data = Buffer.concat([DISC_TRADE, u8(side), u8(1), i64le(Math.round(usd*1e6))]); // BUY only
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: pos, isSigner:false, isWritable:true },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data });
  const tx = new Transaction().add(...budgetIxs(), ix);
  return await sendTx(conn, tx, [payer], `buy-${side===1?"YES":"NO"}`);
}

async function stopIx(conn, payer){
  const amm = await ammPda();
  const keys = [{ pubkey: amm, isSigner:false, isWritable:true }];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_STOP) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  return await sendTx(conn, tx, [payer], "stop");
}
async function settleIx(conn, payer, winner){
  const amm = await ammPda();
  const keys = [{ pubkey: amm, isSigner:false, isWritable:true }];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.concat([DISC_SETTLE, u8(winner)]) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  return await sendTx(conn, tx, [payer], `settle-${winner===1?"YES":"NO"}`);
}
async function redeemAllIx(conn, payerA, payerB){
  const amm = await ammPda();
  const users = [payerA, payerB].filter(Boolean);
  for (const u of users){
    const pos = posPda(u.publicKey, amm);
    const keys = [
      { pubkey: amm, isSigner:false, isWritable:true },
      { pubkey: u.publicKey, isSigner:true, isWritable:true },
      { pubkey: pos, isSigner:false, isWritable:true },
    ];
    const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_REDEEM) });
    const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
    await sendTx(conn, tx, [u], `redeem-${u.publicKey.toBase58().slice(0,4)}`);
  }
}

/* ========= HUD Layout ========= */
const ROW = {
  TITLE: 1,
  TUTIL: 2,
  AMM1: 4,
  AMM2: 5,
  AMM3: 6,
  A_POS: 8,
  B_POS: 9,
  TAPE: 11,
  INFO: 13,
  FOOT: 22
};
const COL_L = 2;

function drawFrame(){
  clear();
  put(ROW.TITLE, COL_L, BOLD+REV+"  IBM VT100 HUD  "+RESET+GREEN+"  (space:pause  s:STOP  y/n:SETTLE  d:REDEEM  q:quit)");
}

function drawState(amm, oracle, posA, posB){
  const pYes = lmsrPYes(amm);
  put(ROW.AMM1, COL_L, `AMM  b=${fmtInt(amm.bScaled)}  fee=${amm.feeBps} bps  status=${amm.status}  winner=${amm.winner}`);
  put(ROW.AMM2, COL_L, `     qY=${fmtSH6(amm.qY)} sh   qN=${fmtSH6(amm.qN)} sh   pYes=${pYes.toFixed(6)}  pNo=${(1-pYes).toFixed(6)}`);
  put(ROW.AMM3, COL_L, `     vault=$${fmtUSD6(amm.vault)}   W=${fmtSH6(amm.wTotal)} sh   pps=$${fmtUSD6(amm.pps)}   fees=$${fmtUSD6(amm.fees)}`);
  put(ROW.A_POS, COL_L, `A pos YES=${fmtSH6(posA.yes)} sh   NO=${fmtSH6(posA.no)} sh`);
  put(ROW.B_POS, COL_L, `B pos YES=${fmtSH6(posB.yes)} sh   NO=${fmtSH6(posB.no)} sh`);
  put(ROW.INFO, COL_L, oracle && Number.isFinite(oracle.price) ? `BTC(oracle) $${oracle.price.toFixed(2)}` : `BTC(oracle) n/a`);
}

function lmsrPYes(st){
  const a = Math.exp(st.qY / st.bScaled);
  const c = Math.exp(st.qN / st.bScaled);
  return a / (a+c);
}

/* ========= Modes ========= */
function parseWallets(arg){
  const parts = (arg||"").split(",").map(s=>s.trim()).filter(Boolean);
  if (MODE==="watch"){
    if (parts.length<1) throw new Error("--wallets requires at least 1 wallet for watch");
    return [readKeypair(parts[0]), null];
  } else {
    if (parts.length<2) throw new Error("--wallets requires a.json,b.json");
    return [readKeypair(parts[0]), readKeypair(parts[1])];
  }
}
function readKeypair(p){ return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p,"utf8")))); }

async function ensureFresh(conn, admin, bHuman=500000, feeBps=25){
  try { await closeAmmIx(conn, admin); } catch{}
  await initAmmIx(conn, admin, Math.round(bHuman*1e6), feeBps);
}
async function ensurePos(conn, users){
  for (const u of users){ if(!u) continue; await initPosIx(conn, u); }
}

/* ========= Main ========= */
(async()=>{
  const conn = new Connection(RPC, "processed");
  let [A,B] = parseWallets(WALLETS_ARG);
  const amm  = await ammPda();

  // Keyboard
  process.stdin.setRawMode(true);
  require("readline").emitKeypressEvents(process.stdin);
  let running = true, paused=false, duelDone=false;

  process.stdin.on("keypress", async (str,key)=>{
    if (!key) return;
    if (key.ctrl && key.name==="c") { running=false; cleanup(); }
    if (key.name==="q") { running=false; cleanup(); }
    if (key.name==="space") paused = !paused;
    try {
      if (key.name==="s") await stopIx(conn, A);
      if (key.name==="y") await settleIx(conn, A, 1);
      if (key.name==="n") await settleIx(conn, A, 2);
      if (key.name==="d") await redeemAllIx(conn, A, B);
    } catch(e){
      process.stdout.write(CSI+"999;1H"+RESET+`\n[key] error: ${e?.message || e}\n`+GREEN);
    }
  });

  enter();
  drawFrame();

  // Set up market & positions
  if (MODE==="watch"){
    // do nothing; just paint state
  } else {
    await ensureFresh(conn, A, 500000, 25);
    await ensurePos(conn, [A,B]);
  }

  // Duel counters
  let aYesProb=A_YES_PROB, bNoProb=B_NO_PROB;
  let rounds = 0, spent = {A:{yes:0,no:0}, B:{yes:0,no:0}};

  // Loop
  while(running){
    try {
      const [st, orc, posA, posB] = await Promise.all([
        fetchAmmState(conn, amm),
        fetchOracleBTC(conn),
        fetchPosition(conn, A.publicKey, amm),
        B ? fetchPosition(conn, B.publicKey, amm) : Promise.resolve({yes:0,no:0,pos:null})
      ]);

      drawState(st, orc, posA, posB);

      // MODE actions
      if (MODE==="random-duel" && !paused && !duelDone){
        if (rounds < N){
          // A mostly buys YES
          const aSide = (Math.random()<aYesProb)? 1 : 2;
          const aAmt = rng(MIN_USD, MAX_USD);
          await tradeIx(conn, A, aSide, aAmt);
          if (aSide===1) spent.A.yes+=aAmt; else spent.A.no+=aAmt;

          // B mostly buys NO
          const bSide = (Math.random()<bNoProb)? 2 : 1;
          const bAmt = rng(MIN_USD, MAX_USD);
          await tradeIx(conn, B, bSide, bAmt);
          if (bSide===1) spent.B.yes+=bAmt; else spent.B.no+=bAmt;

          rounds++;
        } else {
          // auto choose winner unless forced
          let win;
          if (FORCE_WIN==="yes") win=1;
          else if (FORCE_WIN==="no") win=2;
          else win = (st.qY>=st.qN)? 1:2;
          await stopIx(conn, A);
          await settleIx(conn, A, win);
          await redeemAllIx(conn, A, B);
          // Print final report line below HUD
          await finalReport(conn, A, B);
          duelDone = true;
        }
      }

      // Always refresh on-chain full state if requested (we already do each loop)
      // FULL_STATE makes no difference here since we fetch every loop,
      // but we keep the flag to satisfy your option requirement / future caching.

      // Footer
      put(ROW.FOOT, COL_L, `mode=${MODE}  rounds=${rounds}/${N}  full-state=${FULL_STATE?"ON":"OFF"}  paused=${paused?"YES":"NO"}   (RPC=${RPC})`);

    } catch(e){
      process.stdout.write(CSI+"999;1H"+RESET+`\n[loop] ${e?.message || e}\n`+GREEN);
    }

    await new Promise(r=>setTimeout(r, CADENCE_MS));
  }

  async function finalReport(conn, A, B){
    const stBefore = await fetchAmmState(conn, amm);
    const vaultBefore = stBefore.vault, W=stBefore.wTotal, pps=stBefore.pps, fees=stBefore.fees, winner=stBefore.winner;

    // positions after redeem
    const posA2 = await fetchPosition(conn, A.publicKey, amm);
    const posB2 = B ? await fetchPosition(conn, B.publicKey, amm) : {yes:0,no:0};
    // get state again (vault after)
    const stAfter = await fetchAmmState(conn, amm);

    process.stdout.write(CSI+"999;1H"+RESET+"\n===== FINAL REPORT =====\n"+GREEN);
    console.log(`Winner: ${winner===1?"YES":"NO"}   W=${fmtSH6(W)} sh   pps=$${fmtUSD6(pps)}   fees=$${fmtUSD6(fees)}`);
    console.log(`Vault before=$${fmtUSD6(vaultBefore)}   Vault after=$${fmtUSD6(stAfter.vault)}   Drop=$${fmtUSD6(vaultBefore-stAfter.vault)}`);
    console.log(`User A spent: YES $${spent.A.yes.toFixed(2)}  NO $${spent.A.no.toFixed(2)}`);
    if (B) console.log(`User B spent: YES $${spent.B.yes.toFixed(2)}  NO $${spent.B.no.toFixed(2)}`);
    console.log(`Positions after redeem: A YES=${fmtSH6(posA2.yes)} NO=${fmtSH6(posA2.no)}  B YES=${fmtSH6(posB2.yes)} NO=${fmtSH6(posB2.no)}`);
    console.log("========================\n");
  }

  function cleanup(){ leave(); process.exit(0); }
})().catch(e=>{ leave(); console.error("Fatal:", e); process.exit(1); });

/* ========= local helpers ========= */
function lmsrPYes(st){
  const a = Math.exp(st.qY / st.bScaled);
  const c = Math.exp(st.qN / st.bScaled);
  return a / (a+c);
}

