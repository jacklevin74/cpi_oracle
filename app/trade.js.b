#!/usr/bin/env node
// app/trade.js — SOL-flow AMM client (up to 5 users), exact PnL, totals.
// Program uses a system-owned SOL vault PDA ([b"vault_sol", amm]).
// Modes: --simple|-S (colored), --jsonl, --quiet, --audit.

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
const PID         = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const AMM_SEED    = Buffer.from("amm_btc_v2");
const POS_SEED    = Buffer.from("pos");
const VAULT_SOL_SEED = Buffer.from("vault_sol");

// Must match the on-chain LAMPORTS_PER_E6 for correct SOL reporting
const LAMPORTS_PER_E6 = 1; // 1 lamport per credit-million


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

// e6 <-> SOL helpers: 1e6 credits = (LAMPORTS_PER_E6) lamports
function e6ToSOL(e6){ return (Number(e6) * LAMPORTS_PER_E6) / 1e9; }
function fmtSOL(sol){ return `${sol.toFixed(6)} SOL`; }


// Labels for up to 5 users
function userLabelByIndex(i){ return `User${String.fromCharCode(65 + i)}`; } // 0->A ... 4->E
function whoKeyByIndex(i){ return String.fromCharCode(65 + i); }            // "A".."E"

/* ---------------- PDAs + Disc ---------------- */
async function ammPda(){ return PublicKey.findProgramAddressSync([AMM_SEED], PID)[0]; }
function posPda(owner, amm){ return PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), owner.toBuffer()], PID)[0]; }
function vaultSolPda(amm){ return PublicKey.findProgramAddressSync([VAULT_SOL_SEED, amm.toBuffer()], PID)[0]; }

function disc(name){ return crypto.createHash("sha256").update("global:"+name).digest().subarray(0,8); }
const D_INIT_AMM = disc("init_amm");
const D_INIT_POS = disc("init_position");
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
    { pubkey: feeDest,                 isSigner:false, isWritable:true  }, // stored only
    { pubkey: vaultSol,                isSigner:false, isWritable:true  }, // create/use vault
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
    { pubkey: feeDest,                 isSigner:false, isWritable:true  },   // fee lamports (BUY)
    { pubkey: vaultSol,                isSigner:false, isWritable:true  },   // SOL vault
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
        { pubkey: amm,                     isSigner:false, isWritable:true  }, // amm
        { pubkey: payer.publicKey,         isSigner:true,  isWritable:true  }, // user
        { pubkey: pos,                     isSigner:false, isWritable:true  }, // pos
        { pubkey: feeDest,                 isSigner:false, isWritable:true  }, // fee_dest (payer for rent top-up)
        { pubkey: vaultSol,                isSigner:false, isWritable:true  }, // vault_sol
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
  // default “mixed”: mirror tilt
  return (price >= 0.5) ? 1 : 2;
}

async function ensureOpenMarket(conn, admin, payersUniq, opts){
  // Set fee dest default for this run
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

function paintSimple(s, kind){
  if (!SIMPLE_COLOR) return s;
  if (kind==="buy")  return C.g(s);
  if (kind==="sell") return C.y(s);
  if (kind==="yes")  return C.g(s);
  if (kind==="no")   return C.r(s);
  if (kind==="vault")return C.c(s);
  if (kind==="fees") return C.m(s);
  if (kind==="inv")  return C.k(s);
  return s;
}

function logSimpleTradeLine({
  step, user, side, action, amountScaled, decimals,
  quotesYes, quotesNo, vaultScaled, invYesScaled, invNoScaled, feesScaled
}){
  if (QUIET) return;
  if (!SIMPLE) return;

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
    `[${sStep}] ${who} ` +
    `${paintSimple(act, act.toLowerCase())} ${paintSimple(out, out.toLowerCase())} ${amountHuman} ` +
    `| Q ${paintSimple("YES", "yes")} ${fmtNum(quotesYes,5)} ${paintSimple("NO", "no")} ${fmtNum(quotesNo,5)} ` +
    `| ${paintSimple("Vault", "vault")} ${paintSimple(fmtUsdHuman(vaultHuman), "vault")} ` +
    `| ${paintSimple("Inv Y/N", "inv")} ${paintSimple(invY, "inv")} / ${paintSimple(invN, "inv")} ` +
    `| ${paintSimple("Fees", "fees")} $${paintSimple(fmtNum(feesH,decimals), "fees")}`;

  console.log(line);
}

function logEventSimple(kind, payload = {}){
  if (QUIET) return;
  if (!SIMPLE) return;
  if (kind === "resolve") {
    const { winner, vaultBeforeScaled, vaultAfterScaled, sumPayoutScaled, feesScaled, decimals } = payload;
    const msg =
      `[#] RESOLVE winner=${(winner||"—").toUpperCase()} | ` +
      `Vault $${fmtScaled(vaultBeforeScaled,decimals)} → $${fmtScaled(vaultAfterScaled,decimals)} ` +
      (sumPayoutScaled!=null ? `| Payouts $${fmtScaled(sumPayoutScaled,decimals)} ` : "") +
      (feesScaled!=null ? `| Fees $${fmtScaled(feesScaled,decimals)}` : "");
    console.log(msg);
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

  // Accounting (scaled): Δ(v+f). If >0 user spent; if <0 user received.
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
    vaultScaled: stAfter.vault, invYesScaled: stAfter.qY, invNoScaled: stAfter.qN, feesScaled: stAfter.fees
  });

  printJSONL({
    type: "trade", step: stepNo, user: whoLabel,
    side: (side===1?"YES":"NO"), action: (action===1?"BUY":"SELL"),
    amount_scaled: amountScaled, decimals: dec, quotes: { yes: q.yes, no: q.no },
    vault_scaled: stAfter.vault, inv_scaled: { yes: stAfter.qY, no: stAfter.qN }, fees_scaled: stAfter.fees, ts: Date.now()
  });
}

