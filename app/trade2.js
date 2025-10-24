#!/usr/bin/env node
// app/trade.js — Lean Runner with Color, Exact On-Chain Payouts, Per-User PnL,
// and Multiple Output Modes (simple, jsonl, quiet, audit).
//
// Same CLI you use:
//
// node app/trade.js run --wallets "./userA.json,./userB.json" --steps 12 --mode mixed \
//   --sell-prob 0.30 --sell-frac 0.35 --winner auto --on-closed reinit --reinit-fee-bps 25 --pretty -v
//
// Commands: init, init-pos, buy, sell, stop, settle, redeem, close, run
// Flags:    --pretty, --verbose|-v, --color, --no-color, --force-reinit true|false
// NEW LOG MODES:
//   --simple | -S   -> compact human one-liners per trade (hides tx hashes)
//   --jsonl         -> JSON Lines per trade + events (no colors)
//   --quiet         -> suppress per-trade prints (final tally only)
//   --audit         -> always show tx hashes/logs (overrides simple/quiet)
// You can combine --simple with --jsonl if you want both human + JSONL.
//
// What’s new in accounting (unchanged):
// • Exact per-user PnL via Δ(vault+fees) around each trade and around redeem.
// • Final PASS/FAIL by matching vault drop with sum of on-chain payouts.

const fs = require("fs");
const crypto = require("crypto");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

/* ---------------- CONFIG ---------------- */
const RPC    = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

// === YOUR PROGRAM IDs ===
const PID         = new PublicKey("7h22sUva8ntjjsoa858Qx6Kxg92JoLH8ryiPgGTXm4ja");
const ORACLE_PID  = new PublicKey("7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE"); // not used here
const ORACLE_SEED = Buffer.from("state_v2");
const AMM_SEED    = Buffer.from("amm_btc");
const POS_SEED    = Buffer.from("pos");

/* ---------------- Flags ---------------- */
function hasFlag(name, short){ const a=process.argv; return a.includes(name) || (short && a.includes(short)); }
const VERBOSE = hasFlag("--verbose","-v") || process.env.VERBOSE === "1";
const PRETTY  = hasFlag("--pretty");

const SIMPLE  = hasFlag("--simple","-S");
const JSONL   = hasFlag("--jsonl");
const QUIET   = hasFlag("--quiet");
const AUDIT   = hasFlag("--audit");

/* ---------------- Color helpers ---------------- */
const WANT_COLOR = (!process.env.NO_COLOR && process.stdout.isTTY && !hasFlag("--no-color")) || hasFlag("--color");
const C = (WANT_COLOR && !JSONL) ? {
  r:(s)=>`\x1b[31m${s}\x1b[0m`, g:(s)=>`\x1b[32m${s}\x1b[0m`, y:(s)=>`\x1b[33m${s}\x1b[0m`,
  b:(s)=>`\x1b[34m${s}\x1b[0m`, m:(s)=>`\x1b[35m${s}\x1b[0m`, c:(s)=>`\x1b[36m${s}\x1b[0m`,
  w:(s)=>`\x1b[37m${s}\x1b[0m`, k:(s)=>`\x1b[90m${s}\x1b[0m`, bold:(s)=>`\x1b[1m${s}\x1b[0m`,
  inv:(s)=>`\x1b[7m${s}\x1b[0m`
} : Object.fromEntries(["r","g","y","b","m","c","w","k","bold","inv"].map(k=>[k,(s)=>String(s)]));
const OK  = (WANT_COLOR && !JSONL) ? "✔" : "[PASS]";
const BAD = (WANT_COLOR && !JSONL) ? "✘" : "[FAIL]";

