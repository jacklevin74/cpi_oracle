#!/usr/bin/env node
// app/scan.js — on-chain scanner: prints YES / NO quotes (and BTC oracle), no writes.
//
// Usage:
//   ANCHOR_PROVIDER_URL=<RPC> ANCHOR_WALLET=<keypair.json> node app/scan.js [--cadence 1000]
//
// Example:
//   export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
//   node app/scan.js --cadence 1500

const crypto = require("crypto");
const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");

/* ========= CONFIG (match your deployment) ========= */
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";

// Reader+AMM program id (your demo)
const READER_PID = new PublicKey("FyhgimJq9KN9BZukjzfJKuNKZSGLnzsTpQq6yevDpp8r");
// Oracle program id
const ORACLE_PID = new PublicKey("7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE");

const AMM_SEED    = Buffer.from("amm_btc");
const ORACLE_SEED = Buffer.from("state_v2");

/* ========= CLI ========= */
const argv = process.argv.slice(2);
function flag(name, def){ const i=argv.indexOf("--"+name); return (i>=0 && i+1<argv.length) ? argv[i+1] : def; }
const CADENCE = Math.max(200, parseInt(flag("cadence", "1000"), 10));

/* ========= helpers ========= */
async function ammPda(){ return PublicKey.findProgramAddressSync([AMM_SEED], READER_PID)[0]; }
function  oraclePda(){ return PublicKey.findProgramAddressSync([ORACLE_SEED], ORACLE_PID)[0]; }

function readI64LE(buf, off){
  const u = buf.readBigUInt64LE(off);
  const max = (1n<<63n) - 1n;
  return (u > max) ? Number(u - (1n<<64n)) : Number(u);
}
function readU8(buf, off){ return buf.readUInt8(off); }
function readU16LE(buf, off){ return buf.readUInt16LE(off); }

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
function fmtUSD(x){ return Number(x).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2}); }

/* ========= parsers ========= */
// AMM: [8] + bump u8 + dec u8 + b i64 + fee u16 + qY i64 + qN i64 + fees i64
async function fetchAmmState(conn, pda){
  const info = await conn.getAccountInfo(pda, "processed");
  if (!info) throw new Error("AMM account not found");
  const d = info.data;
  if (!d || d.length < 8 + 1 + 1 + 8 + 2 + 8 + 8) throw new Error("AMM account too small");
  const p = d.subarray(8);
  let o=0;
  o += 1; // bump
  o += 1; // decimals
  const bScaled = readI64LE(p,o); o += 8;
  readU16LE(p,o);                  o += 2; // fee_bps (unused)
  const qY = readI64LE(p,o); o += 8;
  const qN = readI64LE(p,o); o += 8;
  return { qY, qN, bScaled };
}

// Oracle: [8] + 32 + BTC(48) + ETH(48) + SOL(48) + u8 + u8
async function fetchOracleBTC(conn){
  const info = await conn.getAccountInfo(oraclePda(), "processed");
  if (!info) throw new Error("oracle state not found");
  const p = info.data.subarray(8);
  let o=0; o+=32;
  const p1=readI64LE(p,o+0), p2=readI64LE(p,o+8), p3=readI64LE(p,o+16);
  o+=48; o+=48; o+=48;
  const dec=readU8(p,o);
  const vals=[p1,p2,p3].filter(x=>x!==0);
  return vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length)/(10**dec) : NaN;
}

/* ========= main ========= */
(async () => {
  const conn = new Connection(RPC, "processed");
  const addrAmm = await ammPda();
  const addrOrc = oraclePda();

  console.log("RPC:", RPC);
  console.log("AMM PDA    :", addrAmm.toBase58());
  console.log("ORACLE PDA :", addrOrc.toBase58());
  console.log("Cadence    :", CADENCE, "ms");
  console.log("---- scanning (Ctrl+C to stop) ----");

  let lastP = null;
  while (true) {
    try {
      const [btc, st] = await Promise.all([ fetchOracleBTC(conn), fetchAmmState(conn, addrAmm) ]);
      const py = pYesSafe(st, lastP); lastP = py; const pn = 1 - py;

      const btcStr = Number.isFinite(btc) ? "$" + fmtUSD(btc) : "n/a";
      console.log(`BTC ${btcStr}  |  YES ${py.toFixed(6)}  NO ${pn.toFixed(6)}`);
    } catch (e) {
      console.error("scan error:", e?.message || e);
    }
    await new Promise(r => setTimeout(r, CADENCE));
  }
})().catch(e => { console.error("fatal:", e?.message || e); process.exit(1); });

