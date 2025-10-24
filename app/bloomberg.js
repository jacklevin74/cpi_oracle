#!/usr/bin/env node
/**
 * app/bloomberg.js — Matrix HUD for BTC oracle + coverage-LMSR AMM
 *
 * Keys:
 *   m toggle BEAR/BULL, r toggle RANDOM-BUYS,
 *   1 BUY YES (on-chain), 2 BUY NO (on-chain),
 *   s STOP local auto-buys, g START local auto-buys,
 *   x STOP⛓ (on-chain), y SETTLE YES⛓, n SETTLE NO⛓, d REDEEM⛓,
 *   o CLOSE (shell), i INIT (shell), z SMART REINIT (CLOSE→INIT if settled),
 *   p INIT POSITION (on-chain), k local reset (clear tape/vol/last line/logs), q quit / Ctrl+C quit
 *
 * Flags: --cadence MS (default 900), --usd USD per trade (default 120)
 */

const fs = require("fs");
const crypto = require("crypto");
const { exec } = require("child_process");
const {
  Connection, PublicKey, Keypair,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram,
} = require("@solana/web3.js");

/* ====== CONFIG ====== */
const RPC    = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

// IMPORTANT: set to your current deployed program id
const PID = new PublicKey("7h22sUva8ntjjsoa858Qx6Kxg92JoLH8ryiPgGTXm4ja");

const ORACLE_PID = new PublicKey("7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE");
const AMM_SEED    = Buffer.from("amm_btc");
const POS_SEED    = Buffer.from("pos");
const ORACLE_SEED = Buffer.from("state_v2");

const CU_LIMIT = 800_000;
const CU_PRICE = 1;

// External lifecycle commands (override with env)
const CLOSE_CMD = process.env.BLOOM_CLOSE_CMD || "node app/trade.js close";
const INIT_CMD  = process.env.BLOOM_INIT_CMD  || "node app/trade.js init";

/* ====== CLI ====== */
const argv = process.argv.slice(2);
function flag(name, def){ const i=argv.indexOf("--"+name); return (i>=0 && i+1<argv.length) ? argv[i+1] : def; }
const CADENCE = Math.max(200, parseInt(flag("cadence","900"),10));
const USD     = Math.max(1,   parseFloat(flag("usd","120")));

/* ====== VT100 ====== */
const ESC="\x1b", CSI=ESC+"[";
const ALT_ON=CSI+"?1049h", ALT_OFF=CSI+"?1049l";
const HIDE=CSI+"?25l", SHOW=CSI+"0m"+CSI+"?25h";
const GREEN=CSI+"32m", RESET=CSI+"0m", BOLD=CSI+"1m", DIM=CSI+"2m", UL=CSI+"4m";
function put(r,c,s){ process.stdout.write(CSI+r+";"+c+"H"+s + CSI+"0K"); }
function enter(){ process.stdout.write(ALT_ON+HIDE+GREEN); }
function leave(){ process.stdout.write(RESET+SHOW+ALT_OFF); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

/* ====== Fail-fast helpers ====== */
function formatSimError(e){
  return JSON.stringify({
    message: e?.message || String(e),
    logs: e?.logs || e?.simulationResponse?.logs || null,
    simulationResponse: e?.simulationResponse || null,
    signature: e?.signature || null,
    name: e?.name || null,
    stack: e?.stack || null,
  }, null, 2);
}
function die(err){
  try { leave(); } catch {}
  if (err) {
    console.error("\n--- TX/PROGRAM ERROR ---");
    if (typeof err === "string") console.error(err);
    else console.error(formatSimError(err));
  }
  process.exit(1);
}

/* ====== Discriminators & seeds ====== */
function anchorDiscriminator(name) {
  const preimage = Buffer.from("account:" + name);
  const hash = crypto.createHash("sha256").update(preimage).digest();
  return hash.subarray(0, 8);
}

function disc(n){ return crypto.createHash("sha256").update("global:"+n).digest().subarray(0,8); }
const DISC_TRADE       = disc("trade");
const DISC_INIT_POS    = disc("init_position");
const DISC_STOP_MKT    = disc("stop_market");
const DISC_SETTLE_MKT  = disc("settle_market");
const DISC_REDEEM      = disc("redeem");

function u8(n){ const b=Buffer.alloc(1); b.writeUInt8(n); return b; }
function i64le(n){ let x=BigInt(n); if(x<0n) x=(1n<<64n)+x; const b=Buffer.alloc(8); b.writeBigUInt64LE(x); return b; }
function toScaled(x,dp=6){ return Math.round(Number(x)*10**dp); }
function fmtUSD(x){ return Number(x).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2}); }
function fmtSh(x){  return Number(x).toLocaleString(undefined,{minimumFractionDigits:3, maximumFractionDigits:3}); }
function fmtInt(x){ return Number(Math.round(x)).toLocaleString(); }
function usdHuman(micro){ const v = micro/1_000_000; return (v>=0? "$"+fmtUSD(v) : "-$"+fmtUSD(Math.abs(v))); }

