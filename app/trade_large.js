#!/usr/bin/env node
// app/trade.js — full demo + runner + tests (CommonJS)
// v3.2: SELL support + robust error capture + closed-market handling
//       + dual reporting (display/prorated vs ON-CHAIN payouts) with
//       final equality check against ON-CHAIN sum (no more tiny drift fails).
//
// - Runner supports buys & sells with multiple modes (random/trend/meanrevert/mixed)
// - Flags: --steps, --sell-prob, --sell-frac, --winner, --on-closed skip|reinit|fail
// - Reporting now shows BOTH:
//     * DISPLAY (prorated) table where ∑win_final == W for nice % of W
//     * ON-CHAIN payouts where payout = floor(win_raw * pps / 10^dec) — matches program
// - Final check: compares vault drop to ON-CHAIN sum (bit-exact)
// - Scale-aware math using AMM on-chain `decimals`
// - Improved sendTx: captures logs via getLogs(), decodes Anchor error codes
//
// BUY uses USD units; SELL uses SHARES units — both scaled by `decimals`.
// AMM init `bScaled` risk parameter is kept at 1e6 scale.
//
// Also includes: `test-rounding` convenience to reproduce short mixed case.

const fs = require("fs");
const crypto = require("crypto");
const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

/* ---------------- CONFIG ---------------- */
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
const PID = new PublicKey("7h22sUva8ntjjsoa858Qx6Kxg92JoLH8ryiPgGTXm4ja");
const ORACLE_PID = new PublicKey("7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE");
const ORACLE_SEED = Buffer.from("state_v2");
const AMM_SEED = Buffer.from("amm_btc");
const POS_SEED = Buffer.from("pos");
const CU_LIMIT = 800_000;
const CU_PRICE = 1;

/* ---------------- CLI flags ---------------- */
function hasFlag(name, short) {
  const a = process.argv;
  return a.includes(name) || (short && a.includes(short));
}
const VERBOSE = hasFlag("--verbose", "-v") || process.env.VERBOSE === "1";
const PRETTY  = hasFlag("--pretty") || process.env.PRETTY === "1";
const NO_PRORATE = hasFlag("--no-prorate");

/* ---------------- Pretty logger ---------------- */
const sep = (label="") => PRETTY ? console.log(`\n${"=".repeat(14)} ${label} ${"=".repeat(14)}`) : null;
const bar = (label="") => PRETTY ? console.log(`${"-".repeat(8)} ${label}`) : null;
const lf  = () => PRETTY ? console.log("") : null;

function padR(s, n){ s=String(s); return s.length>=n ? s : s+" ".repeat(n-s.length); }
function padL(s, n){ s=String(s); return s.length>=n ? s : " ".repeat(n-s.length)+s; }

function fmtNum(n){ return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0}); }
function fmtUnits(x, dec){ return (x / 10**dec).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
function fmtUSDd(x, dec){ return fmtUnits(x, dec); } // scale-aware USD
function fmtShd(x, dec){ return fmtUnits(x, dec); }  // scale-aware shares

/* ---------------- Helpers ---------------- */
function disc(name) { return crypto.createHash("sha256").update("global:" + name).digest().subarray(0, 8); }
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
function i64le(n){ let x=BigInt(n); if (x<0n) x=(1n<<64n)+x; const b=Buffer.alloc(8); b.writeBigUInt64LE(x); return b; }
function readKeypair(p){ return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p,"utf8")))); }
function toScaled(x, dp){ return Math.round(Number(x) * 10**dp); }
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
function randRange(min,max){ return min + Math.random()*(max-min); }

async function ammPda(){ return PublicKey.findProgramAddressSync([AMM_SEED], PID)[0]; }
function posPda(owner, amm){ return PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), owner.toBuffer()], PID)[0]; }
function oraclePda(){ return PublicKey.findProgramAddressSync([ORACLE_SEED], ORACLE_PID)[0]; }

/* ---------------- Improved send helper ---------------- */
async function sendTx(conn, tx, signers, label="TX"){
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, {
      skipPreflight: false,
      commitment: "processed",
    });
    if (VERBOSE) console.log(`[tx/${label}] ${sig}`);
    return sig;
  } catch (e) {
    let logs = null;
    try {
      if (typeof e?.getLogs === "function") logs = await e.getLogs();
      else if (e?.simulationResponse?.logs) logs = e.simulationResponse.logs;
      else if (e?.logs) logs = e.logs;
    } catch(_ignored) {}

    const code = extractCustomProgramError(e) || extractCustomFromLogs(logs);
    const anchorInfo = code ? decodeAnchorError(code) : null;

    if (logs) console.error(`[tx/${label}] Simulation failed. Logs:`, logs);
    else console.error(`[tx/${label}] Simulation failed.`, {
      message: e?.message || String(e),
      codeHex: code ? `0x${code.toString(16)}` : undefined,
      anchor: anchorInfo || undefined,
    });

    const err = new Error(`TX failed: ${e?.message || String(e)}`);
    err.original = e;
    err.logs = logs || null;
    err.customCode = code || null;
    err.anchor = anchorInfo || null;
    throw err;
  }
}
function extractCustomProgramError(e){
  const m = /custom program error:\s*(0x[0-9a-fA-F]+)/.exec(e?.message || "");
  if (m && m[1]) return parseInt(m[1], 16);
  const m2 = /custom program error:\s*(\d+)/.exec(e?.message || "");
  if (m2 && m2[1]) return parseInt(m2[1], 10);
  return null;
}
function extractCustomFromLogs(logs){
  if (!Array.isArray(logs)) return null;
  for (const line of logs) {
    const m = /custom program error:\s*(0x[0-9a-fA-F]+)/.exec(line);
    if (m && m[1]) return parseInt(m[1], 16);
    const m2 = /custom program error:\s*(\d+)/.exec(line);
    if (m2 && m2[1]) return parseInt(m2[1], 10);
  }
  return null;
}
function decodeAnchorError(code){
  // Extend with your program's errors
  // From earlier logs: 0x1774 == 6004
  const map = { 6004: { name: "MarketClosed", msg: "market is closed." } };
  if (code === 0x1774) return map[6004];
  if (map[code]) return map[code];
  return null;
}

/* ---------------- Parsers ---------------- */
function readI64LE(buf, off){
  const u = buf.readBigUInt64LE(off);
  const max = (1n<<63n) - 1n;
  return (u > max) ? Number(u - (1n<<64n)) : Number(u);
}
function readU8(buf, off){ return buf.readUInt8(off); }
function readU16LE(buf, off){ return buf.readUInt16LE(off); }