/* ---------------- Utils ---------------- */
function sep(s){ if (PRETTY){ const bar="═".repeat(14); console.log("\n"+C.bold(C.c(`${bar} ${s} ${bar}`))); } }
function fmtScaled(x, dec=6){ return (x/10**dec).toFixed(dec); }
function toScaled(x, dp){ return Math.round(Number(x)*10**dp); }
function readKeypair(p){ return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p,"utf8")))); }
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
function dedupePayers(payers){ const seen=new Set(); const out=[]; for(const p of payers){ const k=p.publicKey.toBase58(); if(!seen.has(k)){ seen.add(k); out.push(p);} } return out; }
const left = (s, n) => (String(s)+" ".repeat(n)).slice(0, n);
const fmtUsdHuman = (x) =>
  (x===undefined||x===null) ? "—" :
  (x>=1e9? `$${(x/1e9).toFixed(2)}B` : x>=1e6? `$${(x/1e6).toFixed(2)}M` : x>=1e3? `$${(x/1e3).toFixed(1)}k` : `$${Number(x).toFixed(2)}`);
const fmtNum = (x,d=3)=> (x===undefined||x===null) ? "—" : Number(x).toFixed(d);

/* ---------------- PDAs + Disc ---------------- */
async function ammPda(){ return PublicKey.findProgramAddressSync([AMM_SEED], PID)[0]; }
function posPda(owner, amm){ return PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), owner.toBuffer()], PID)[0]; }
function oraclePda(){ return PublicKey.findProgramAddressSync([ORACLE_SEED], ORACLE_PID)[0]; } // not used here

function disc(name){ return crypto.createHash("sha256").update("global:"+name).digest().subarray(0,8); }
const D_INIT_AMM = disc("init_amm");
const D_INIT_POS = disc("init_position");
const D_QUOTE    = disc("quote"); // (not used directly; we compute quotes from state)
const D_TRADE    = disc("trade");
const D_STOP     = disc("stop_market");
const D_SETTLE   = disc("settle_market");
const D_REDEEM   = disc("redeem");
const D_CLOSE    = disc("close_amm");

function budgetIxs(units=800_000, microLamports=1){
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

/* ---------------- Send helper (audit-aware) ---------------- */
async function sendTx(conn, tx, signers, label){
  try{
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { skipPreflight:false, commitment:"processed" });
    // Show tx only if VERBOSE and either AUDIT is on OR we're not in quiet/simple
    if (VERBOSE && (AUDIT || (!SIMPLE && !QUIET))) console.log(C.g(`[tx/${label}] ${sig}`));
    return sig;
  }catch(e){
    const logs = e?.getLogs ? await e.getLogs().catch(()=>null) : (e?.simulationResponse?.logs || e?.logs);
    console.error(C.r(`[tx/${label}] FAIL ${e?.message || e}`));
    if (logs) console.error(logs);
    throw e;
  }
}

/* ---------------- AMM state (compact) ---------------- */
function readI64LE(buf, off){ const u=buf.readBigUInt64LE(off); const max=(1n<<63n)-1n; return (u>max)?Number(u-(1n<<64n)):Number(u); }
function readU8(buf, off){ return buf.readUInt8(off); }
function readU16LE(buf, off){ return buf.readUInt16LE(off); }

async function fetchAmmState(conn, amm){
  const info = await conn.getAccountInfo(amm,"processed");
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
  const status   = readU8(p,o);    o+=1; // 0=open, 1=stopped, 2=settled
  const winner   = readU8(p,o);    o+=1; // 0 none, 1 YES, 2 NO
  const wTotal   = readI64LE(p,o); o+=8;
  const pps      = readI64LE(p,o); o+=8;
  return { bump, decimals, bScaled, feeBps, qY, qN, fees, vault, status, winner, wTotal, pps };
}

function quotesFromState(st){
  const b = st.bScaled;
  const a = Math.exp(st.qY / b);
  const c = Math.exp(st.qN / b);
  const yes = a/(a+c);
  const no  = 1-yes;
  return { yes, no };
}

async function logState(conn, label){
  if (!VERBOSE) return;
  const st = await fetchAmmState(conn, await ammPda());
  const d = st.decimals;
  console.log(
    `${C.k(`[state/${label}]`)} `
    + `qY=${C.y(fmtScaled(st.qY,d))}sh `
    + `qN=${C.y(fmtScaled(st.qN,d))}sh `
    + `vault=$${C.c(C.bold(fmtScaled(st.vault,d)))} `
    + `fees=$${C.c(fmtScaled(st.fees,d))} `
    + `pps=$${C.c(fmtScaled(st.pps,d))} `
    + `W=${C.m(fmtScaled(st.wTotal,d))} `
    + `status=${st.status} winner=${st.winner}`
  );
}