async function ammPda(){ return PublicKey.findProgramAddressSync([AMM_SEED], PID)[0]; }
function posPda(owner){ return PublicKey.findProgramAddressSync([POS_SEED, owner.toBuffer()], PID)[0]; }
function oraclePda(){ return PublicKey.findProgramAddressSync([ORACLE_SEED], ORACLE_PID)[0]; }

function readI64LE(b,o){ const u=b.readBigInt64LE(o); return Number(u); }
function readU8(b,o){ return b.readUInt8(o); }
function readU16LE(b,o){ return b.readUInt16LE(o); }

/* ====== Pricing & depth ====== */
function pYesSafe({ qY, qN, bScaled }, lastGood){
  const b = Math.max(1, bScaled);
  const a = Math.exp(qY / b);
  const c = Math.exp(qN / b);
  const sum = a + c;
  if (!Number.isFinite(a) || !Number.isFinite(c) || sum === 0) {
    return (lastGood != null && lastGood > 0 && lastGood < 1) ? lastGood : 0.5;
  }
  return a / sum;
}
function lmsrCost(qY, qN, b){ const a=qY/b, c=qN/b, m=Math.max(a,c); return b*(m+Math.log(Math.exp(a-m)+Math.exp(c-m))); }
function sharesToReachP(pT, p0, b){ const T=Math.max(1e-12,Math.min(1-1e-12,pT)); const P=Math.max(1e-12,Math.min(1-1e-12,p0)); return b*(Math.log(T/(1-T))-Math.log(P/(1-P))); }
function usdToMoveYES(state, pTarget){ const {qY,qN,bScaled} = state; const p0=pYesSafe(state,null); const dq=sharesToReachP(pTarget,p0,bScaled); return lmsrCost(qY+dq,qN,bScaled) - lmsrCost(qY,qN,bScaled); }

/* ====== HUD logs (panel) ====== */
const MAX_LOG_LINES = 6;
let HUD_LOGS = [];
function setHudLogs(lines) { HUD_LOGS = (lines || []).slice(0, MAX_LOG_LINES); }

/* ====== TX logs: robust fetch + scoped to PID + Anchor error detect ====== */
function parseAnchorError(allLines) {
  if (!allLines) return null;
  const blob = allLines.join("\n");
  if (!/AnchorError thrown/.test(blob)) return null;
  const code = (blob.match(/Error Code:\s*([A-Za-z0-9_]+)/) || [])[1] || null;
  const num  = (blob.match(/Error Number:\s*(\d+)/) || [])[1] || null;
  const msg  = (blob.match(/Error Message:\s*(.+)/) || [])[1] || null;
  return { code, num, msg };
}

async function fetchProgramLogs(conn, sig, programIdBase58) {
  const maxTries = 20; let delay = 200; let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    try {
      const tx =
        (await conn.getTransaction(sig, { commitment: "confirmed",  maxSupportedTransactionVersion: 0 })) ||
        (await conn.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
      if (tx && tx.meta && Array.isArray(tx.meta.logMessages)) {
        const logs = tx.meta.logMessages;

        // Scope to our PID block
        const pid = programIdBase58;
        const scoped = [];
        let inside = false;
        for (const line of logs) {
          if (line.startsWith(`Program ${pid} invoke`)) { inside = true; continue; }
          if (inside && (line.startsWith(`Program ${pid} success`) || line.startsWith(`Program ${pid} failed`))) break;
          if (inside) scoped.push(line);
        }

        const all = scoped.length ? scoped : logs;
        const programLogs = all.filter(l => l.includes("Program log:")).map(l => l.replace(/^.*Program log:\s*/, ""));
        let cu = null;
        const cuLine = logs.find(l => l.includes(`Program ${pid}`) && l.includes("consumed"));
        if (cuLine) { const m = cuLine.match(/consumed\s+(\d+)/i); if (m) cu = Number(m[1]); }

        const anchorErr = parseAnchorError(all);
        return { programLogs, allLines: all, cu, err: tx.meta.err || null, anchorErr };
      }
    } catch (e) { lastErr = e; }
    await sleep(delay);
    delay = Math.min(800, Math.floor(delay * 1.5));
  }
  return { programLogs: [], allLines: [], cu: null, err: lastErr ? (lastErr.message || String(lastErr)) : null, anchorErr: null };
}