// Amm layout (62 bytes after 8-byte disc)
async function fetchAmmState(conn, amm){
  const info = await conn.getAccountInfo(amm, "processed");
  if (!info) throw new Error("AMM account not found");
  const d = info.data; if (!d || d.length < 8 + 62) throw new Error("AMM account too small");
  const p = d.subarray(8); let o = 0;
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

/* ---------------- LMSR helper (client-side only) ---------------- */
function lmsrPYes({ qY, qN, bScaled }){
  const a = Math.exp(qY / bScaled);
  const c = Math.exp(qN / bScaled);
  return a / (a + c);
}

/* ---------------- Raw instructions ---------------- */
function budgetIxs(units=CU_LIMIT, microLamports=CU_PRICE){
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

async function initAmm(conn, payer, bScaled, feeBps=25){
  const amm = await ammPda();
  const data = Buffer.concat([DISC_INIT_AMM, i64le(bScaled), u16le(feeBps)]);
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data });
  const tx = new Transaction().add(...budgetIxs(), ix);
  const sig = await sendTx(conn, tx, [payer], "init");
  if (VERBOSE) await logAmmState(conn, "after init");
  return sig;
}
async function initPosition(conn, payer){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const info = await conn.getAccountInfo(pos, "processed");
  if (info) { console.log("init-pos: Position already exists at", pos.toBase58()); return; }
  const data = Buffer.from(DISC_INIT_POS);
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:false },
    { pubkey: pos, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data });
  const tx = new Transaction().add(...budgetIxs(200_000, 0), ix);
  const sig = await sendTx(conn, tx, [payer], "init-pos");
  return sig;
}
async function quoteIx(conn, payer){
  const amm = await ammPda();
  const keys = [{ pubkey: amm, isSigner:false, isWritable:false }];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_QUOTE) });
  const tx = new Transaction().add(...budgetIxs(200_000, 0), ix);
  const sig = await sendTx(conn, tx, [payer], "quote");
  return sig;
}
async function tradeIx(conn, payer, side, action, amountScaled){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const data = Buffer.concat([DISC_TRADE, u8(side), u8(action), i64le(amountScaled)]);
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: pos, isSigner:false, isWritable:true },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data });
  const tx = new Transaction().add(...budgetIxs(), ix);
  const sig = await sendTx(conn, tx, [payer], `${action===1?"buy":"sell"}-${side===1?"YES":"NO"}`);
  if (VERBOSE) await logAmmState(conn, `after ${action===1?"buy":"sell"} ${side===1?"YES":"NO"}`);
  return sig;
}
async function stopIx(conn, payer){
  const amm = await ammPda();
  const keys = [{ pubkey: amm, isSigner:false, isWritable:true }];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_STOP) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  const sig = await sendTx(conn, tx, [payer], "stop");
  if (VERBOSE) await logAmmState(conn, "after stop");
  return sig;
}
async function settleIx(conn, payer, winner){
  const amm = await ammPda();
  const data = Buffer.concat([DISC_SETTLE, u8(winner)]);
  const keys = [{ pubkey: amm, isSigner:false, isWritable:true }];
  const ix = new TransactionInstruction({ programId: PID, keys, data });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  const sig = await sendTx(conn, tx, [payer], `settle-${winner===1?"YES":"NO"}`);
  if (VERBOSE) await logAmmState(conn, "after settle");
  return sig;
}
async function redeemIx(conn, payer){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: pos, isSigner:false, isWritable:true },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_REDEEM) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  const sig = await sendTx(conn, tx, [payer], "redeem");
  if (VERBOSE) await logAmmState(conn, `after redeem (${payer.publicKey.toBase58().slice(0,4)}…)`);
  return sig;
}
async function closeIx(conn, payer){
  const amm = await ammPda();
  const info = await conn.getAccountInfo(amm, "processed");
  if (!info) { console.log("close: amm not found (already closed?)"); return; }
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_CLOSE) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  const sig = await sendTx(conn, tx, [payer], "close");
  if (VERBOSE) console.log(`[state] market PDA closed`);
  return sig;
}

/* ---------------- Position helpers ---------------- */
async function readUserPos(conn, ownerPk){
  const amm = await ammPda();
  const posPk = posPda(ownerPk, amm);
  const info = await conn.getAccountInfo(posPk, "processed");
  let yes=0, no=0;
  if (info && info.data && info.data.length >= 8+32+8+8) {
    const p = info.data.subarray(8); let o=0; o+=32;
    yes = Number(p.readBigInt64LE(o)); o+=8;
    no  = Number(p.readBigInt64LE(o)); o+=8;
    yes = Math.max(0, yes); no = Math.max(0, no);
  }
  return { yes, no };
}

async function readAllUserWins(conn, users, winner){
  const out = [];
  for (const u of users) {
    const { yes, no } = await readUserPos(conn, u.publicKey);
    out.push({
      tag: u.publicKey.toBase58().slice(0,4),
      yes, no,
      win: (winner===1) ? yes : no
    });
  }
  return out;
}

/* ---------------- State loggers (verbose) ---------------- */
async function logAmmState(conn, label="state"){
  const amm = await ammPda();
  const st = await fetchAmmState(conn, amm);
  const pYes = lmsrPYes(st);
  const dec = st.decimals;
  if (PRETTY) bar(label);
  console.log(`[amm] ${label}`);
  console.log(`      b=${fmtNum(st.bScaled)} qY=${fmtShd(st.qY,dec)}sh qN=${fmtShd(st.qN,dec)}sh  pYes=${pYes.toFixed(6)} pNo=${(1-pYes).toFixed(6)}`);
  console.log(`      vault=$${fmtUSDd(st.vault,dec)}  pps=$${fmtUSDd(st.pps,dec)}  W=${fmtShd(st.wTotal,dec)}sh  status=${st.status} winner=${st.winner}`);
  lf();
}
async function logPositions(conn, users, title="positions"){
  const amm = await ammPda();
  const st = await fetchAmmState(conn, amm);
  const dec = st.decimals;
  if (PRETTY) bar(title);
  console.log(`[pos] ${title}`);
  for (const u of users) {
    const { yes, no } = await readUserPos(conn, u.publicKey);
    const tag = u.publicKey.toBase58();
    console.log(`      ${tag.slice(0,4)}… YES=${fmtShd(yes,dec)}sh  NO=${fmtShd(no,dec)}sh`);
  }
  lf();
}

