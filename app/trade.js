#!/usr/bin/env node
// app/trade.js — SOL-flow AMM client (up to 5 users), exact PnL, totals.
// Modes: --simple|-S (colored), --jsonl, --quiet, --audit.
// Shows BTC (≤4 dp) and timestamp on every trade line, snapshots at run start,
// settles by oracle, and prints resolve banner using the SAME JS BTC decoder.

const fs = require("fs");
const crypto = require("crypto");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");

/* ---------------- CONFIG ---------------- */
const RPC    = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

// === PROGRAM IDs / SEEDS ===
const PID            = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const AMM_SEED       = Buffer.from("amm_btc_v3");  // bump to v3 if you want a new PDA
const POS_SEED       = Buffer.from("pos");
const VAULT_SOL_SEED = Buffer.from("vault_sol");

// Must match the on-chain LAMPORTS_PER_E6 for correct SOL reporting
const LAMPORTS_PER_E6 = 100; // CRITICAL: Must match Rust program (lib.rs:982)

// Oracle STATE account (not program id) — pass as env or --oracle
let ORACLE_STATE = null;
try { if (process.env.ORACLE_STATE) ORACLE_STATE = new PublicKey(process.env.ORACLE_STATE); } catch (_) {}

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
const SIMPLE_COLOR = WANT_COLOR && SIMPLE && !JSONL;

/* ---------------- Utils ---------------- */
function sep(s){ if (PRETTY){ const bar="═".repeat(14); console.log("\n"+C.bold(C.c(`${bar} ${s} ${bar}`))); } }
function fmtScaled(x, dec=6){ return (x/10**dec).toFixed(dec); }
function toScaled(x, dp){ return Math.round(Number(x)*10**dp); }
function readKeypair(p){ return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p,"utf8")))); }
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
function dedupePayers(payers){ const seen=new Set(); const out=[]; for(const p of payers){ const k=p.publicKey.toBase58(); if(!seen.has(k)){ seen.add(k); out.push(p);} } return out; }
const left = (s, n) => (String(s)+" ".repeat(n)).slice(0, n);
const fmtNum = (x,d=3)=> (x===undefined||x===null) ? "—" : Number(x).toFixed(d);
const fmtUsdHuman = (x) =>
  (x===undefined||x===null) ? "—" :
  (x>=1e9? `$${(x/1e9).toFixed(2)}B` : x>=1e6? `$${(x/1e6).toFixed(2)}M` : x>=1e3? `$${(x/1e3).toFixed(1)}k` : `$${Number(x).toFixed(2)}`);
const fmtDur = (secs)=>`${Math.floor(secs/60)}:${String(secs%60).padStart(2,"0")}`;
const nowISO = () => new Date().toISOString().slice(0,19).replace("T"," ");

// e6 <-> SOL helpers (integer-only conversions using BigInt)
function e6ToSOL(e6){
  // Convert e6 credits to lamports using pure integer math, then to SOL for display
  const lamports = BigInt(e6) * BigInt(LAMPORTS_PER_E6);
  return Number(lamports) / 1e9;  // Only convert to float at final display step
}
function fmtSOL(sol){ return `${sol.toFixed(6)} SOL`; }

// Format a 1e6-scaled BigInt to ≤4 decimals
function fmtE6To4(x_e6_bigint){
  const neg = x_e6_bigint < 0n;
  let v = neg ? -x_e6_bigint : x_e6_bigint;
  const intPart = v / 1_000_000n;
  const frac6   = v % 1_000_000n;
  const frac4   = frac6 / 100n;
  const last2   = frac6 % 100n;
  let rounded4  = frac4 + (last2 >= 50n ? 1n : 0n);
  let i = intPart;
  if (rounded4 >= 10_000n) { rounded4 = 0n; i += 1n; }
  const fracStr = rounded4.toString().padStart(4, "0");
  return `${neg?"-":""}${i.toString()}.${fracStr}`;
}

/* ---------------- Labels ---------------- */
function userLabelByIndex(i){ return `User${String.fromCharCode(65 + i)}`; } // 0->A ... 4->E
function whoKeyByIndex(i){ return String.fromCharCode(65 + i); }            // "A".."E"