async function marketStatus(conn){
  try { const st = await fetchAmmState(conn, await ammPda()); return { exists:true, status:st.status, st }; }
  catch(_){ return { exists:false, status:-1, st:null }; }
}

/* ---------------- ixs ---------------- */
function u8(n){ const b=Buffer.alloc(1); b.writeUInt8(n); return b; }
function u16le(n){ const b=Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function i64le(n){ let x=BigInt(n); if (x<0n) x=(1n<<64n)+x; const b=Buffer.alloc(8); b.writeBigUInt64LE(x); return b; }

async function ixInitAmm(conn, payer, bHuman=500000, feeBps=25){
  const amm = await ammPda();
  const data = Buffer.concat([D_INIT_AMM, i64le(toScaled(bHuman,6)), u16le(feeBps)]);
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  const tx = new Transaction().add(...budgetIxs(), new TransactionInstruction({ programId: PID, keys, data }));
  await sendTx(conn, tx, [payer], "init"); await logState(conn, "after init");
}
async function ixInitPos(conn, payer){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const info = await conn.getAccountInfo(pos,"processed");
  if (info) { if (VERBOSE && (AUDIT || (!SIMPLE && !QUIET))) console.log(C.k(`[pos] exists ${pos.toBase58()}`)); return; }
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:false },
    { pubkey: pos, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  const tx = new Transaction().add(...budgetIxs(200_000,0), new TransactionInstruction({ programId: PID, keys, data: Buffer.from(D_INIT_POS) }));
  await sendTx(conn, tx, [payer], "init-pos");
}
async function ixTrade(conn, payer, side /*1 yes 2 no*/, action /*1 buy 2 sell*/, amountScaled){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const data = Buffer.concat([D_TRADE, u8(side), u8(action), i64le(amountScaled)]);
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: pos, isSigner:false, isWritable:true },
  ];
  const tx = new Transaction().add(...budgetIxs(), new TransactionInstruction({ programId: PID, keys, data }));
  await sendTx(conn, tx, [payer], `${action===1?"buy":"sell"}-${side===1?"YES":"NO"}`);
  await logState(conn, `after ${action===1?"buy":"sell"} ${side===1?"YES":"NO"}`);
}
async function ixStop(conn, payer){
  const amm = await ammPda();
  const tx = new Transaction().add(...budgetIxs(200_000,0), new TransactionInstruction({
    programId: PID, keys:[{pubkey:amm,isSigner:false,isWritable:true}], data: Buffer.from(D_STOP)
  }));
  await sendTx(conn, tx, [payer], "stop");
}
async function ixSettle(conn, payer, winner /*1 yes 2 no*/){
  const amm = await ammPda();
  const tx = new Transaction().add(...budgetIxs(200_000,0), new TransactionInstruction({
    programId: PID, keys:[{pubkey:amm,isSigner:false,isWritable:true}], data: Buffer.concat([D_SETTLE, u8(winner)])
  }));
  await sendTx(conn, tx, [payer], `settle-${winner===1?"YES":"NO"}`);
}
async function ixRedeem(conn, payer){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const tx = new Transaction().add(...budgetIxs(200_000,0), new TransactionInstruction({
    programId: PID, keys:[
      { pubkey: amm, isSigner:false, isWritable:true },
      { pubkey: payer.publicKey, isSigner:true, isWritable:true },
      { pubkey: pos, isSigner:false, isWritable:true },
    ], data: Buffer.from(D_REDEEM)
  }));
  await sendTx(conn, tx, [payer], "redeem");
}
async function ixClose(conn, payer){
  const amm = await ammPda();
  const info = await conn.getAccountInfo(amm,"processed");
  if (!info) { if (VERBOSE && (AUDIT || (!SIMPLE && !QUIET))) console.log(C.k("[close] AMM not found")); return; }
  const tx = new Transaction().add(...budgetIxs(200_000,0), new TransactionInstruction({
    programId: PID, keys:[
      { pubkey: amm, isSigner:false, isWritable:true },
      { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    ], data: Buffer.from(D_CLOSE)
  }));
  await sendTx(conn, tx, [payer], "close");
}

/* ---------------- RUN LOOP ---------------- */
function parseRunFlags(argv){
  const out = {
    mode: "mixed", steps: 600, cadence: 250,
    minUsd: 5, maxUsd: 200,
    aYesProb: 0.58, bNoProb: 0.62,
    sellProb: 0.35, sellFrac: 0.33,
    winner: "auto", onClosed: "skip", reinitFeeBps: 25, forceReinit: "false",
  };
  for (let i=0;i<argv.length;i++){
    const k=argv[i];
    if (k==="--mode") out.mode = String(argv[++i]||"mixed").toLowerCase();
    else if (k==="--steps") out.steps = Math.max(1, parseInt(argv[++i]||"600",10));
    else if (k==="--cadence") out.cadence = Math.max(50, parseInt(argv[++i]||"250",10));
    else if (k==="--min-usd") out.minUsd = Math.max(1, parseFloat(argv[++i]||"5"));
    else if (k==="--max-usd") out.maxUsd = Math.max(out.minUsd, parseFloat(argv[++i]||"200"));
    else if (k==="--a-yes-prob") out.aYesProb = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.58")));
    else if (k==="--b-no-prob")  out.bNoProb  = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.62")));
    else if (k==="--sell-prob")  out.sellProb = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.35")));
    else if (k==="--sell-frac")  out.sellFrac = Math.max(0.01, Math.min(1, parseFloat(argv[++i]||"0.33")));
    else if (k==="--winner")     out.winner   = String(argv[++i]||"auto").toLowerCase();
    else if (k==="--on-closed")  out.onClosed = String(argv[++i]||"skip").toLowerCase();
    else if (k==="--reinit-fee-bps") out.reinitFeeBps = parseInt(argv[++i]||"25",10);
    else if (k==="--force-reinit")   out.forceReinit = String(argv[++i]||"false");
  }
  return out;
}

function chooseSide(mode, price, biasA, biasB, who){
  if (mode==="trend")      return Math.random() < (price>=0.5?0.65:0.35) ? 1:2;
  if (mode==="meanrevert") return Math.random() < (price>=0.5?0.35:0.65) ? 1:2;
  if (mode==="random")     return Math.random()<0.5?1:2;
  return (who==="A") ? (Math.random()<biasA?1:2) : (Math.random()<(1-biasB)?1:2);
}

async function ensureOpenMarket(conn, admin, payersUniq, opts){
  const ms = await marketStatus(conn);
  const force = String(opts.forceReinit||"").toLowerCase()==="true";
  if (!ms.exists){
    await ixInitAmm(conn, admin, 500000, opts.reinitFeeBps);
  } else if (force){
    try { await ixClose(conn, admin); } catch(_){}
    await ixInitAmm(conn, admin, 500000, opts.reinitFeeBps);
  } else if (ms.status !== 0 && opts.onClosed === "reinit"){
    try { await ixClose(conn, admin); } catch(_){}
    await ixInitAmm(conn, admin, 500000, opts.reinitFeeBps);
  }
  for (const p of payersUniq) await ixInitPos(conn, p);
}

async function readUserPos(conn, ownerPk){
  const amm = await ammPda();
  const pos = posPda(ownerPk, amm);
  const info = await conn.getAccountInfo(pos,"processed");
  let yes=0, no=0;
  if (info && info.data && info.data.length>=8+32+8+8){
    const p = info.data.subarray(8); let o=0; o+=32;
    yes = Number(p.readBigInt64LE(o)); o+=8;
    no  = Number(p.readBigInt64LE(o)); o+=8;
    yes = Math.max(0,yes); no = Math.max(0,no);
  }
  return { yes, no };
}

// Convenience to read (vault + fees) in one call
async function readVF(conn){
  const st = await fetchAmmState(conn, await ammPda());
  return { v: st.vault, f: st.fees, dec: st.decimals };
}

/* ---------------- Logging helpers (modes) ---------------- */
function printJSONL(obj){
  if (!JSONL) return;
  try { process.stdout.write(JSON.stringify(obj)+"\n"); } catch(_){}
}

function logSimpleTradeLine({
  step, user, side, action, amountScaled, decimals,
  quotesYes, quotesNo, vaultScaled, invYesScaled, invNoScaled, feesScaled
}){
  if (QUIET) return;
  if (!SIMPLE) return;

  const sStep = step != null ? String(step).padStart(3, "0") : "—";
  const who   = left(user || "—", 6);
  const act   = left((action===1?"BUY":"SELL"), 4);
  const out   = left((side===1?"YES":"NO"), 3);

  const amountHuman = fmtScaled(amountScaled, decimals);
  const vaultHuman  = Number(fmtScaled(vaultScaled, decimals));
  const invY  = Number(fmtScaled(invYesScaled, decimals)).toLocaleString();
  const invN  = Number(fmtScaled(invNoScaled , decimals)).toLocaleString();
  const feesH = Number(fmtScaled(feesScaled,  decimals));

  console.log(
    `[${sStep}] ${who} ${act} ${out} ${amountHuman} ` +
    `| Q YES ${fmtNum(quotesYes,3)} NO ${fmtNum(quotesNo,3)} ` +
    `| Vault ${fmtUsdHuman(vaultHuman)} ` +
    `| Inv Y/N ${invY} / ${invN} ` +
    `| Fees $${fmtNum(feesH,decimals)}`
  );
}

function logEventSimple(kind, payload = {}){
  if (QUIET) return;
  if (!SIMPLE) return;
  if (kind === "resolve") {
    const { winner, vaultBeforeScaled, vaultAfterScaled, sumPayoutScaled, feesScaled, decimals } = payload;
    console.log(
      `[#] RESOLVE winner=${(winner||"—").toUpperCase()} | ` +
      `Vault $${fmtScaled(vaultBeforeScaled,decimals)} → $${fmtScaled(vaultAfterScaled,decimals)} ` +
      (sumPayoutScaled!=null ? `| Payouts $${fmtScaled(sumPayoutScaled,decimals)} ` : "") +
      (feesScaled!=null ? `| Fees $${fmtScaled(feesScaled,decimals)}` : "")
    );
  } else if (kind === "reinit") {
    const { feeBps, newBHuman, resetInvYes, resetInvNo, vaultScaled, decimals } = payload;
    console.log(
      `[#] REINIT b=${newBHuman ?? "—"} fee=${feeBps ?? "—"}bps | ` +
      `Vault $${fmtScaled(vaultScaled,decimals)} | Inv Y/N ${resetInvYes ?? "—"} / ${resetInvNo ?? "—"}`
    );
  }
}

/* Core trading step with accounting + mode-aware logging */
async function tradeWithAccounting(conn, payer, whoLabel, stepNo, side, action, amountScaled, ledger){
  const amm = await ammPda();

  // BEFORE snapshot
  const stBefore = await fetchAmmState(conn, amm);
  const vfBefore = { v: stBefore.vault, f: stBefore.fees };
  const dec = stBefore.decimals;

  // Execute
  await ixTrade(conn, payer, side, action, amountScaled);

  // AFTER snapshot
  const stAfter = await fetchAmmState(conn, amm);
  const vfAfter = { v: stAfter.vault, f: stAfter.fees };

  // Accounting (scaled)
  const delta = (vfAfter.v + vfAfter.f) - (vfBefore.v + vfBefore.f);
  const k = payer.publicKey.toBase58();
  if (!ledger[k]) ledger[k] = { spent:0, received:0 };
  if (delta > 0) ledger[k].spent    += delta;     // user paid in
  else if (delta < 0) ledger[k].received += (-delta); // user received

  // Mode prints
  const q = quotesFromState(stAfter);

  logSimpleTradeLine({
    step: stepNo,
    user: whoLabel,
    side, action,
    amountScaled,
    decimals: dec,
    quotesYes: q.yes, quotesNo: q.no,
    vaultScaled: stAfter.vault,
    invYesScaled: stAfter.qY,
    invNoScaled:  stAfter.qN,
    feesScaled:   stAfter.fees
  });

  printJSONL({
    type: "trade",
    step: stepNo,
    user: whoLabel,
    side: (side===1?"YES":"NO"),
    action: (action===1?"BUY":"SELL"),
    amount_scaled: amountScaled,
    decimals: dec,
    quotes: { yes: q.yes, no: q.no },
    vault_scaled: stAfter.vault,
    inv_scaled: { yes: stAfter.qY, no: stAfter.qN },
    fees_scaled: stAfter.fees,
    ts: Date.now()
  });
}

async function runLoop(conn, payers, opts){
  const [A,B] = payers;
  const uniq = dedupePayers([A,B]);
  await ensureOpenMarket(conn, A, uniq, opts);

  // Per-user cashflow ledger (scaled ints)
  const ledger = {}; // key: base58, val: {spent, received}

  for (let i=1;i<=opts.steps;i++){
    // Use last quote to bias next decision
    const st = await fetchAmmState(conn, await ammPda());
    const price = quotesFromState(st).yes;

    // A
    if (Math.random() < opts.sellProb) {
      const pA = await readUserPos(conn, A.publicKey);
      const sideA = (pA.yes>0 && pA.no>0)?(Math.random()<0.5?1:2):(pA.yes>0?1:(pA.no>0?2:(price>0.5?1:2)));
      const inv  = sideA===1 ? pA.yes : pA.no;
      if (inv>0){ const sh = Math.max(1, Math.floor(inv*opts.sellFrac)); await tradeWithAccounting(conn, A, "UserA", i, sideA, 2, sh, ledger); }
    } else {
      const sideA = chooseSide(opts.mode, price, opts.aYesProb, opts.bNoProb, "A");
      const usd   = Math.max(opts.minUsd, Math.random()*(opts.maxUsd-opts.minUsd)+opts.minUsd);
      await tradeWithAccounting(conn, A, "UserA", i, sideA, 1, toScaled(usd, st.decimals), ledger);
    }

    await sleep(opts.cadence);

    // B
    const st2 = await fetchAmmState(conn, await ammPda());
    const price2 = quotesFromState(st2).yes;
    if (Math.random() < opts.sellProb) {
      const pB = await readUserPos(conn, B.publicKey);
      const sideB = (pB.yes>0 && pB.no>0)?(Math.random()<0.5?1:2):(pB.yes>0?1:(pB.no>0?2:(price2<0.5?2:1)));
      const inv  = sideB===1 ? pB.yes : pB.no;
      if (inv>0){ const sh = Math.max(1, Math.floor(inv*opts.sellFrac)); await tradeWithAccounting(conn, B, "UserB", i, sideB, 2, sh, ledger); }
    } else {
      const sideB = chooseSide(opts.mode, price2, opts.aYesProb, opts.bNoProb, "B");
      const usd   = Math.max(opts.minUsd, Math.random()*(opts.maxUsd-opts.minUsd)+opts.minUsd);
      await tradeWithAccounting(conn, B, "UserB", i, sideB, 1, toScaled(usd, st2.decimals), ledger);
    }

    if (VERBOSE && i%50===0) await logState(conn, `after step ${i}`);
  }

  // pick & settle
  const st = await fetchAmmState(conn, await ammPda());
  const winner = (opts.winner==="yes")?1:(opts.winner==="no")?2: (st.qY>=st.qN?1:2);

  sep(`STOP & SETTLE (${winner===1?C.g("YES"):C.y("NO")})`);
  await ixStop(conn, A);
  await ixSettle(conn, A, winner);

  // snapshot after settle
  const stSet = await fetchAmmState(conn, await ammPda());
  const dec = stSet.decimals;

  logEventSimple("resolve", {
    winner: (winner===1?"YES":"NO"),
    vaultBeforeScaled: st.vault,
    vaultAfterScaled: stSet.vault,
    sumPayoutScaled: null,
    feesScaled: stSet.fees,
    decimals: dec
  });
  printJSONL({
    type: "event", name: "resolve",
    winner: (winner===1?"YES":"NO"),
    vault_before_scaled: st.vault,
    vault_after_scaled: stSet.vault,
    fees_scaled: stSet.fees, decimals: dec, ts: Date.now()
  });

  sep(C.bold("REDEEM ALL"));

  // Measure-the-drop accounting: payout = vault_before - vault_after per redeem
  const paidRows = [];                // { tag, paid (scaled), win }
  const tagOf = (p)=>p.publicKey.toBase58().slice(0,4);
  let vaultCursor = stSet.vault;

  for (const p of uniq){
    const tag = tagOf(p);
    const { yes, no } = await readUserPos(conn, p.publicKey);
    const win = winner===1 ? yes : no;

    if (win > 0) {
      await ixRedeem(conn, p);
      await sleep(60);
      const now = await fetchAmmState(conn, await ammPda());
      const paid = vaultCursor - now.vault;      // exact on-chain payout (scaled)
      vaultCursor = now.vault;
      paidRows.push({ tag, paid, win });
      printJSONL({ type:"redeem", tag, win_scaled: win, paid_scaled: paid, decimals: dec, ts: Date.now() });
    } else {
      paidRows.push({ tag, paid: 0, win: 0 });
      printJSONL({ type:"redeem", tag, win_scaled: 0, paid_scaled: 0, decimals: dec, ts: Date.now() });
    }
  }

  const after = await fetchAmmState(conn, await ammPda());
  const vaultDrop = stSet.vault - after.vault;
  const onChainSum = paidRows.reduce((a,r)=>a + r.paid, 0);

  sep(C.bold("FINAL TALLY"));
  console.log(`Winner: ${C.bold(winner===1?C.g("YES"):C.y("NO"))}`);
  console.log(`W (winning shares): ${C.m(fmtScaled(stSet.wTotal, dec))} ${C.k("sh")}`);
  console.log(`pps: $${C.c(C.bold(fmtScaled(stSet.pps, dec)))}`);
  console.log(
    `Vault before: $${C.c(fmtScaled(stSet.vault, dec))}   `
  + `Vault after: $${C.c(fmtScaled(after.vault, dec))}   `
  + `Drop: $${C.c(C.bold(fmtScaled(vaultDrop, dec)))}`
  );
  console.log(`Fees accrued: $${C.k(fmtScaled(stSet.fees, dec))}`);

  // Per-user PnL from measured trade cashflows and measured payout
  const byTag = {};
  for (const p of uniq){
    const k = p.publicKey.toBase58();
    const tag = k.slice(0,4);
    const flows = ledger[k] || { spent:0, received:0 };
    byTag[tag] = {
      spent: flows.spent,
      received: flows.received,
      net: flows.spent - flows.received,
      payout: 0,
      win: 0
    };
  }
  for (const r of paidRows){
    if (!byTag[r.tag]) byTag[r.tag] = { spent:0, received:0, net:0, payout:0, win:0 };
    byTag[r.tag].payout = r.paid;
    byTag[r.tag].win    = r.win;
  }

  for (const tag of Object.keys(byTag).sort()){
    const u = byTag[tag];
    const pnl = u.payout - u.net;
    console.log(
      `User ${C.bold(tag)} `
    + `winning_sh=${C.y(fmtScaled(u.win,dec))} ${C.k("sh")}   `
    + `spent=$${C.c(fmtScaled(u.spent,dec))}  `
    + `received=$${C.c(fmtScaled(u.received,dec))}  `
    + `net=$${C.m(fmtScaled(u.net,dec))}   `
    + `payout=$${C.g(C.bold(fmtScaled(u.payout,dec)))}   `
    + `PNL=${(pnl>=0?C.g:C.r)(C.bold("$"+fmtScaled(pnl,dec)))}`
    );
  }

  console.log(`On-chain sum payouts: $${C.g(fmtScaled(onChainSum, dec))}`);
  console.log(`Actual drop:          $${C.g(fmtScaled(vaultDrop, dec))}`);

  printJSONL({
    type:"final",
    winner: (winner===1?"YES":"NO"),
    onchain_sum_payouts_scaled: onChainSum,
    actual_vault_drop_scaled: vaultDrop,
    equal: (vaultDrop === onChainSum),
    decimals: dec,
    users: Object.fromEntries(Object.entries(byTag).map(([tag,u])=>[
      tag, { win_scaled:u.win, spent_scaled:u.spent, received_scaled:u.received, net_scaled:u.net, payout_scaled:u.payout }
    ])),
    ts: Date.now()
  });

  if (vaultDrop !== onChainSum) {
    const banner = C.bold(C.inv(C.r("   FAIL   ")));
    console.error(`${banner} ${BAD} vault drop != on-chain sum payouts`, {
      vault_before: stSet.vault, vault_after: after.vault,
      vaultDrop, onChainSum, diff: vaultDrop - onChainSum
    });
    return { ok:false };
  } else {
    const banner = C.bold(C.inv(C.g("   PASS   ")));
    console.log(`${banner} ${OK} vault drop equals on-chain sum payouts`);
  }

  return { ok:true };
}

/* ---------------- CLI ---------------- */
function parseWallets(argv){
  const i = argv.indexOf("--wallets");
  const s = i>=0 ? argv[i+1] : (process.env.TEST_WALLETS || "");
  return s ? s.split(",").map(x=>x.trim().replace(/^"(.*)"$/,'$1')).filter(Boolean) : [];
}

(async ()=>{
  const conn  = new Connection(RPC, "processed");
  const payer = readKeypair(WALLET);
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd==="help" || cmd==="--help" || cmd==="-h"){
    console.log(`Usage:
  node app/trade.js init [bShares] [feeBps]
  node app/trade.js init-pos
  node app/trade.js buy  yes|no <USD>
  node app/trade.js sell yes|no <SHARES>
  node app/trade.js stop
  node app/trade.js settle yes|no
  node app/trade.js redeem
  node app/trade.js close
  node app/trade.js run  --wallets a.json,b.json [--mode random|trend|meanrevert|mixed] [--steps 600] \\
                         [--cadence 250] [--min-usd 5] [--max-usd 200] [--a-yes-prob 0.58] [--b-no-prob 0.62] \\
                         [--sell-prob 0.35] [--sell-frac 0.33] [--winner auto|yes|no] [--on-closed skip|reinit] [--reinit-fee-bps 25] \\
                         [--force-reinit true|false] [--color|--no-color] [--simple|-S] [--jsonl] [--quiet] [--audit]
Flags: --pretty, --verbose|-v`);
    process.exit(0);
  }

  try{
    if (cmd==="init"){ const b=parseFloat(rest[0]||"500000"); const f=parseInt(rest[1]||"25",10); await ixInitAmm(conn, payer, b, f); return; }
    if (cmd==="init-pos"){ await ixInitPos(conn, payer); return; }
    if (cmd==="stop"){ await ixStop(conn, payer); return; }
    if (cmd==="settle"){ const w=(rest[0]||"").toLowerCase()==="yes"?1:2; await ixSettle(conn, payer, w); return; }
    if (cmd==="redeem"){ await ixRedeem(conn, payer); return; }
    if (cmd==="close"){ await ixClose(conn, payer); return; }
    if (cmd==="buy"||cmd==="sell"){
      const side = (rest[0]||"").toLowerCase()==="yes"?1:2;
      const amt  = parseFloat(rest[1]||"0"); if (!(amt>0)){ console.error("Missing/invalid amount"); process.exit(1); }
      const st   = await fetchAmmState(conn, await ammPda());
      const action = cmd==="buy"?1:2;
      await ixTrade(conn, payer, side, action, toScaled(amt, st.decimals)); return;
    }

    if (cmd==="run"){
      const wallets = parseWallets(rest);
      let payers = [];
      if (wallets.length>=2){ payers = [ readKeypair(wallets[0]), readKeypair(wallets[1]) ]; }
      else { console.warn(C.k("run: --wallets not provided or <2; using single wallet twice")); payers = [payer, payer]; }
      for (const p of dedupePayers(payers)) await ixInitPos(conn, p); // safe no-op if exists
      const opts = parseRunFlags(rest);
      await runLoop(conn, payers, opts);
      return;
    }

    console.error("Unknown command. Use --help");
    process.exit(1);
  }catch(e){
    process.exit(1);
  }
})();