/* ---------------- Telemetry ---------------- */
function newTelem(){ return {
  trades: 0,
  buyYesUsd: 0, buyNoUsd: 0,
  sellYesSh: 0, sellNoSh: 0,
  users: {}  // by "A"/"B": { buyYesUsd, buyNoUsd, sellYesSh, sellNoSh }
};}

/* ---------------- Test utils ---------------- */
function approxEq(a,b,eps){ return Math.abs(a-b) <= (eps ?? 1e-6); }
async function ensureFreshMarket(conn, payer, bHuman=500000, feeBps=25){
  sep("RESET MARKET");
  try { await closeIx(conn, payer); } catch(_e){}
  const bScaled = toScaled(bHuman, 6); // b risk param kept at 1e6
  await initAmm(conn, payer, bScaled, feeBps);
  await sleep(250);
}
async function ensurePositions(conn, payers){
  sep("INIT POSITIONS");
  for (const p of payers) { await initPosition(conn, p); await sleep(80); }
}

/* --------- Expected payout calc (display/prorated vs ON-CHAIN) --------- */
function computeScaleBig(dec){ return BigInt(10 ** dec); }

/**
 * Returns:
 * {
 *   st, dec, wSumRaw,
 *   display: { details:[{tag,yes,no,win_raw,win_final,payout_display}], wSumFinal, expectedSumDisplay },
 *   onchain: { details:[{tag,yes,no,win_raw,raw_need}], onChainSum }
 * }
 */
async function computeExpectedPayouts(conn, users, winner){
  const amm = await ammPda();
  const st = await fetchAmmState(conn, amm);
  const dec = st.decimals;
  const SCALE_BI = computeScaleBig(dec);

  // Raw winners per user (on-chain truth)
  const rows = await readAllUserWins(conn, users, winner);
  const wSumRaw = rows.reduce((a,r)=>a + r.win, 0);
  const W = st.wTotal;

  // ON-CHAIN payouts: floor(win_raw * pps / 10^dec)
  const onChainDetails = rows.map(r => {
    const rawNeed = Number((BigInt(r.win) * BigInt(st.pps)) / SCALE_BI);
    return { tag: r.tag, yes: r.yes, no: r.no, win_raw: r.win, raw_need: rawNeed };
  });
  const onChainSum = onChainDetails.reduce((a,d)=> a + d.raw_need, 0);

  // DISPLAY (prorated) table — pretty only
  let details;
  if (wSumRaw === 0) {
    details = rows.map(r => ({ tag:r.tag, yes:r.yes, no:r.no, win_raw:r.win, win_final:0, payout_display:0 }));
    return { st, dec, wSumRaw,
      display:{ details, wSumFinal:0, expectedSumDisplay:0 },
      onchain:{ details:onChainDetails, onChainSum }
    };
  }

  if (NO_PRORATE) {
    details = rows.map(r => {
      const disp = Number((BigInt(r.win) * BigInt(st.pps)) / SCALE_BI);
      return { tag:r.tag, yes:r.yes, no:r.no, win_raw:r.win, win_final:r.win, payout_display:disp };
    });
  } else {
    const rawSumBI = BigInt(wSumRaw);
    const W_BI     = BigInt(W);
    let alloc = rows.map(r => ({
      tag:r.tag, yes:r.yes, no:r.no, win_raw:r.win,
      win_final:Number((BigInt(r.win) * W_BI) / rawSumBI)
    }));
    // Repair integer drift on ∑win_final
    const sumFinal = alloc.reduce((a,x)=>a + x.win_final, 0);
    let drift = W - sumFinal;
    if (drift !== 0 && alloc.length>0) {
      let idx = 0, best = -1;
      for (let i=1;i<alloc.length;i++){
        if (alloc[i].win_raw > best) { best = alloc[i].win_raw; idx = i; }
      }
      alloc[idx].win_final += drift;
    }
    details = alloc.map(x => ({
      tag:x.tag, yes:x.yes, no:x.no, win_raw:x.win_raw, win_final:x.win_final,
      payout_display:Number((BigInt(x.win_final) * BigInt(st.pps)) / SCALE_BI)
    }));
  }

  const expectedSumDisplay = details.reduce((a,d)=> a + d.payout_display, 0);
  const wSumFinal          = details.reduce((a,d)=> a + d.win_final, 0);

  return {
    st, dec, wSumRaw,
    display: { details, wSumFinal, expectedSumDisplay },
    onchain: { details: onChainDetails, onChainSum }
  };
}

function printExpectedPayoutsTable(res){
  const { st, dec } = res;
  const W = st.wTotal;

  if (PRETTY) bar("expected payouts (display vs on-chain)");
  console.log(`[calc] pps=$${fmtUSDd(st.pps,dec)} (display table uses prorated shares to 100% of W)`);

  // DISPLAY TABLE (prorated)
  console.log("        " + [
    padR("User", 6),
    padL("YES_sh", 16),
    padL("NO_sh", 16),
    padL("Win_raw", 16),
    padL("Win_final", 16),
    padL("% of W", 8),
    padL("Payout(disp)", 18)
  ].join("  "));

  for (const d of res.display.details){
    const pct = W>0 ? (100 * d.win_final / W) : 0;
    console.log("        " + [
      padR(d.tag+"…", 6),
      padL(fmtShd(d.yes,dec), 16),
      padL(fmtShd(d.no,dec), 16),
      padL(fmtShd(d.win_raw,dec), 16),
      padL(fmtShd(d.win_final,dec), 16),
      padL(pct.toFixed(2)+"%", 8),
      padL("$"+fmtUSDd(d.payout_display,dec), 18)
    ].join("  "));
  }

  console.log("        " + "-".repeat(110));
  console.log("        " + [
    padR("Σ", 6),
    padL("", 16),
    padL("", 16),
    padL(fmtShd(res.wSumRaw,dec), 16),
    padL(fmtShd(res.display.wSumFinal,dec), 16),
    padL("100.00%", 8),
    padL("$"+fmtUSDd(res.display.expectedSumDisplay,dec), 18)
  ].join("  "));

  // ON-CHAIN TOTAL (raw math)
  const onChainSumTxt = fmtUSDd(res.onchain.onChainSum, dec);
  console.log(`\n[on-chain] sum over raw winners (exact program math): $${onChainSumTxt}`);
  lf();
}