/* ---------------- PDAs + Disc ---------------- */
async function ammPda(){ return PublicKey.findProgramAddressSync([AMM_SEED], PID)[0]; }
function posPda(owner, amm){ return PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), owner.toBuffer()], PID)[0]; }
function vaultSolPda(amm){ return PublicKey.findProgramAddressSync([VAULT_SOL_SEED, amm.toBuffer()], PID)[0]; }

function disc(name){ return crypto.createHash("sha256").update("global:"+name).digest().subarray(0,8); }
const D_INIT_AMM       = disc("init_amm");
const D_INIT_POS       = disc("init_position");
const D_TRADE          = disc("trade");
const D_STOP           = disc("stop_market");
const D_SETTLE         = disc("settle_market");
const D_REDEEM         = disc("redeem");
const D_CLOSE          = disc("close_amm");
const D_SNAPSHOT_START = disc("snapshot_start");
const D_SETTLE_BY_ORAC = disc("settle_by_oracle");

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
  let startPrice=0, startTs=0, settlePrice=0, settleTs=0;
  try {
    startPrice  = readI64LE(p,o); o+=8;
    startTs     = readI64LE(p,o); o+=8;
    settlePrice = readI64LE(p,o); o+=8;
    settleTs    = readI64LE(p,o); o+=8;
  } catch(_) {}
  return { bump, decimals, bScaled, feeBps, qY, qN, fees, vault, status, winner, wTotal, pps,
           startPrice, startTs, settlePrice, settleTs, accLen: d.length };
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
  let extra = "";
  if (st.startPrice) extra += ` start=$${fmtScaled(st.startPrice,d)}@${st.startTs}`;
  if (st.settlePrice) extra += ` settle=$${fmtScaled(st.settlePrice,d)}@${st.settleTs}`;
  console.log(
    `${C.k(`[state/${label}]`)} `
    + `qY=${C.y(fmtScaled(st.qY,d))}sh `
    + `qN=${C.y(fmtScaled(st.qN,d))}sh `
    + `vault=$${C.c(C.bold(fmtScaled(st.vault,d)))} `
    + `fees=$${C.c(fmtScaled(st.fees,d))} `
    + `pps=$${C.c(fmtScaled(st.pps,d))} `
    + `W=${C.m(fmtScaled(st.wTotal,d))} `
    + `status=${st.status} winner=${st.winner}`
    + (extra?(" "+C.k(extra)):"")
  );
}

async function marketStatus(conn){
  try { const st = await fetchAmmState(conn, await ammPda()); return { exists:true, status:st.status, st }; }
  catch(_){ return { exists:false, status:-1, st:null }; }
}

/* ---------------- Oracle reader (BigInt safe) ---------------- */
async function fetchOracleBTC(conn, oraclePk){
  const info = await conn.getAccountInfo(oraclePk, "processed");
  if (!info || !info.data || info.data.length < 8+32+48*3+2) throw new Error("oracle_state too small");
  const d = info.data.subarray(8); let o=0;
  o += 32; // update_authority Pubkey

  const readI64 = () => { const v = d.readBigInt64LE(o); o+=8; return v; };

  // btc triplet
  const p1 = readI64(), p2 = readI64(), p3 = readI64();
  const t1 = readI64(), t2 = readI64(), t3 = readI64();

  // skip eth (48) + sol (48)
  o += 96;

  const decimals = d.readUInt8(o); o+=1;
  /* bump */ o+=1;

  const median3 = (a,b,c) => {
    const arr = [a,b,c].sort((x,y)=> (x<y?-1:(x>y?1:0)));
    return arr[1];
  };

  const priceRaw = median3(p1,p2,p3);       // BigInt (10^decimals)
  const scale = 10n ** BigInt(decimals);
  const price_e6 = (priceRaw * 1_000_000n) / scale;  // USD * 1e6 (BigInt)

  return { price_e6, decimals };
}

/* ---------------- Fee destination helper ---------------- */
let FEE_DEST_GLOBAL = null;
function getFeeDest(defaultPk){
  try { if (process.env.FEE_DEST) return new PublicKey(process.env.FEE_DEST); }
  catch(_){}
  return defaultPk;
}