function buildHudBlock({ label, sig, lines, cu, err, ctx, note }) {
  const out = [];
  out.push(`===== ${label} LOGS ${sig ? "["+sig+"]" : ""} =====`);
  if (lines && lines.length) { for (const l of lines) out.push(`log: ${l}`); }
  else out.push("(no Program log: lines)");
  if (note && note.length) for (const n of note) out.push(n);
  if (ctx) {
    out.push(
      `ctx: status=${ctx.statusTxt} winner=${ctx.winnerTxt} ` +
      `vault=$${fmtUSD(ctx.vault/1e6)} W=${fmtSh(ctx.W/1e6)}sh pps=${(ctx.pps/1e6).toFixed(6)} ` +
      `myYES=${fmtSh(ctx.myYesSh||0)} myNO=${fmtSh(ctx.myNoSh||0)}`
    );
  }
  out.push(`status: ${err ? "ERR "+JSON.stringify(err) : "OK"}  computeUnits: ${cu ?? "n/a"}`);
  out.push("=================================");
  return out.slice(0, MAX_LOG_LINES);
}

/* ====== Robust send helper ====== */
async function sendTx(conn, tx, signers, label){
  try {
    if (!tx.feePayer && signers && signers[0]) tx.feePayer = signers[0].publicKey;
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { skipPreflight:false, commitment:"processed" });

    const fetched = await fetchProgramLogs(conn, sig, PID.toBase58());

    // Console block (single, clean)
    console.error(`\n===== ${label} LOGS [${sig}] =====`);
    if (fetched.programLogs.length) for (const line of fetched.programLogs) console.error("log:", line);
    else console.error("(no Program log: lines)");
    console.error(`status: ${fetched.err ? "ERR "+JSON.stringify(fetched.err) : "OK"}  computeUnits: ${fetched.cu ?? "n/a"}`);
    console.error("=================================\n");

    // Build HUD block with live context
    const amm = await ammPda();
    const [s, posRaw] = await Promise.all([fetchAmmState(conn, amm), fetchPosition(conn, signers[0].publicKey)]);
    const statusTxt = s.status===0 ? "OPEN" : s.status===1 ? "STOPPED" : "SETTLED";
    const winnerTxt = s.winner===0 ? "-" : s.winner===1 ? "YES" : "NO";

    let note = [];
    if (label === "REDEEM" && fetched.anchorErr) {
      const { code, num, msg } = fetched.anchorErr;
      const isNoCoverage = (code === "NoCoverage" || num === "6008" || /insufficient coverage/i.test(msg || ""));
      if (isNoCoverage) {
        const winMicro = (s.winner===1) ? posRaw.yes : posRaw.no;
        const needMicro = Number((BigInt(winMicro) * BigInt(s.pps)) / 1_000_000n);
        note = [
          `explain: AnchorError NoCoverage(${num||"6008"}) — ${msg || "insufficient coverage in vault"}`,
          `reason: expected payout=${usdHuman(needMicro)} vs vault=${usdHuman(s.vault)}`
        ];
        if ((s.winner===2 && posRaw.yes > posRaw.no) || (s.winner===1 && posRaw.no > posRaw.yes)) {
          note.push(`hint: possible wrong-side selection in on-chain redeem (paying loser side).`);
        }
      }
    }
    setHudLogs(buildHudBlock({
      label, sig,
      lines: fetched.programLogs,
      cu: fetched.cu,
      err: fetched.err,
      ctx: { statusTxt, winnerTxt, vault: s.vault, W: s.wTotal, pps: s.pps, myYesSh: posRaw.yesSh, myNoSh: posRaw.noSh },
      note,
    }));

    return sig;
  } catch (e) { die(e); }
}
function budgetIxs(units=CU_LIMIT, microLamports=CU_PRICE){
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

/* ====== Parsers ====== */
// Amm layout: 62 bytes after 8-byte disc
// bump u8 | dec u8 | b i64 | fee u16 | qY i64 | qN i64 | fees i64 | vault i64 | status u8 | winner u8 | w_total i64 | pps i64
async function fetchAmmState(conn, pda){
  const info = await conn.getAccountInfo(pda, "processed");
  if (!info) throw new Error("AMM account not found");
  const d = info.data; if (!d || d.length < 8 + 62) throw new Error("AMM account too small");
  const p = d.subarray(8);
  let o=0;
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

// Position: [8] discr | owner[32] | yes i64 | no i64 (SIGNED, micro-shares)
async function fetchPosition(conn, owner) {
  const [posPk] = PublicKey.findProgramAddressSync([POS_SEED, owner.toBuffer()], PID);
  const info = await conn.getAccountInfo(posPk, "processed");

  if (!info) {
    return { pubkey: posPk, ok: false, why: "missing", ownerOk: false, yes:0, no:0, yesSh:0, noSh:0 };
  }
  if (!info.data || info.data.length < 8 + 32 + 8 + 8) {
    return { pubkey: posPk, ok: false, why: `too_small:${info.data?.length ?? 0}`, ownerOk: false, yes:0, no:0, yesSh:0, noSh:0 };
  }

  const want = anchorDiscriminator("Position");
  const have = info.data.subarray(0, 8);
  if (!have.equals(want)) {
    return { pubkey: posPk, ok: false, why: "bad_discriminator", ownerOk: false, yes:0, no:0, yesSh:0, noSh:0 };
  }

  const p = info.data.subarray(8);
  let o = 0;

  // Owner must match wallet
  const ownerOnChain = new PublicKey(p.subarray(o, o + 32)); o += 32;
  const ownerOk = ownerOnChain.equals(owner);
  if (!ownerOk) {
    return { pubkey: posPk, ok: false, why: `wrong_owner:${ownerOnChain.toBase58()}`, ownerOk: false, yes:0, no:0, yesSh:0, noSh:0 };
  }

  const yes = Number(p.readBigInt64LE(o)); o += 8;
  const no  = Number(p.readBigInt64LE(o)); o += 8;

  const yesClamped = Math.max(0, yes);
  const noClamped  = Math.max(0, no);

  return {
    pubkey: posPk,
    ok: true,
    why: null,
    ownerOk: true,
    yes: yesClamped,
    no:  noClamped,
    yesSh: yesClamped / 1e6,
    noSh:  noClamped / 1e6,
  };
}

// Oracle (optional)
async function fetchOracleBTC(conn){
  const info = await conn.getAccountInfo(oraclePda(), "processed");
  if (!info) return NaN;
  const p = info.data.subarray(8);
  let o=0; o+=32;
  const p1=p.readBigInt64LE(o+0), p2=p.readBigInt64LE(o+8), p3=p.readBigInt64LE(o+16);
  o += 48 + 48 + 48;
  const dec=p.readUInt8(o);
  const vals=[p1,p2,p3].filter(x=>x!==0n);
  return vals.length ? Number((vals.reduce((a,b)=>a+b,0n)/BigInt(vals.length))) / 10**dec : NaN;
}

/* ====== Ensure Position exists (on current PID) ====== */
async function ensurePosition(conn, payer){
  const posPk = posPda(payer.publicKey);
  const info = await conn.getAccountInfo(posPk, "processed");
  if (info) return;
  const keys = [
    { pubkey: posPk, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_INIT_POS) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  tx.feePayer = payer.publicKey;
  await sendTx(conn, tx, [payer], "INIT_POSITION");
}

/* ====== Signature/account waiter ====== */
async function waitForAccountAfterSig(conn, accountPubkey, signature, opts = {}) {
  const commitment = opts.commitment ?? "confirmed";
  const timeoutMs  = opts.timeoutMs ?? 45_000;
  const pollMs     = opts.pollMs ?? 400;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const st = value?.[0];
    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    await sleep(pollMs);
  }
  let lastSlot = 0;
  while (Date.now() - start < timeoutMs) {
    const [info, slot] = await Promise.all([
      conn.getAccountInfo(accountPubkey, commitment),
      conn.getSlot(commitment),
    ]);
    if (info && slot > lastSlot) return { status: "ok", accountInfo: info };
    lastSlot = slot;
    await sleep(pollMs);
  }
  return { status: "timeout", accountInfo: null };
}

/* ====== Preflight REDEEM (strict reasons) ====== */
async function preflightRedeem(conn, ownerPk) {
  const amm = await ammPda();
  const [s, pos] = await Promise.all([fetchAmmState(conn, amm), fetchPosition(conn, ownerPk)]);

  const statusTxt = s.status===0 ? "OPEN" : s.status===1 ? "STOPPED" : "SETTLED";
  const winnerTxt = s.winner===0 ? "-" : s.winner===1 ? "YES" : "NO";
  const vault = s.vault, pps = s.pps, W = s.wTotal;

  const fail = (why, note=[]) => ({
    ok:false,
    why,
    ctx:{statusTxt, winnerTxt, vault, pps, W, myYesSh: pos.yesSh ?? 0, myNoSh: pos.noSh ?? 0},
    note
  });

  if (s.status !== 2 || (s.winner !== 1 && s.winner !== 2)) return fail("market not SETTLED yet");
  if (!pos.ok) {
    const more = [];
    if (pos.why === "missing") more.push("Press P to init a Position for this PID.");
    if (pos.why?.startsWith("wrong_owner")) more.push("PID/seed mismatch: HUD PID must equal the deployed program ID used for init.");
    if (pos.why === "bad_discriminator") more.push("Account at PDA is not a Position; wrong PID or seeds.");
    if (pos.why?.startsWith("too_small")) more.push("Corrupted or wrong account at PDA.");
    return fail(`position invalid: ${pos.why}`, more);
  }
  if (W <= 0) return fail("winner W=0 (no winning shares)");

  const winMicro = (s.winner === 1) ? pos.yes : pos.no;
  if (winMicro > W) {
    return fail("impossible: wallet winning-shares > total W", [
      `win=${(winMicro/1e6).toFixed(6)}sh > W=${(W/1e6).toFixed(6)}sh`,
      "Likely PID mismatch or decode error. Ensure HUD PID == on-chain program ID; seeds = [b\"pos\", user]."
    ]);
  }

  const needMicro = Number((BigInt(winMicro) * BigInt(pps)) / 1_000_000n);
  if (vault < needMicro) {
    return fail("NoCoverage (predicted)", [
      `expected payout=${usdHuman(needMicro)} (win=${(winMicro/1e6).toFixed(6)} × pps=${(pps/1e6).toFixed(6)}), vault=${usdHuman(vault)}`
    ]);
  }
  return { ok:true, need: needMicro, ctx:{statusTxt, winnerTxt, vault, pps, W, myYesSh: pos.yesSh, myNoSh: pos.noSh}, note: [] };
}

/* ====== On-chain ops ====== */
async function buyUSD(conn, payer, side, usd){
  const amm = await ammPda();
  const s = await fetchAmmState(conn, amm);
  if (s.status !== 0) {
    die(`Market status=${s.status} (0=OPEN,1=STOPPED,2=SETTLED). Start a new market (close/init).`);
  }
  const pos = posPda(payer.publicKey);
  const data = Buffer.concat([DISC_TRADE, u8(side), u8(1), i64le(toScaled(usd))]); // BUY
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: pos, isSigner:false, isWritable:true },
  ];
  const ix   = new TransactionInstruction({ programId: PID, keys, data });
  const tx   = new Transaction().add(...budgetIxs(), ix);
  tx.feePayer = payer.publicKey;
  const sig  = await sendTx(conn, tx, [payer], side===1 ? "BUY_YES" : "BUY_NO");
  await waitForAccountAfterSig(conn, amm, sig);
  return sig;
}