async function runLoop(conn, payers, opts){
  const uniq = dedupePayers(payers);
  await ensureOpenMarket(conn, payers[0], uniq, opts);

  // Per-user cashflow ledger (scaled ints); key = base58
  const ledger = {}; // {spent, received}

  for (let step = 1; step <= opts.steps; step++) {
    // refresh state at step start
    let stStep = await fetchAmmState(conn, await ammPda());
    let priceYes = quotesFromState(stStep).yes;

    for (let i = 0; i < payers.length; i++) {
      const p = payers[i];
      const who = whoKeyByIndex(i);
      const label = userLabelByIndex(i);

      // light refresh before each user so decisions react
      stStep = await fetchAmmState(conn, await ammPda());
      priceYes = quotesFromState(stStep).yes;

      const doSell = Math.random() < opts.sellProb;

      if (doSell) {
        const pos = await readUserPos(conn, p.publicKey);
        const side = (pos.yes > 0 && pos.no > 0)
          ? (Math.random() < 0.5 ? 1 : 2)
          : (pos.yes > 0 ? 1 : (pos.no > 0 ? 2 : (priceYes > 0.5 ? 1 : 2)));
        const inv = side === 1 ? pos.yes : pos.no;
        if (inv > 0) {
          const sh = Math.max(1, Math.floor(inv * opts.sellFrac));
          await tradeWithAccounting(conn, p, label, step, side, 2, sh, ledger);
        }
      } else {
        let side;
        if (who === "A")       side = Math.random() < opts.aYesProb ? 1 : 2;
        else if (who === "B")  side = Math.random() < opts.bNoProb ? 2 : 1;
        else                   side = chooseSide(opts.mode, priceYes, opts.aYesProb, opts.bNoProb, who);
        const usd = Math.max(opts.minUsd, Math.random() * (opts.maxUsd - opts.minUsd) + opts.minUsd);
        await tradeWithAccounting(conn, p, label, step, side, 1, toScaled(usd, stStep.decimals), ledger);
      }

      if (i < payers.length - 1) await sleep(opts.cadence);
    }

    if (VERBOSE && step % 50 === 0) await logState(conn, `after step ${step}`);
  }

  // ----- settlement & redeem -----
  const st = await fetchAmmState(conn, await ammPda());
  const winner = (opts.winner==="yes")?1:(opts.winner==="no")?2: (st.qY>=st.qN?1:2);

  sep(`STOP & SETTLE (${winner===1?C.g("YES"):C.y("NO")})`);
  await ixStop(conn, payers[0]);               // any signer; use first
  await ixSettle(conn, payers[0], winner);

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

  const uniqPayers = uniq;
  const paidRows = []; // { tag, paid, win }
  const tagOf = (p)=>p.publicKey.toBase58().slice(0,4);
  let vaultCursor = stSet.vault;

  for (const p of uniqPayers){
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

  // ----- Build per-user totals -----
  const byTag = {};
  for (const p of uniqPayers){
    const k = p.publicKey.toBase58();
    const tag = k.slice(0,4);
    const flows = ledger[k] || { spent:0, received:0 };
    byTag[tag] = {
      spent: flows.spent,              // debits during trades (BUY net+fee)
      received: flows.received,        // credits during trades (SELL proceeds)
      payout: 0,                       // credits from redeem
      win: 0
    };
  }
  for (const r of paidRows){
    if (!byTag[r.tag]) byTag[r.tag] = { spent:0, received:0, payout:0, win:0 };
    byTag[r.tag].payout = r.paid;
    byTag[r.tag].win    = r.win;
  }

  // Per-user print (and accumulate totals)
  let totSpent = 0n, totRecv = 0n, totPayout = 0n;
  for (const tag of Object.keys(byTag).sort()){
    const u = byTag[tag];
    const pnl = (u.payout + u.received) - u.spent; // scaled
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

  // GRAND TOTALS (credits = e6; SOL = e6/1e6)
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
    totals: {
      spent_scaled: totSpentNum,
      received_scaled: totRecvNum,
      payouts_scaled: totPayoutNum
    },
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
  node app/trade.js run  --wallets a.json[,b.json[,c.json[,d.json[,e.json]]]] [--mode random|trend|meanrevert|mixed] [--steps 600] \\
                         [--cadence 250] [--min-usd 5] [--max-usd 200] [--a-yes-prob 0.58] [--b-no-prob 0.62] \\
                         [--sell-prob 0.35] [--sell-frac 0.33] [--winner auto|yes|no] [--on-closed skip|reinit] [--reinit-fee-bps 25] \\
                         [--force-reinit true|false] [--color|--no-color] [--simple|-S] [--jsonl] [--quiet] [--audit]
Flags: --pretty, --verbose|-v
Env:   FEE_DEST=<pubkey>  (optional; default is init admin)`);
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
        // If only one wallet provided and you still want at least two traders:
        // if (payers.length === 1) payers.push(payers[0]);
      }

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