/* ---------------- ixs ---------------- */
function u8(n){ const b=Buffer.alloc(1); b.writeUInt8(n); return b; }
function u16le(n){ const b=Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function i64le(n){ let x=BigInt(n); if (x<0n) x=(1n<<64n)+x; const b=Buffer.alloc(8); b.writeBigUInt64LE(x); return b; }

async function ixInitAmm(conn, payer, bHuman=500000, feeBps=25){
  const amm = await ammPda();
  const feeDest = getFeeDest(payer.publicKey);
  FEE_DEST_GLOBAL = feeDest;
  const vaultSol = vaultSolPda(amm);

  const data = Buffer.concat([D_INIT_AMM, i64le(toScaled(bHuman,6)), u16le(feeBps)]);
  const keys = [
    { pubkey: amm,                     isSigner:false, isWritable:true  },
    { pubkey: payer.publicKey,         isSigner:true,  isWritable:true  },
    { pubkey: feeDest,                 isSigner:false, isWritable:true  },
    { pubkey: vaultSol,                isSigner:false, isWritable:true  },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  const tx = new Transaction().add(
    ...budgetIxs(),
    new TransactionInstruction({ programId: PID, keys, data })
  );
  await sendTx(conn, tx, [payer], "init");
  await logState(conn, "after init");
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
  const feeDest = FEE_DEST_GLOBAL || getFeeDest(payer.publicKey);
  const vaultSol = vaultSolPda(amm);

  const data = Buffer.concat([D_TRADE, u8(side), u8(action), i64le(amountScaled)]);
  const keys = [
    { pubkey: amm,                     isSigner:false, isWritable:true  },
    { pubkey: payer.publicKey,         isSigner:true,  isWritable:true  },
    { pubkey: pos,                     isSigner:false, isWritable:true  },
    { pubkey: feeDest,                 isSigner:false, isWritable:true  },
    { pubkey: vaultSol,                isSigner:false, isWritable:true  },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
    { pubkey: SYSVAR_RENT_PUBKEY,      isSigner:false, isWritable:false },
  ];
  const tx = new Transaction().add(
    ...budgetIxs(),
    new TransactionInstruction({ programId: PID, keys, data })
  );
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
  const vaultSol = vaultSolPda(amm);
  const feeDest  = FEE_DEST_GLOBAL || getFeeDest(payer.publicKey);

  const tx = new Transaction().add(
    ...budgetIxs(200_000,0),
    new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm,                     isSigner:false, isWritable:true  },
        { pubkey: payer.publicKey,         isSigner:true,  isWritable:true  },
        { pubkey: pos,                     isSigner:false, isWritable:true  },
        { pubkey: feeDest,                 isSigner:false, isWritable:true  },
        { pubkey: vaultSol,                isSigner:false, isWritable:true  },
        { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
        { pubkey: SYSVAR_RENT_PUBKEY,      isSigner:false, isWritable:false },
      ],
      data: Buffer.from(D_REDEEM)
    })
  );
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
async function ixSnapshotStart(conn, payer, oraclePk){
  const amm = await ammPda();
  const info = await conn.getAccountInfo(oraclePk, "processed");
  if (!info) throw new Error("oracle_state not found");
  const want = "7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE";
  if (info.owner.toBase58() !== want) throw new Error(`oracle_state owner mismatch`);
  const keys = [
    { pubkey: amm,         isSigner:false, isWritable:true  },
    { pubkey: oraclePk,    isSigner:false, isWritable:false },
  ];
  const tx = new Transaction().add(
    ...budgetIxs(200_000,0),
    new TransactionInstruction({ programId: PID, keys, data: Buffer.from(D_SNAPSHOT_START) })
  );
  await sendTx(conn, tx, [payer], "snapshot-start");
}
async function ixSettleByOracle(conn, payer, oraclePk, geWinsYes=true){
  const amm = await ammPda();
  const info = await conn.getAccountInfo(oraclePk, "processed");
  if (!info) throw new Error("oracle_state not found");
  const want = "7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE";
  if (info.owner.toBase58() !== want) throw new Error(`oracle_state owner mismatch`);
  const keys = [
    { pubkey: amm,         isSigner:false, isWritable:true  },
    { pubkey: oraclePk,    isSigner:false, isWritable:false },
  ];
  const data = Buffer.concat([D_SETTLE_BY_ORAC, u8(geWinsYes?1:0)]);
  const tx = new Transaction().add(
    ...budgetIxs(200_000,0),
    new TransactionInstruction({ programId: PID, keys, data })
  );
  await sendTx(conn, tx, [payer], `settle-oracle(${geWinsYes?">=":">"})`);
}