async function stopIx(conn, payer){
  const amm = await ammPda();
  const keys = [{ pubkey: amm, isSigner:false, isWritable:true }];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_STOP_MKT) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  tx.feePayer = payer.publicKey;
  await sendTx(conn, tx, [payer], "STOP");
}
async function settleIx(conn, winner, payer){ // 1=YES, 2=NO
  const amm = await ammPda();
  const data = Buffer.concat([DISC_SETTLE_MKT, u8(winner)]);
  const keys = [{ pubkey: amm, isSigner:false, isWritable:true }];
  const ix = new TransactionInstruction({ programId: PID, keys, data });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  tx.feePayer = payer.publicKey;
  await sendTx(conn, tx, [payer], winner===1 ? "SETTLE_YES" : "SETTLE_NO");
}
async function redeemIx(conn, payer){
  // Preflight — block if coverage/position will fail; show explainer in HUD
  const pf = await preflightRedeem(conn, payer.publicKey);
  if (!pf.ok) {
    setHudLogs(buildHudBlock({
      label: "REDEEM (preflight)",
      sig: null,
      lines: ["Redeem blocked by preflight."],
      cu: null,
      err: pf.why,
      ctx: pf.ctx,
      note: pf.note,
    }));
    return;
  }

  // Build and send REDEEM
  const amm = await ammPda();
  const pos = posPda(payer.publicKey);
  const keys = [
    { pubkey: amm, isSigner:false, isWritable:true },
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: pos, isSigner:false, isWritable:true },
  ];
  const ix = new TransactionInstruction({ programId: PID, keys, data: Buffer.from(DISC_REDEEM) });
  const tx = new Transaction().add(...budgetIxs(200_000,0), ix);
  tx.feePayer = payer.publicKey;
  const sig = await sendTx(conn, tx, [payer], "REDEEM");

  // Repaint concise OK block after send (fresh context)
  const s = await fetchAmmState(conn, amm);
  const posA = await fetchPosition(conn, payer.publicKey);
  const statusTxt = s.status===0 ? "OPEN" : s.status===1 ? "STOPPED" : "SETTLED";
  const winnerTxt = s.winner===0 ? "-" : s.winner===1 ? "YES" : "NO";
  setHudLogs(buildHudBlock({
    label: "REDEEM",
    sig,
    lines: ["sent and confirmed"],
    cu: null,
    err: null,
    ctx: { statusTxt, winnerTxt, vault: s.vault, W: s.wTotal, pps: s.pps, myYesSh: posA.yesSh, myNoSh: posA.noSh },
    note: [],
  }));
}