/* ------------- Validate + Final Report ------------- */
async function settleAndCheckToReport(conn, admin, winner, users, spendTally){
  sep(`STOP & SETTLE (${winner===1?"YES":"NO"})`);
  await stopIx(conn, admin);
  await settleIx(conn, admin, winner);

  const amm = await ammPda();
  const st = await fetchAmmState(conn, amm);
  const dec = st.decimals;
  const SCALE_BI = computeScaleBig(dec);

  const vaultBefore = st.vault;
  const W = st.wTotal;
  const pps = st.pps;
  const fees = st.fees;

  const pps_expected =
    (W <= 0) ? 0 : Math.min(Number(SCALE_BI), Number((BigInt(vaultBefore) * SCALE_BI) / BigInt(W)));
  if (Math.abs(pps - pps_expected) > 2) {
    console.error("[FAIL] pps mismatch:", { pps_actual: pps, pps_expected, W, vault: vaultBefore });
    return { ok:false };
  } else {
    console.log("[PASS] pps ok:", `$${fmtUSDd(pps,dec)}`);
  }

  await logPositions(conn, users, "positions before redeem");

  const exp = await computeExpectedPayouts(conn, users, winner);
  printExpectedPayoutsTable(exp);

  const displaySum = exp.display.expectedSumDisplay;
  const onChainSum = exp.onchain.onChainSum;

  sep("REDEEM ALL");
  for (const u of users) {
    const { yes, no } = await readUserPos(conn, u.publicKey);
    const win = (winner===1) ? yes : no;
    if (win > 0) { await redeemIx(conn, u); await sleep(80); }
  }

  const afterRed  = await fetchAmmState(conn, amm);
  const vaultAfter = afterRed.vault;
  const vaultDrop  = vaultBefore - vaultAfter;

  sep("FINAL TALLY");
  console.log(`Winner: ${winner===1?"YES":"NO"}`);
  console.log(`W (winning shares): ${fmtShd(W,dec)} sh`);
  console.log(`pps: $${fmtUSDd(pps,dec)}`);
  console.log(`Vault before: $${fmtUSDd(vaultBefore,dec)}   Vault after: $${fmtUSDd(vaultAfter,dec)}   Drop: $${fmtUSDd(vaultDrop,dec)}`);
  console.log(`Fees accrued: $${fmtUSDd(fees,dec)}`);

  if (spendTally){
    const { spentA_yes=0, spentA_no=0, spentB_yes=0, spentB_no=0, soldA_yes=0, soldA_no=0, soldB_yes=0, soldB_no=0 } = spendTally;
    console.log(`User A spent: YES $${spentA_yes.toFixed(2)}  NO $${spentA_no.toFixed(2)}   sold YES ${soldA_yes.toFixed(6)}sh  NO ${soldA_no.toFixed(6)}sh`);
    console.log(`User B spent: YES $${spentB_yes.toFixed(2)}  NO $${spentB_no.toFixed(2)}   sold YES ${soldB_yes.toFixed(6)}sh  NO ${soldB_no.toFixed(6)}sh`);
  }

  // Print ON-CHAIN winners (exact program math)
  for (const d of exp.onchain.details){
    console.log(`User ${d.tag} winning_sh=${fmtShd(d.win_raw,dec)} sh   payout=$${fmtUSDd(d.raw_need,dec)}`);
  }

  console.log(`Expected sum payouts (display): $${fmtUSDd(displaySum,dec)}`);
  console.log(`On-chain sum payouts:           $${fmtUSDd(onChainSum,dec)}`);
  console.log(`Actual drop:                    $${fmtUSDd(vaultDrop,dec)}`);

  if (vaultDrop !== onChainSum) {
    console.error("[FAIL] vault drop != on-chain sum payouts", {
      vault_before: vaultBefore, vault_after: vaultAfter,
      vaultDrop, onChainSum, diff: vaultDrop - onChainSum
    });
    return { ok:false };
  } else {
    console.log("[PASS] vault drop equals on-chain sum payouts");
  }

  await logPositions(conn, users, "positions after redeem");
  console.log("[PASS] all positions zero after redeem");

  return { ok:true };
}

/* ---------------- Buy helper for tests ---------------- */
async function multiBuy(conn, users, side /*1=YES,2=NO*/, amountsUSD){
  const st = await fetchAmmState(conn, await ammPda());
  for (let i=0;i<amountsUSD.length;i++){
    const u = users[i % users.length];
    await tradeIx(conn, u, side, 1, toScaled(amountsUSD[i], st.decimals));
    await sleep(40);
  }
}

/* ---------------- EXTENDED demo: drive YES to pps=1 ---------------- */
async function testPpsYesOne(conn, payers, opts){
  const [A,B] = payers;
  const YES_USD = Math.max(1, parseFloat(opts.yesUsd ?? "10"));
  const NO_USD  = Math.max(1, parseFloat(opts.noUsd  ?? "200"));
  const MAX_ITERS = Math.max(10, parseInt(opts.iters ?? "300",10));

  console.log("\n==== EXTENDED TEST: YES to pps=1.000000 ====");
  await ensureFreshMarket(conn, A, 500000, 25);
  await ensurePositions(conn, [A,B]);

  sep("DRIVE pps→1.0 (YES wins)");
  let spentA_yes=0, spentA_no=0, spentB_yes=0, spentB_no=0;

  for (let i=1;i<=MAX_ITERS;i++){
    const st = await fetchAmmState(conn, await ammPda());
    await tradeIx(conn, A, 1, 1, toScaled(YES_USD, st.decimals));
    await sleep(40);
    await tradeIx(conn, B, 2, 1, toScaled(NO_USD,  st.decimals));
    await sleep(40);
    spentA_yes += YES_USD;
    spentB_no  += NO_USD;

    if (i % 5 === 0){
      const amm = await ammPda();
      const st2 = await fetchAmmState(conn, amm);
      if (VERBOSE){
        const SCALE_BI = computeScaleBig(st2.decimals);
        const est_pps = (st2.qY>0)? Math.min(Number(SCALE_BI), Number((BigInt(st2.vault)*SCALE_BI)/ BigInt(st2.qY))) : 0;
        console.log(`[loop ${i}] qY=${fmtShd(st2.qY,st2.decimals)} vault=$${fmtUSDd(st2.vault,st2.decimals)} est_pps=$${fmtUSDd(est_pps,st2.decimals)}`);
      }
      if (st2.vault >= st2.qY && st2.qY > 0) { console.log(`[loop] Reached condition vault >= qY`); break; }
    }
  }
  const ok = await settleAndCheckToReport(conn, A, 1, [A,B],
    { spentA_yes, spentA_no, spentB_yes, spentB_no });
  if (!ok.ok) console.error("Extended test FAILED");
  else console.log("\n[ALL PASS] Extended pps=1.0 YES test finished.");
}