/* ---------------- Logging (simple) ---------------- */
function paintSimple(s, kind){
  if (!SIMPLE_COLOR) return s;
  if (kind==="buy")  return C.g(s);
  if (kind==="sell") return C.y(s);
  if (kind==="yes")  return C.g(s);
  if (kind==="no")   return C.r(s);
  if (kind==="vault")return C.c(s);
  if (kind==="fees") return C.m(s);
  if (kind==="inv")  return C.k(s);
  if (kind==="btc")  return C.b(s);
  return s;
}

function logSimpleTradeLine({
  step, user, side, action, amountScaled, decimals,
  quotesYes, quotesNo, vaultScaled, invYesScaled, invNoScaled, feesScaled,
  btcStr4, timeStr
}){
  if (QUIET || !SIMPLE) return;

  const sStep = step != null ? String(step).padStart(3, "0") : "—";
  const who   = left(user || "—", 6);
  const act   = (action===1?"BUY":"SELL");
  const out   = (side===1?"YES":"NO");

  const amountHuman = fmtScaled(amountScaled, decimals);
  const vaultHuman  = Number(fmtScaled(vaultScaled, decimals));
  const invY  = Number(fmtScaled(invYesScaled, decimals)).toLocaleString();
  const invN  = Number(fmtScaled(invNoScaled , decimals)).toLocaleString();
  const feesH = Number(fmtScaled(feesScaled,  decimals));

  const line =
    `[${sStep}] ${who}  ` +
    `${paintSimple(act, act.toLowerCase())} ${paintSimple(out, out.toLowerCase())} ${amountHuman} ` +
    `| Q ${paintSimple("YES", "yes")} ${fmtNum(quotesYes,5)} ${paintSimple("NO", "no")} ${fmtNum(quotesNo,5)} ` +
    `| ${paintSimple("Vault", "vault")} ${paintSimple(fmtUsdHuman(vaultHuman), "vault")} ` +
    `| ${paintSimple("Inv Y/N", "inv")} ${paintSimple(invY, "inv")} / ${paintSimple(invN, "inv")} ` +
    `| ${paintSimple("Fees", "fees")} $${paintSimple(fmtNum(feesH,decimals), "fees")}` +
    (btcStr4 ? ` | ${paintSimple(`BTC $${btcStr4}`,"btc")}` : "") +
    (timeStr ? ` | ${C.k(timeStr)}` : "");

  console.log(line);
}

function printJSONL(obj){
  if (!JSONL) return;
  try { process.stdout.write(JSON.stringify(obj)+"\n"); } catch(_){}
}

/* ---------------- Globals for banner BTC (JS-decoded) ---------------- */
let RUN_START_BTC_E6 = null; // BigInt (USD * 1e6)
let RUN_START_TS = null;     // Number (unix)

/* Core trading step with accounting + mode-aware logging */
async function tradeWithAccounting(conn, payer, whoLabel, stepNo, side, action, amountScaled, ledger, btcStr4, timeStr){
  const amm = await ammPda();

  // BEFORE
  const stBefore = await fetchAmmState(conn, amm);
  const vfBefore = { v: stBefore.vault, f: stBefore.fees };
  const dec = stBefore.decimals;

  // Execute
  await ixTrade(conn, payer, side, action, amountScaled);

  // AFTER
  const stAfter = await fetchAmmState(conn, amm);
  const vfAfter = { v: stAfter.vault, f: stAfter.fees };

  // Accounting (scaled): Δ(v+f)
  const delta = (vfAfter.v + vfAfter.f) - (vfBefore.v + vfBefore.f);
  const k = payer.publicKey.toBase58();
  if (!ledger[k]) ledger[k] = { spent:0, received:0 };
  if (delta > 0) ledger[k].spent    += delta;
  else if (delta < 0) ledger[k].received += (-delta);

  // Quotes after the trade
  const q = quotesFromState(stAfter);

  logSimpleTradeLine({
    step: stepNo, user: whoLabel, side, action, amountScaled, decimals: dec,
    quotesYes: q.yes, quotesNo: q.no,
    vaultScaled: stAfter.vault, invYesScaled: stAfter.qY, invNoScaled: stAfter.qN, feesScaled: stAfter.fees,
    btcStr4, timeStr
  });

  printJSONL({
    type: "trade", step: stepNo, user: whoLabel,
    side: (side===1?"YES":"NO"), action: (action===1?"BUY":"SELL"),
    amount_scaled: amountScaled, decimals: dec, quotes: { yes: q.yes, no: q.no },
    vault_scaled: stAfter.vault, inv_scaled: { yes: stAfter.qY, no: stAfter.qN }, fees_scaled: stAfter.fees, ts: Date.now()
  });
}