/* ====== Shell helpers for CLOSE / INIT ====== */
function runShell(cmd, label){
  console.error(`\n>>> ${label}: ${cmd}`);
  return new Promise((resolve) => {
    const p = exec(cmd, { env: process.env, cwd: process.cwd(), shell: "/bin/bash", windowsHide: true });
    p.stdout.on("data", (d)=>process.stderr.write(`[${label}] ${d}`));
    p.stderr.on("data", (d)=>process.stderr.write(`[${label} ERR] ${d}`));
    p.on("close", (code)=>{ console.error(`[${label}] exited with code ${code}`); resolve(code); });
  });
}

/* ====== Layout ====== */
const H = {
  HEADER: "Matrix " + UL + "Oracle/AMM" + RESET + GREEN +
          " — (m) BEAR/BULL  (r) RANDOM  (1) BUY YES  (2) BUY NO  (s) STOP  (g) START  (x) STOP⛓  (y) SETTLE YES  (n) SETTLE NO  (d) REDEEM  (o) CLOSE  (i) INIT  (z) SMART REINIT  (p) INIT POSITION  (k) RESET  (q) quit",
  BTC_L:     "BTC(oracle) :",
  QUOTES_L:  "YES / NO    :",
  SENT_L:    "Sentiment   :",
  TAPE_L:    "Tape        :",
  VOL_L:     "Vol(BUYS)   :",
  LIQ_L:     "Liquidity   :",
  INV_L:     "Inventory   :",
  SKEW_L:    "Skew        :",
  DEPTH1_L:  "Depth ±1bp  :",
  DEPTH2_L:  "Depth ±1pp  :",
  VAULT_L:   "Vault / PPS :",
  STAT_L:    "State       :",
  TRAD_L:    "Trading     :",
  PNL_L:     "Last Action :",
  LOG_HDR:   "Logs:",
};
const COL_L = 2, COL_V = 20;
const ROW_HDR= 2, ROW_BTC=4, ROW_QUOTES=5, ROW_SENT=6, ROW_TAPE=7, ROW_VOL=9;
const ROW_LIQ=11, ROW_INV=12, ROW_SKEW=13, ROW_D1=14, ROW_D2=15;
const ROW_VAULT=17, ROW_STAT=18, ROW_TRAD=19, ROW_PNL=21;
// Logs panel (6 lines)
const ROW_LOG_HDR = 23;
const ROW_LOG_1   = 24;