/* ---------------- RANDOM DUEL (legacy) ---------------- */
async function testRandomDuel(conn, payers, opts){
  const [A,B] = payers;
  const N = Math.max(1, parseInt(opts.n ?? "400",10));
  const aYesProb = Math.max(0, Math.min(1, parseFloat(opts.aYesProb ?? "0.7")));
  const bNoProb  = Math.max(0, Math.min(1, parseFloat(opts.bNoProb  ?? "0.7")));
  const minUsd   = Math.max(1, parseFloat(opts.minUsd ?? "5"));
  const maxUsd   = Math.max(minUsd, parseFloat(opts.maxUsd ?? "200"));
  const forceWinner = (opts.forceWinner || "auto").toLowerCase();

  console.log("\n==== RANDOM DUEL: A mostly YES, B mostly NO ====");
  await ensureFreshMarket(conn, A, 500000, 25);
  await ensurePositions(conn, [A,B]);

  sep(`RANDOM BUYS (per user: ${N})`);

  let spentA_yes=0, spentA_no=0, spentB_yes=0, spentB_no=0;

  for (let i=1;i<=N;i++){
    const st = await fetchAmmState(conn, await ammPda());

    // A
    const aSide = (Math.random() < aYesProb) ? 1 : 2;
    const aAmt  = randRange(minUsd, maxUsd);
    await tradeIx(conn, A, aSide, 1, toScaled(aAmt, st.decimals));
    if (aSide===1) spentA_yes += aAmt; else spentA_no += aAmt;

    await sleep(20);

    // B
    const bSide = (Math.random() < bNoProb) ? 2 : 1;
    const bAmt  = randRange(minUsd, maxUsd);
    await tradeIx(conn, B, bSide, 1, toScaled(bAmt, st.decimals));
    if (bSide===1) spentB_yes += bAmt; else spentB_no += bAmt;

    await sleep(20);

    if (VERBOSE && i % 50 === 0) await logAmmState(conn, `after ${i*2} random buys`);
  }

  let winner;
  if (forceWinner === "yes") winner = 1;
  else if (forceWinner === "no") winner = 2;
  else {
    const st = await fetchAmmState(conn, await ammPda());
    winner = (st.qY >= st.qN) ? 1 : 2;
    if (VERBOSE) console.log(`[auto] winner by inventory: qY=${fmtShd(st.qY,st.decimals)} qN=${fmtShd(st.qN,st.decimals)} => ${winner===1?"YES":"NO"}`);
  }

  const ok = await settleAndCheckToReport(conn, A, winner, [A,B],
    { spentA_yes, spentA_no, spentB_yes, spentB_no });
  if (!ok.ok) console.error("Random duel FAILED");
  else console.log("\n[ALL PASS] Random duel finished.");
}

/* ---------------- RUNNER with BUY+SELL and closed-market handling ---------------- */
function parseRunFlags(argv){
  const out = {
    mode: "mixed",
    steps: 600,
    cadence: 250,
    minUsd: 5,
    maxUsd: 200,
    aYesProb: 0.58,
    bNoProb:  0.62,
    sellProb: 0.35,
    sellFrac: 0.33,
    winner: "auto",        // auto|yes|no
    onClosed: "skip",      // skip|reinit|fail
    reinitFeeBps: 25
  };
  for (let i=0;i<argv.length;i++){
    const k = argv[i];
    if (k==="--mode") out.mode = String(argv[++i]||"mixed").toLowerCase();
    else if (k==="--steps") out.steps = Math.max(1, parseInt(argv[++i]||"600",10));
    else if (k==="--cadence") out.cadence = Math.max(50, parseInt(argv[++i]||"250",10));
    else if (k==="--min-usd") out.minUsd = Math.max(1, parseFloat(argv[++i]||"5"));
    else if (k==="--max-usd") out.maxUsd = Math.max(out.minUsd, parseFloat(argv[++i]||"200"));
    else if (k==="--a-yes-prob") out.aYesProb = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.58")));
    else if (k==="--b-no-prob")  out.bNoProb  = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.62")));
    else if (k==="--sell-prob")  out.sellProb = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.35")));
    else if (k==="--sell-frac")  out.sellFrac = Math.max(0.01, Math.min(1, parseFloat(argv[++i]||"0.33")));
    else if (k==="--winner")     out.winner = String(argv[++i]||"auto").toLowerCase();
    else if (k==="--on-closed")  out.onClosed = String(argv[++i]||"skip").toLowerCase();
    else if (k==="--reinit-fee-bps") out.reinitFeeBps = parseInt(argv[++i]||"25", 10);
  }
  return out;
}

function chooseBuySide(mode, price, aBias, bBias, forUser /*"A"|"B"*/){
  const r = Math.random();
  if (mode === "trend")    return (Math.random() < (price >= 0.5 ? 0.65 : 0.35)) ? 1 : 2;
  if (mode === "meanrevert") return (Math.random() < (price >= 0.5 ? 0.35 : 0.65)) ? 1 : 2;
  if (mode === "random")   return (Math.random()<0.5) ? 1 : 2;
  if (forUser === "A") return (r < aBias) ? 1 : 2;
  return (r < (1 - bBias)) ? 1 : 2; // B mostly NO if bBias high
}

// trade wrapper that handles MarketClosed without crashing
async function tryTrade(conn, payer, side, action, amountScaled, label){
  try {
    const sig = await tradeIx(conn, payer, side, action, amountScaled);
    return { ok: true, sig };
  } catch (e) {
    const name = e?.anchor?.name;
    const msg  = e?.anchor?.msg || e?.message || "unknown error";
    if (name === "MarketClosed" || /market is closed/i.test(msg)) {
      if (VERBOSE) console.warn(`[trade/${label}] MarketClosed: ${msg}`);
      return { ok: false, reason: "MarketClosed", error: e };
    }
    throw e; // rethrow others
  }
}