/* ---------------- Orchestrations ---------------- */
function parseRunFlags(argv){
  const out = {
    mode: "mixed", steps: 600, cadence: 250,
    minUsd: 5, maxUsd: 200,
    aYesProb: 0.58, bNoProb: 0.62,
    sellProb: 0.35, sellFrac: 0.33,
    winner: "auto", onClosed: "skip", reinitFeeBps: 25, forceReinit: "false",
    geWinsYes: true, // YES wins on tie by default
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
    else if (k==="--oracle") { try { ORACLE_STATE = new PublicKey(argv[++i]); } catch(_) {} }
    else if (k==="--gt-wins-yes") out.geWinsYes = false; // strict >
  }
  return out;
}

function chooseSide(mode, price, biasA, biasB, who){
  if (mode==="trend")      return Math.random() < (price>=0.5?0.65:0.35) ? 1:2;
  if (mode==="meanrevert") return Math.random() < (price>=0.5?0.35:0.65) ? 1:2;
  if (mode==="random")     return Math.random()<0.5?1:2;
  return (price >= 0.5) ? 1 : 2;
}

async function ensureOpenMarket(conn, admin, payersUniq, opts){
  FEE_DEST_GLOBAL = getFeeDest(admin.publicKey);

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

async function runLoop(conn, payers, opts){
  const uniq = dedupePayers(payers);
  await ensureOpenMarket(conn, payers[0], uniq, opts);

  // Snapshot at run begin (if oracle provided & missing), then cache JS BTC for banner
  if (ORACLE_STATE) {
    const st = await fetchAmmState(conn, await ammPda());
    if (st.status === 0 && st.startPrice === 0) {
      await ixSnapshotStart(conn, payers[0], ORACLE_STATE);
      if (SIMPLE && !QUIET) console.log(C.c("📸 start snapshot taken from oracle"));
      const ob0 = await fetchOracleBTC(conn, ORACLE_STATE);
      RUN_START_BTC_E6 = ob0.price_e6;
      RUN_START_TS = Math.floor(Date.now()/1000);
      if (SIMPLE && !QUIET) console.log(`📸 snapshot(js) BTC $${fmtE6To4(RUN_START_BTC_E6)}`);
    } else {
      // If already snapshotted, seed cache best-effort
      if (RUN_START_BTC_E6 === null) {
        try {
          const ob0 = await fetchOracleBTC(conn, ORACLE_STATE);
          RUN_START_BTC_E6 = ob0.price_e6;
          RUN_START_TS = Math.floor(Date.now()/1000);
        } catch(_) {}
      }
    }
  }

  // Per-user cashflow ledger (scaled ints)
  const ledger = {};

  for (let step = 1; step <= opts.steps; step++) {
    const amm = await ammPda();
    let stStep = await fetchAmmState(conn, amm);
    let priceYes = quotesFromState(stStep).yes;

    // Fetch BTC once per step (reuse across users)
    let btcStr4 = "", timeStr = nowISO();
    if (ORACLE_STATE) {
      try {
        const ob = await fetchOracleBTC(conn, ORACLE_STATE);
        btcStr4 = fmtE6To4(ob.price_e6);
      } catch(_) {}
    }

    for (let i = 0; i < payers.length; i++) {
      const p = payers[i];
      const who = whoKeyByIndex(i);
      const label = userLabelByIndex(i);

      // refresh light
      stStep = await fetchAmmState(conn, amm);
      priceYes = quotesFromState(stStep).yes;

      const doSell = Math.random() < opts.sellProb;

      if (doSell) {
        const posPk = posPda(p.publicKey, amm);
        const info = await conn.getAccountInfo(posPk,"processed");
        let yes=0, no=0;
        if (info && info.data && info.data.length>=8+32+8+8){
          const buf = info.data.subarray(8); let o=0; o+=32;
          yes = Number(buf.readBigInt64LE(o)); o+=8;
          no  = Number(buf.readBigInt64LE(o)); o+=8;
          yes = Math.max(0,yes); no = Math.max(0,no);
        }
        const side = (yes > 0 && no > 0)
          ? (Math.random() < 0.5 ? 1 : 2)
          : (yes > 0 ? 1 : (no > 0 ? 2 : (priceYes > 0.5 ? 1 : 2)));
        const inv = side === 1 ? yes : no;
        if (inv > 0) {
          const sh = Math.max(1, Math.floor(inv * opts.sellFrac));
          await tradeWithAccounting(conn, p, label, step, side, 2, sh, ledger, btcStr4, timeStr);
        }
      } else {
        let side;
        if (who === "A")       side = Math.random() < opts.aYesProb ? 1 : 2;
        else if (who === "B")  side = Math.random() < opts.bNoProb ? 2 : 1;
        else                   side = chooseSide(opts.mode, priceYes, opts.aYesProb, opts.bNoProb, who);
        const usd = Math.max(opts.minUsd, Math.random() * (opts.maxUsd - opts.minUsd) + opts.minUsd);
        await tradeWithAccounting(conn, p, label, step, side, 1, toScaled(usd, stStep.decimals), ledger, btcStr4, timeStr);
      }

      if (i < payers.length - 1) await sleep(opts.cadence);
    }

    if (VERBOSE && step % 50 === 0) await logState(conn, `after step ${step}`);
  }

  // ----- settlement & redeem -----
  const stBeforeStop = await fetchAmmState(conn, await ammPda());
  sep(`STOP & SETTLE`);

  await ixStop(conn, payers[0]); // any signer

  let winner = 0;
  let startDisplay = "—", currDisplay = "—", elapsed = null;

  if (ORACLE_STATE) {
    // On-chain settlement (>= rule by default)
    await ixSettleByOracle(conn, payers[0], ORACLE_STATE, opts.geWinsYes);

    // For DISPLAY ONLY, read both prices via the same JS oracle decoder
    if (RUN_START_BTC_E6 != null) {
      startDisplay = fmtE6To4(RUN_START_BTC_E6);
    } else {
      const stTmp = await fetchAmmState(conn, await ammPda());
      startDisplay = fmtE6To4(BigInt(stTmp.startPrice)); // fallback
    }
    const obNow = await fetchOracleBTC(conn, ORACLE_STATE);
    currDisplay = fmtE6To4(obNow.price_e6);

    // Winner & elapsed from on-chain state
    const stSet = await fetchAmmState(conn, await ammPda());
    winner = stSet.winner;
    elapsed = (stSet.startTs>0 && stSet.settleTs>0) ? Math.max(0, stSet.settleTs - stSet.startTs) : null;

    const dir = (obNow.price_e6 >= (RUN_START_BTC_E6 ?? BigInt(stSet.startPrice))) ? C.g("HIGHER") : C.r("LOWER");
    console.log(
      `[#] RESOLVE winner=${(winner===1?"YES":"NO")} `
    + `| BTC ${startDisplay} -> ${currDisplay} (${dir}) `
    + `| rule=${opts.geWinsYes?">=":">"} `
    + `| open ${elapsed!=null?fmtDur(elapsed):"0:00"}`
    );

    printJSONL({
      type:"resolve",
      mode:"oracle",
      winner: (winner===1?"YES":"NO"),
      start_price_e6_display: startDisplay,
      settle_price_e6_display: currDisplay,
      rule: opts.geWinsYes?">=":">",
      elapsed_secs: elapsed,
      ts: Date.now()
    });

  } else {
    // No oracle: fallback inventory winner
    const stInv = await fetchAmmState(conn, await ammPda());
    const invWinner = (stInv.qY>=stInv.qN?1:2);
    await ixSettle(conn, payers[0], invWinner);
    winner = invWinner;
  }

  const stSet = await fetchAmmState(conn, await ammPda());
  const dec = stSet.decimals;

  sep(C.bold("REDEEM ALL"));

  const uniqPayers = dedupePayers(payers);
  const paidRows = [];
  const tagOf = (p)=>p.publicKey.toBase58().slice(0,4);
  let vaultCursor = stSet.vault;

  for (const p of uniqPayers){
    const tag = tagOf(p);
    const amm = await ammPda();
    const posPk = posPda(p.publicKey, amm);
    const info = await conn.getAccountInfo(posPk,"processed");
    let yes=0, no=0;
    if (info && info.data && info.data.length>=8+32+8+8){
      const buf = info.data.subarray(8); let o=0; o+=32;
      yes = Number(buf.readBigInt64LE(o)); o+=8;
      no  = Number(buf.readBigInt64LE(o)); o+=8;
      yes = Math.max(0,yes); no = Math.max(0,no);
    }
    const win = winner===1 ? yes : no;

    if (win > 0) {
      await ixRedeem(conn, p);
      await sleep(60);
      const now = await fetchAmmState(conn, await ammPda());
      const paid = vaultCursor - now.vault;
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

  // >>> NEW: print total YES / NO held (qY / qN at settlement) <<<
  console.log(`${C.bold("Total YES shares held")}: ${C.y(fmtScaled(stSet.qY, dec))} ${C.k("sh")}`);
  console.log(`${C.bold("Total NO shares  held")}: ${C.y(fmtScaled(stSet.qN, dec))} ${C.k("sh")}`);

  // Per-user totals
  const byTag = {};
  for (const p of uniqPayers){
    const k = p.publicKey.toBase58();
    const tag = k.slice(0,4);
    const flows = ledger[k] || { spent:0, received:0 };
    byTag[tag] = { spent: flows.spent, received: flows.received, payout: 0, win: 0 };
  }
  for (const r of paidRows){
    if (!byTag[r.tag]) byTag[r.tag] = { spent:0, received:0, payout:0, win:0 };
    byTag[r.tag].payout = r.paid;
    byTag[r.tag].win    = r.win;
  }

  let totSpent = 0n, totRecv = 0n, totPayout = 0n;
  for (const tag of Object.keys(byTag).sort()){
    const u = byTag[tag];
    const pnl = (u.payout + u.received) - u.spent;
    totSpent   += BigInt(u.spent);
    totRecv    += BigInt(u.received);
    totPayout  += BigInt(u.payout);

    console.log(
      `User ${C.bold(tag)} `
    + `winning_sh=${C.y(fmtScaled(u.win,dec))} ${C.k("sh")}   `
    + `spent=$${C.c(fmtScaled(u.spent,dec))}  `
    + `received=$${C.c(fmtScaled(u.received,dec))}  `
    + `payout=$${C.g(C.bold(fmtScaled(u.payout,dec)))}   `
    + `PNL=${(pnl>=0?C.g:C.r)(C.bold("$"+fmtScaled(pnl,dec)))}`
    );
  }

  const totSpentNum   = Number(totSpent);
  const totRecvNum    = Number(totRecv);
  const totPayoutNum  = Number(totPayout);
  const grandInSOL    = e6ToSOL(totSpentNum);
  const grandOutSOL   = e6ToSOL(totRecvNum + totPayoutNum);

  console.log("");
  console.log(C.bold("GRAND TOTALS (debits/credits to user accounts):"));
  console.log(`ΣSpent (debits):    $${fmtScaled(totSpentNum, dec)}  |  ${fmtSOL(grandInSOL)}`);
  console.log(`ΣCredits (sells):   $${fmtScaled(totRecvNum,  dec)}  |  ${fmtSOL(e6ToSOL(totRecvNum))}`);
  console.log(`ΣPayouts (redeem):  $${fmtScaled(totPayoutNum,dec)}  |  ${fmtSOL(e6ToSOL(totPayoutNum))}`);
  console.log(C.bold(`ΣCredits+Payouts: $${fmtScaled(totRecvNum+totPayoutNum, dec)}  |  ${fmtSOL(grandOutSOL)}`));

  console.log(`On-chain sum payouts: $${C.g(fmtScaled(onChainSum, dec))}`);
  console.log(`Actual drop:          $${C.g(fmtScaled(vaultDrop, dec))}`);

  printJSONL({
    type:"final",
    winner: (winner===1?"YES":"NO"),
    onchain_sum_payouts_scaled: onChainSum,
    actual_vault_drop_scaled: vaultDrop,
    equal: (vaultDrop === onChainSum),
    decimals: dec,
    start_price_display: startDisplay,
    settle_price_display: currDisplay,
    total_yes_shares_scaled: stSet.qY,   // <<< NEW
    total_no_shares_scaled:  stSet.qN,   // <<< NEW
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

  // optional oracle flag at top level
  for (let i=0;i<rest.length;i++){ if (rest[i]==="--oracle"){ try{ ORACLE_STATE=new PublicKey(rest[i+1]); }catch(_){} } }

  if (!cmd || cmd==="help" || cmd==="--help" || cmd==="-h"){
    console.log(`Usage:
  node app/trade.js init [bShares] [feeBps]
  node app/trade.js init-pos
  node app/trade.js buy  yes|no <USD>
  node app/trade.js sell yes|no <SHARES>
  node app/trade.js stop
  node app/trade.js settle yes|no
  node app/trade.js settle-by-oracle [--oracle <pubkey>] [--gt-wins-yes]
  node app/trade.js snapshot-start --oracle <pubkey>
  node app/trade.js redeem
  node app/trade.js close
  node app/trade.js run  --wallets a.json[,b.json[,c.json[,d.json[,e.json]]]] [--mode random|trend|meanrevert|mixed] [--steps 600] \\
                         [--cadence 250] [--min-usd 5] [--max-usd 200] [--a-yes-prob 0.58] [--b-no-prob 0.62] \\
                         [--sell-prob 0.35] [--sell-frac 0.33] [--winner auto|yes|no] [--on-closed skip|reinit] [--reinit-fee-bps 25] \\
                         [--force-reinit true|false] [--oracle <pubkey>] [--gt-wins-yes] [--color|--no-color] [--simple|-S] [--jsonl] [--quiet] [--audit]
Flags: --pretty, --verbose|-v
Env:   FEE_DEST=<pubkey>     (optional; default is init admin)
       ORACLE_STATE=<pubkey> (optional; enables BTC snapshot/settlement)`);
    process.exit(0);
  }

  try{
    if (cmd==="init"){
      const b=parseFloat(rest[0]||"500000");
      const f=parseInt(rest[1]||"25",10);
      await ixInitAmm(conn, payer, b, f);
      return;
    }
    if (cmd==="init-pos"){ await ixInitPos(conn, payer); return; }
    if (cmd==="stop"){ await ixStop(conn, payer); return; }
    if (cmd==="settle"){ const w=(rest[0]||"").toLowerCase()==="yes"?1:2; await ixSettle(conn, payer, w); return; }
    if (cmd==="settle-by-oracle"){
      if (!ORACLE_STATE) { console.error("settle-by-oracle requires --oracle <pubkey> or ORACLE_STATE env"); process.exit(1); }
      const geWinsYes = !hasFlag("--gt-wins-yes");
      await ixSettleByOracle(conn, payer, ORACLE_STATE, geWinsYes);
      return;
    }
    if (cmd==="snapshot-start"){
      if (!ORACLE_STATE) { console.error("snapshot-start requires --oracle <pubkey> or ORACLE_STATE env"); process.exit(1); }
      await ixSnapshotStart(conn, payer, ORACLE_STATE);
      return;
    }
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

      if (wallets.length === 0) {
        console.warn(C.k("run: --wallets not provided; using default wallet twice"));
        payers = [payer, payer];
      } else {
        if (wallets.length > 5) {
          console.warn(C.k(`run: more than 5 wallets provided; using first 5`));
        }
        payers = wallets.slice(0,5).map(p => {
          try { return readKeypair(p); }
          catch(e){ console.error(C.r(`Failed to read wallet ${p}: ${e.message}`)); process.exit(1); }
        });
      }

      for (const p of dedupePayers(payers)) await ixInitPos(conn, p);
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