/* ====== Main ====== */
(async () => {
  if (!process.stdout.isTTY) { console.error("TTY required"); process.exit(1); }
  const conn  = new Connection(RPC, "processed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET,"utf8"))));

  // Ensure Position exists? (we also bind P to init later)
  try { await ensurePosition(conn, payer); } catch(e){ /* ignore at boot */ }

  // keyboard
  process.stdin.setRawMode(true);
  require("readline").emitKeypressEvents(process.stdin);

  // Start PAUSED
  let sentiment="BEAR", randomMode=false;
  let tradingEnabled = false;
  let lastLine = `${DIM}— 1/2 BUY; x STOP⛓ → y/n SETTLE → d REDEEM; o CLOSE; i INIT; z SMART REINIT; p INIT POSITION —${RESET}`;
  let buyYesUsd=0, buyNoUsd=0, tape="";

  process.stdin.on("keypress", async (str,key)=>{
    if (key && key.ctrl && key.name==="c") cleanup();
    if (!key) return;
    if (key.name==="q") cleanup();

    if (key.name==="m") sentiment = (sentiment==="BEAR"?"BULL":"BEAR");
    if (key.name==="r") randomMode = !randomMode;
    if (key.name==="s") tradingEnabled = false;
    if (key.name==="g") tradingEnabled = true;
    if (key.name==="k") { tape=""; buyYesUsd=0; buyNoUsd=0; HUD_LOGS=[]; lastLine=`${DIM}— reset —${RESET}`; }
    if (key.name==="p") {
      try { await ensurePosition(conn, payer);
        setHudLogs(["===== INIT_POSITION LOGS =====","log: Position initialized for wallet under current PID.","================================="]);
        lastLine = "Position initialized.";
      } catch (e) { die(e); }
    }

    // On-chain direct BUY keys
    if (key.name==="1") {
      try {
        const sig = await buyUSD(conn, payer, 1, USD);
        tape += "+";
        buyYesUsd += USD;
        lastLine = `BUY YES $${fmtUSD(USD)} — ${sig}`;
      } catch (e) { die(e); }
    }
    if (key.name==="2") {
      try {
        const sig = await buyUSD(conn, payer, 2, USD);
        tape += "-";
        buyNoUsd += USD;
        lastLine = `BUY NO  $${fmtUSD(USD)} — ${sig}`;
      } catch (e) { die(e); }
    }

    // On-chain controls
    try {
      if (key.name==="x") { await stopIx(conn, payer); lastLine = "⛓ STOP sent. y/n to SETTLE …"; }
      if (key.name==="y") { await settleIx(conn, 1, payer); lastLine = "✅ SETTLED YES. Press d to REDEEM."; }
      if (key.name==="n") { await settleIx(conn, 2, payer); lastLine = "✅ SETTLED NO. Press d to REDEEM."; }
      if (key.name==="d") { await redeemIx(conn, payer); lastLine = "💸 REDEEM sent (if not preflight-blocked)."; }
    } catch (e) { die(e); }

    // Lifecycle via shell
    if (key.name==="o") {
      await runShell(CLOSE_CMD, "CLOSE");
      lastLine = "CLOSE command executed. (Use i to INIT.)";
    }
    if (key.name==="i") {
      await runShell(INIT_CMD, "INIT");
      lastLine = "INIT command executed. (Market should be OPEN if init succeeded.)";
    }
    if (key.name==="z") {
      try {
        const ammAddr = await ammPda();
        const s = await fetchAmmState(conn, ammAddr);
        if (s.status === 2 && (s.winner === 1 || s.winner === 2)) {
          await runShell(CLOSE_CMD, "CLOSE");
          await runShell(INIT_CMD, "INIT");
          lastLine = "SMART REINIT: CLOSE→INIT done.";
        } else {
          lastLine = "SMART REINIT needs SETTLED market (use x then y/n).";
        }
      } catch (e) { lastLine = `SMART REINIT error: ${e?.message || e}`; }
    }
  });

  enter();
  // static labels
  put(ROW_HDR, COL_L, BOLD + H.HEADER + RESET + GREEN);
  put(ROW_BTC,   COL_L, H.BTC_L);
  put(ROW_QUOTES,COL_L, H.QUOTES_L);
  put(ROW_SENT,  COL_L, H.SENT_L);
  put(ROW_TAPE,  COL_L, H.TAPE_L);
  put(ROW_VOL,   COL_L, H.VOL_L);
  put(ROW_LIQ,   COL_L, H.LIQ_L);
  put(ROW_INV,   COL_L, H.INV_L);
  put(ROW_SKEW,  COL_L, H.SKEW_L);
  put(ROW_D1,    COL_L, H.DEPTH1_L);
  put(ROW_D2,    COL_L, H.DEPTH2_L);
  put(ROW_VAULT, COL_L, H.VAULT_L);
  put(ROW_STAT,  COL_L, H.STAT_L);
  put(ROW_TRAD,  COL_L, H.TRAD_L);
  put(ROW_PNL,   COL_L, H.PNL_L);

  const headerPlain = H.HEADER.replace(/\x1b\[[0-9;]*m/g,"");
  const HEADER_END_COL = COL_L + headerPlain.length;
  const TAPE_COL = COL_V, TAPE_MAX = Math.max(0, (HEADER_END_COL - 1) - TAPE_COL);

  let lastP = null;

  while (true) {
    try {
      const ammAddr = await ammPda();
      const [btc, s, pos] = await Promise.all([
        fetchOracleBTC(conn),
        fetchAmmState(conn, ammAddr),
        fetchPosition(conn, payer.publicKey),
      ]);

      const py = pYesSafe(s, lastP); lastP = py; const pn = 1 - py;

      // HUD top
      put(ROW_BTC,    COL_V, "$" + (Number.isFinite(btc)?fmtUSD(btc):"n/a"));
      put(ROW_QUOTES, COL_V, `YES ${py.toFixed(6)}    NO ${pn.toFixed(6)}`);
      put(ROW_SENT,   COL_V, `${sentiment}  ${DIM}(random: ${randomMode?"ON":"OFF"})${RESET}`);

      // Market/trading status
      const statusTxt = s.status===0 ? "OPEN" : s.status===1 ? "STOPPED" : "SETTLED";
      put(ROW_TRAD, COL_V, `trading=${tradingEnabled?"ON":"OFF"}   market_status=${statusTxt}`);

      // Auto/random buys if market is OPEN
      if (s.status === 0) {
        const shouldAuto = tradingEnabled;
        const shouldRandom = randomMode;
        if (shouldRandom || shouldAuto) {
          const side = shouldRandom ? (Math.random() < 0.5 ? 1 : 2) : (sentiment === "BULL" ? 1 : 2);
          try {
            const sig = await buyUSD(conn, payer, side, USD);
            if (side === 1) { tape += "+"; buyYesUsd += USD; lastLine = `AUTO BUY YES $${fmtUSD(USD)} — ${sig}`; }
            else            { tape += "-"; buyNoUsd  += USD; lastLine = `AUTO BUY NO  $${fmtUSD(USD)} — ${sig}`; }
          } catch (e) { die(e); }
        }
      }

      if (tape.length > TAPE_MAX) tape = tape.slice(-TAPE_MAX);
      put(ROW_TAPE, COL_V, tape.padEnd(TAPE_MAX, " "));
      put(ROW_VOL,  COL_V, `YES $${fmtUSD(buyYesUsd)}    NO $${fmtUSD(buyNoUsd)}`);

      // Liquidity & coverage
      const p0 = pYesSafe(s, lastP);
      put(ROW_LIQ, COL_V, `b=${fmtInt(s.bScaled)} (1e-6)   fees=$${fmtUSD(s.fees/1e6)}`);
      put(ROW_INV, COL_V, `YES ${fmtSh(s.qY/1e6)} sh    NO ${fmtSh(s.qN/1e6)} sh`);
      put(ROW_SKEW,COL_V, `${fmtSh((s.qY-s.qN)/1e6)} sh`);

      const up1bp=Math.min(0.9999,p0+0.0001), dn1bp=Math.max(0.0001,p0-0.0001);
      const up1pp=Math.min(0.9999,p0+0.01),   dn1pp=Math.max(0.0001,p0-0.01);
      put(ROW_D1, COL_V, `Up ${usdHuman(usdToMoveYES(s, up1bp))}   Down ${usdHuman(usdToMoveYES(s, dn1bp))}`);
      put(ROW_D2, COL_V, `Up ${usdHuman(usdToMoveYES(s, up1pp))}   Down ${usdHuman(usdToMoveYES(s, dn1pp))}`);

      // Vault / PPS / State
      put(ROW_VAULT, COL_V, `vault=$${fmtUSD(s.vault/1e6)}   pps=${(s.pps/1e6).toFixed(6)}`);
      const winnerTxt = s.winner===0 ? "-" : s.winner===1 ? "YES" : "NO";
      put(ROW_STAT, COL_V, `status=${statusTxt}   winner=${winnerTxt}   W=${fmtSh(s.wTotal/1e6)} sh`);

      // Last action line
      put(ROW_PNL, COL_V, lastLine);

      // ---- HUD Logs panel: ALWAYS CLEAR then PAINT ----
      put(ROW_LOG_HDR, COL_L, H.LOG_HDR.padEnd(80, " "));
      for (let i = 0; i < MAX_LOG_LINES; i++) {
        put(ROW_LOG_1 + i, COL_L, "".padEnd(120, " ")); // clear line
        const line = HUD_LOGS[i] ?? "";
        const safe = line.length > 120 ? line.slice(0, 120) : line;
        put(ROW_LOG_1 + i, COL_L, safe);
      }

    } catch (e) { die(e); }

    await sleep(CADENCE);
  }

  function cleanup(){ leave(); process.exit(0); }
})();

process.on("unhandledRejection", (e)=>die(e));
process.on("uncaughtException", (e)=>die(e));