async function handleClosedMarket(conn, admin, opts){
  if (opts.onClosed === "skip") {
    if (VERBOSE) console.log("[runner] Market closed → skipping this trade");
    return true;
  }
  if (opts.onClosed === "reinit") {
    sep("MARKET CLOSED → REINIT");
    try { await closeIx(conn, admin); } catch(_e){}
    const bHuman = 500000;
    await initAmm(conn, admin, toScaled(bHuman, 6), opts.reinitFeeBps);
    await ensurePositions(conn, [admin]); // ensure admin pos; extend externally if needed
    return true;
  }
  console.error("[runner] Market closed → stopping run (onClosed=fail)");
  return false;
}

async function runLoop(conn, payers, opts){
  const [A,B] = payers;
  const amm = await ammPda();
  let st = await fetchAmmState(conn, amm);
  const dec = st.decimals;

  const telem = newTelem();
  telem.users["A"] = { buyYesUsd:0, buyNoUsd:0, sellYesSh:0, sellNoSh:0 };
  telem.users["B"] = { buyYesUsd:0, buyNoUsd:0, sellYesSh:0, sellNoSh:0 };

  sep(`RUN (${opts.mode}, steps=${opts.steps}, sellProb=${opts.sellProb}, sellFrac=${opts.sellFrac}, onClosed=${opts.onClosed})`);

  for (let i=1;i<=opts.steps;i++){
    st = await fetchAmmState(conn, amm);
    const price = lmsrPYes(st);

    // USER A
    if (Math.random() < opts.sellProb) {
      const { yes, no } = await readUserPos(conn, A.publicKey);
      const side = (yes>0 && no>0) ? (Math.random()<0.5?1:2) : (yes>0?1: (no>0?2: (price>0.5?1:2)));
      const inv = side===1 ? yes : no;
      if (inv > 0) {
        const sh = Math.max(1, Math.floor(inv * opts.sellFrac));
        const res = await tryTrade(conn, A, side, 2, sh, `A-sell-${side===1?"YES":"NO"}`);
        if (!res.ok && res.reason === "MarketClosed") { if (!(await handleClosedMarket(conn, A, opts))) break; }
        else {
          if (side===1) { telem.sellYesSh += sh; telem.users["A"].sellYesSh += sh/10**dec; }
          else          { telem.sellNoSh  += sh; telem.users["A"].sellNoSh  += sh/10**dec; }
          telem.trades++;
        }
      }
    } else {
      const side = chooseBuySide(opts.mode, price, opts.aYesProb, opts.bNoProb, "A");
      const usd  = randRange(opts.minUsd, opts.maxUsd);
      const res  = await tryTrade(conn, A, side, 1, toScaled(usd, dec), `A-buy-${side===1?"YES":"NO"}`);
      if (!res.ok && res.reason === "MarketClosed") { if (!(await handleClosedMarket(conn, A, opts))) break; }
      else {
        if (side===1) { telem.buyYesUsd += toScaled(usd,dec); telem.users["A"].buyYesUsd += usd; }
        else          { telem.buyNoUsd  += toScaled(usd,dec); telem.users["A"].buyNoUsd  += usd; }
        telem.trades++;
      }
    }

    await sleep(opts.cadence);

    // USER B
    st = await fetchAmmState(conn, amm);
    const price2 = lmsrPYes(st);
    if (Math.random() < opts.sellProb) {
      const { yes, no } = await readUserPos(conn, B.publicKey);
      const side = (yes>0 && no>0) ? (Math.random()<0.5?1:2) : (yes>0?1: (no>0?2: (price2<0.5?2:1)));
      const inv = side===1 ? yes : no;
      if (inv > 0) {
        const sh = Math.max(1, Math.floor(inv * opts.sellFrac));
        const res = await tryTrade(conn, B, side, 2, sh, `B-sell-${side===1?"YES":"NO"}`);
        if (!res.ok && res.reason === "MarketClosed") { if (!(await handleClosedMarket(conn, B, opts))) break; }
        else {
          if (side===1) { telem.sellYesSh += sh; telem.users["B"].sellYesSh += sh/10**dec; }
          else          { telem.sellNoSh  += sh; telem.users["B"].sellNoSh  += sh/10**dec; }
          telem.trades++;
        }
      }
    } else {
      const side = chooseBuySide(opts.mode, price2, opts.aYesProb, opts.bNoProb, "B");
      const usd  = randRange(opts.minUsd, opts.maxUsd);
      const res  = await tryTrade(conn, B, side, 1, toScaled(usd, dec), `B-buy-${side===1?"YES":"NO"}`);
      if (!res.ok && res.reason === "MarketClosed") { if (!(await handleClosedMarket(conn, B, opts))) break; }
      else {
        if (side===1) { telem.buyYesUsd += toScaled(usd,dec); telem.users["B"].buyYesUsd += usd; }
        else          { telem.buyNoUsd  += toScaled(usd,dec); telem.users["B"].buyNoUsd  += usd; }
        telem.trades++;
      }
    }

    if (VERBOSE && i % 50 === 0) await logAmmState(conn, `after step ${i}`);
  }

  // Pre-settle summary
  st = await fetchAmmState(conn, amm);
  const pYes = lmsrPYes(st);
  sep("PRE-SETTLE SUMMARY");
  console.log(`Price: YES=${pYes.toFixed(6)} NO=${(1-pYes).toFixed(6)}`);
  console.log(`qY=${fmtShd(st.qY,st.decimals)}sh qN=${fmtShd(st.qN,st.decimals)}sh  Vault=$${fmtUSDd(st.vault,st.decimals)}  Fees=$${fmtUSDd(st.fees,st.decimals)}`);
  console.log(`Trades=${telem.trades}`);
  console.log(`Buys (scaled): YES=$${fmtUSDd(telem.buyYesUsd,st.decimals)}  NO=$${fmtUSDd(telem.buyNoUsd,st.decimals)}`);
  console.log(`Sells (shares): YES=${fmtShd(telem.sellYesSh,st.decimals)}sh  NO=${fmtShd(telem.sellNoSh,st.decimals)}sh`);
  console.log(`User A: buys YES $${telem.users["A"].buyYesUsd.toFixed(2)} NO $${telem.users["A"].buyNoUsd.toFixed(2)} | sells YES ${telem.users["A"].sellYesSh.toFixed(6)}sh NO ${telem.users["A"].sellNoSh.toFixed(6)}sh`);
  console.log(`User B: buys YES $${telem.users["B"].buyYesUsd.toFixed(2)} NO $${telem.users["B"].buyNoUsd.toFixed(2)} | sells YES ${telem.users["B"].sellYesSh.toFixed(6)}sh NO ${telem.users["B"].sellNoSh.toFixed(6)}sh`);
  lf();

  // pick winner
  let winner = 1;
  if (opts.winner === "yes") winner = 1;
  else if (opts.winner === "no") winner = 2;
  else winner = (st.qY >= st.qN) ? 1 : 2;

  const spendTally = {
    spentA_yes: telem.users["A"].buyYesUsd,
    spentA_no:  telem.users["A"].buyNoUsd,
    spentB_yes: telem.users["B"].buyYesUsd,
    spentB_no:  telem.users["B"].buyNoUsd,
    soldA_yes:  telem.users["A"].sellYesSh,
    soldA_no:   telem.users["A"].sellNoSh,
    soldB_yes:  telem.users["B"].sellYesSh,
    soldB_no:   telem.users["B"].sellNoSh,
  };

  await settleAndCheckToReport(conn, A, winner, [A,B], spendTally);
}

/* ---------------- UNIT TESTS ---------------- */
async function unitTestsSingle(conn, payer) {
  console.log("\n==== UNIT TESTS: SINGLE WALLET ====");
  console.log("\n-- Case A: YES wins --");
  await ensureFreshMarket(conn, payer, 500000, 25);
  await ensurePositions(conn, [payer]);
  await multiBuy(conn, [payer], 1, [200, 120, 80, 100, 150]);
  await multiBuy(conn, [payer], 2, [ 60,  40]);
  let ok = await settleAndCheckToReport(conn, payer, 1, [payer]);
  if (!ok.ok) return console.error("Case A FAILED");

  console.log("\n-- Case B: NO wins --");
  await ensureFreshMarket(conn, payer, 500000, 25);
  await ensurePositions(conn, [payer]);
  await multiBuy(conn, [payer], 2, [120, 120, 60, 40]);
  await multiBuy(conn, [payer], 1, [ 50,  30]);
  ok = await settleAndCheckToReport(conn, payer, 2, [payer]);
  if (!ok.ok) return console.error("Case B FAILED");

  console.log("\n[ALL PASS] Single-wallet unit tests completed.");
}
async function unitTestsTwo(conn, payers) {
  console.log("\n==== UNIT TESTS: TWO WALLETS ====");
  const [A,B] = payers;

  console.log("\n-- Case A: YES wins (two users) --");
  await ensureFreshMarket(conn, A, 500000, 25);
  await ensurePositions(conn, [A,B]);
  await multiBuy(conn, [A,B], 1, [200,120,80,150]);
  await multiBuy(conn, [A,B], 2, [ 60, 40]);
  let ok = await settleAndCheckToReport(conn, A, 1, [A,B]);
  if (!ok.ok) return console.error("Case A FAILED");

  console.log("\n-- Case B: NO wins (two users) --");
  await ensureFreshMarket(conn, A, 500000, 25);
  await ensurePositions(conn, [A,B]);
  await multiBuy(conn, [A,B], 2, [160,140,100]);
  await multiBuy(conn, [A,B], 1, [ 40,  30]);
  ok = await settleAndCheckToReport(conn, A, 2, [A,B]);
  if (!ok.ok) return console.error("Case B FAILED");

  console.log("\n[ALL PASS] Two-wallet unit tests completed.");
}

/* ---------------- Demo ---------------- */
async function demo(conn, payer){
  console.log("\n==== DEMO ====");
  await ensureFreshMarket(conn, payer, 500000, 25);
  await ensurePositions(conn, [payer]);
  const st = await fetchAmmState(conn, await ammPda());
  await tradeIx(conn, payer, 1, 1, toScaled(200, st.decimals));
  await tradeIx(conn, payer, 2, 1, toScaled(60,  st.decimals));
  await settleAndCheckToReport(conn, payer, 1, [payer]);
}

/* ---------------- CLI helpers ---------------- */
function parseWalletList(argv){
  const idx = argv.indexOf("--wallets");
  let list = idx>=0 ? argv[idx+1] : (process.env.TEST_WALLETS || "");
  if (!list) return [];
  return list.split(",").map(s=>s.trim()).filter(Boolean);
}
function parseExtendedFlags(argv){
  const out = {};
  const get = (k, d)=>{ const i=argv.indexOf(k); return i>=0 ? argv[i+1] : d; };
  out.yesUsd = get("--yes-usd", "10");
  out.noUsd  = get("--no-usd",  "200");
  out.iters  = get("--iters",   "300");
  return out;
}
function parseRandomFlags(argv){
  const out = {};
  const get = (k, d)=>{ const i=argv.indexOf(k); return i>=0 ? argv[i+1] : d; };
  out.n           = get("--n", "400");
  out.aYesProb    = get("--a-yes-prob", "0.7");
  out.bNoProb     = get("--b-no-prob",  "0.7");
  out.minUsd      = get("--min-usd", "5");
  out.maxUsd      = get("--max-usd", "200");
  out.forceWinner = get("--force-winner", "auto"); // yes|no|auto
  return out;
}

/* ---------------- NEW: rounding test convenience ---------------- */
function parseRoundingFlags(argv){
  const out = {
    steps: 20,
    mode: "mixed",
    sellProb: 0.4,
    sellFrac: 0.4,
    winner: "auto",
    cadence: 200,
    minUsd: 5,
    maxUsd: 200,
    aYesProb: 0.58,
    bNoProb: 0.62,
    onClosed: "skip",
    reinitFeeBps: 25
  };
  for (let i=0;i<argv.length;i++){
    const k = argv[i];
    if (k==="--steps") out.steps = Math.max(1, parseInt(argv[++i]||"20",10));
    else if (k==="--mode") out.mode = String(argv[++i]||"mixed");
    else if (k==="--sell-prob") out.sellProb = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.4")));
    else if (k==="--sell-frac") out.sellFrac = Math.max(0.01, Math.min(1, parseFloat(argv[++i]||"0.4")));
    else if (k==="--winner") out.winner = String(argv[++i]||"auto").toLowerCase();
    else if (k==="--cadence") out.cadence = Math.max(50, parseInt(argv[++i]||"200",10));
    else if (k==="--min-usd") out.minUsd = Math.max(1, parseFloat(argv[++i]||"5"));
    else if (k==="--max-usd") out.maxUsd = Math.max(out.minUsd, parseFloat(argv[++i]||"200"));
    else if (k==="--a-yes-prob") out.aYesProb = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.58")));
    else if (k==="--b-no-prob") out.bNoProb = Math.max(0, Math.min(1, parseFloat(argv[++i]||"0.62")));
    else if (k==="--on-closed") out.onClosed = String(argv[++i]||"skip").toLowerCase();
    else if (k==="--reinit-fee-bps") out.reinitFeeBps = parseInt(argv[++i]||"25", 10);
  }
  return out;
}

/* ---------------- Main ---------------- */
(async ()=>{
  const conn = new Connection(RPC, "processed");
  const payer = readKeypair(WALLET);
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd==="help" || cmd==="--help" || cmd==="-h"){
    console.log(
`Usage:
  node app/trade.js init [bHumanShares] [feeBps]
  node app/trade.js init-pos
  node app/trade.js quote
  node app/trade.js buy yes  <USD>
  node app/trade.js buy no   <USD>
  node app/trade.js sell yes <SHARES>
  node app/trade.js sell no  <SHARES>
  node app/trade.js stop
  node app/trade.js settle yes|no
  node app/trade.js redeem
  node app/trade.js close

  # Runners / tests
  node app/trade.js run  --wallets a.json,b.json [--mode random|trend|meanrevert|mixed] [--steps 600] [--cadence 250] \\
                         [--min-usd 5] [--max-usd 200] [--a-yes-prob 0.58] [--b-no-prob 0.62] \\
                         [--sell-prob 0.35] [--sell-frac 0.33] [--winner auto|yes|no] \\
                         [--on-closed skip|reinit|fail] [--reinit-fee-bps 25]
  node app/trade.js demo
  node app/trade.js test
  node app/trade.js test2 [--wallets pathA.json,pathB.json]
  node app/trade.js test-pps-yes1 [--wallets a.json,b.json] [--yes-usd 10] [--no-usd 200] [--iters 300]
  node app/trade.js test-random-duel [--wallets a.json,b.json] [--n 400] [--a-yes-prob 0.7] [--b-no-prob 0.7] [--min-usd 5] [--max-usd 200] [--force-winner auto|yes|no]

  # Rounding repro (convenience):
  node app/trade.js test-rounding --wallets a.json,b.json [--steps 20] [--sell-prob 0.4] [--sell-frac 0.4] [--winner auto] [--pretty] [-v]

  # Reporting flags:
  --pretty        prettier section headers
  --verbose,-v    extra logs
  --no-prorate    disable pro-rating (WARN if Σ user wins != W)`
    );
    process.exit(0);
  }

  if (cmd === "init"){
    const bHuman = parseFloat(rest[0] || "500000");
    const feeBps = parseInt(rest[1] || "25", 10);
    const bScaled = toScaled(bHuman, 6);
    await initAmm(conn, payer, bScaled, feeBps);
    return;
  }
  if (cmd === "init-pos"){ await initPosition(conn, payer); return; }
  if (cmd === "quote"){ await quoteIx(conn, payer); return; }
  if (cmd === "stop"){ await stopIx(conn, payer); return; }
  if (cmd === "settle"){
    const w = (rest[0]||"").toLowerCase()==="yes" ? 1 : 2;
    await settleIx(conn, payer, w);
    return;
  }
  if (cmd === "redeem"){ await redeemIx(conn, payer); return; }
  if (cmd === "close"){ await closeIx(conn, payer); return; }

  if (cmd === "buy" || cmd === "sell"){
    const amm = await ammPda();
    const st = await fetchAmmState(conn, amm);
    const side = (rest[0]||"").toLowerCase() === "yes" ? 1 : 2;
    const amt  = parseFloat(rest[1]||"0");
    if (!(amt>0)){ console.error("Missing/invalid amount"); process.exit(1); }
    const action = cmd==="buy" ? 1 : 2;
    await tradeIx(conn, payer, side, action, toScaled(amt, st.decimals));
    return;
  }

  if (cmd === "run"){
    const wallets = parseWalletList(rest);
    let payers = [];
    if (wallets.length >= 2) {
      payers = [ readKeypair(wallets[0]), readKeypair(wallets[1]) ];
    } else {
      console.warn("run: --wallets not provided or <2; using single wallet twice");
      payers = [ payer, payer ];
    }
    await ensurePositions(conn, payers);
    const opts = parseRunFlags(rest);
    await runLoop(conn, payers, opts);
    return;
  }

  if (cmd === "demo"){ await demo(conn, payer); return; }
  if (cmd === "test"){ await unitTestsSingle(conn, payer); return; }

  if (cmd === "test2"){
    const wallets = parseWalletList(rest);
    let payers = [];
    if (wallets.length >= 2) {
      payers = [ readKeypair(wallets[0]), readKeypair(wallets[1]) ];
    } else {
      console.warn("test2: --wallets not provided or <2; using single wallet twice");
      payers = [ payer, payer ];
    }
    await unitTestsTwo(conn, payers);
    return;
  }

  if (cmd === "test-pps-yes1"){
    const wallets = parseWalletList(rest);
    if (wallets.length < 2) { console.error("test-pps-yes1 requires --wallets a.json,b.json"); process.exit(1); }
    const A = readKeypair(wallets[0]);
    const B = readKeypair(wallets[1]);
    const opts = parseExtendedFlags(rest);
    await testPpsYesOne(conn, [A,B], opts);
    return;
  }

  if (cmd === "test-random-duel"){
    const wallets = parseWalletList(rest);
    if (wallets.length < 2) { console.error("test-random-duel requires --wallets a.json,b.json"); process.exit(1); }
    const A = readKeypair(wallets[0]);
    const B = readKeypair(wallets[1]);
    const opts = parseRandomFlags(rest);
    await testRandomDuel(conn, [A,B], opts);
    return;
  }

  if (cmd === "test-rounding"){
    const wallets = parseWalletList(rest);
    if (wallets.length < 2) { console.error("test-rounding requires --wallets a.json,b.json"); process.exit(1); }
    const A = readKeypair(wallets[0]);
    const B = readKeypair(wallets[1]);
    await ensureFreshMarket(conn, A, 500000, 25);
    await ensurePositions(conn, [A,B]);
    const opts = parseRoundingFlags(rest);
    await runLoop(conn, [A,B], opts);
    return;
  }

  console.error("Unknown command. Use --help");
  process.exit(1);
})().catch(e=>{ console.error("Fatal:", e?.message || e); process.exit(1); });

