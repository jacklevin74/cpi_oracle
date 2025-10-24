#!/usr/bin/env node
/**
 * app/tester.js
 * E2E tester for app/trade.js with:
 *  - Live progress line of +/− (buy/sell)
 *  - Human-readable REPORT per case (winner, W, pps, vaults, quotes)
 *  - Per-user (A/B) spending & selling summary
 *  - Winners & payouts by on-chain user tag (e.g., 47Vc, Eum3)
 *  - FINAL TALLY block (verbatim)
 *  - DIAG JSON block (copy/paste-friendly)
 *
 * Usage:
 *   node app/tester.js --trade ./app/trade.js --a ./userA.json --b ./userB.json [--admin ./userA.json]
 *                      [--steps 120] [--timeout 180000] [--no-progress] [--pretty] [-v]
 *                      [--tail-lines 120] [--brief-pass] [--no-tail-on-fail]
 */

const { spawn } = require("child_process");
const fs = require("fs");

// ---------- CLI ----------
function parseArgs(argv) {
  const out = {
    trade: "./app/trade.js",
    a: "./userA.json",
    b: "./userB.json",
    admin: null,            // defaults to A if absent
    steps: 120,
    timeout: 180000,        // per child
    pretty: false,
    verbose: false,         // tester verbosity (not child)
    progress: true,         // show +/− line
    tailLines: 120,         // how many lines of tail to include on FAIL
    briefPass: false,       // if true, omit tail and some extras for PASS
    noTailOnFail: false,    // if true, don't include tail even on FAIL
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--trade") out.trade = argv[++i];
    else if (k === "--a") out.a = argv[++i];
    else if (k === "--b") out.b = argv[++i];
    else if (k === "--admin") out.admin = argv[++i];
    else if (k === "--steps") out.steps = parseInt(argv[++i] || "120", 10);
    else if (k === "--timeout") out.timeout = parseInt(argv[++i] || "180000", 10);
    else if (k === "--pretty") out.pretty = true;
    else if (k === "--no-progress") out.progress = false;
    else if (k === "--verbose" || k === "-v") out.verbose = true;
    else if (k === "--tail-lines") out.tailLines = Math.max(0, parseInt(argv[++i] || "120", 10));
    else if (k === "--brief-pass") out.briefPass = true;
    else if (k === "--no-tail-on-fail") out.noTailOnFail = true;
  }
  if (!out.admin) out.admin = out.a;
  return out;
}
const ARGS = parseArgs(process.argv);

// ---------- utils ----------
function exists(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
}
function banner(s) {
  const line = "=".repeat(14);
  console.log(`\n${line} ${s} ${line}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hasFail(text) { return /\[FAIL\]/.test(text) || /Fatal:/i.test(text); }

function cleanNum(s) {
  if (s == null) return null;
  const v = Number(String(s).replace(/[\$,]/g, "").replace(/sh$/i, "").trim());
  return Number.isFinite(v) ? v : null;
}
function extract(regex, text) {
  const m = regex.exec(text);
  return m ? m[1] : null;
}
function linesTail(s, n) {
  const arr = s.split(/\r?\n/);
  if (n <= 0) return "";
  return arr.slice(-n).join("\n");
}
function padR(s, n) { s = String(s ?? ""); return s.length >= n ? s : s + " ".repeat(n - s.length); }
function padL(s, n) { s = String(s ?? ""); return s.length >= n ? s : " ".repeat(n - s.length) + s; }
function fmt2(v) { return v == null ? "" : Number(v).toFixed(2); }
function fmt6(v) { return v == null ? "" : Number(v).toFixed(6); }

// ---------- child runner (with live progress) ----------
function runNode(cmdArgs, envOverride = {}, timeoutMs = ARGS.timeout, onChunk = null) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cmdArgs, {
      env: { ...process.env, ...envOverride },
    });

    let out = "", err = "";
    const to = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      if (onChunk) onChunk(s, "stdout");
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (onChunk) onChunk(s, "stderr");
    });

    child.on("close", (code) => {
      clearTimeout(to);
      resolve({ code, out, err });
    });
  });
}

// ---------- market helpers ----------
async function cmd(args, env = {}) { return runNode(args, env, ARGS.timeout); }
async function ensureFreshMarket() {
  await cmd([ARGS.trade, "close"], { ANCHOR_WALLET: ARGS.admin });
  await cmd([ARGS.trade, "init", "500000", "25"], { ANCHOR_WALLET: ARGS.admin });
  await cmd([ARGS.trade, "init-pos"], { ANCHOR_WALLET: ARGS.a });
  await cmd([ARGS.trade, "init-pos"], { ANCHOR_WALLET: ARGS.b });
}

// ---------- progress parsing ----------
function makeProgressPrinter() {
  let col = 0;
  let printedHeader = false;
  function printSymbol(sym) {
    if (!printedHeader) {
      process.stdout.write("progress: ");
      printedHeader = true;
    }
    process.stdout.write(sym);
    col++;
    if (col % 80 === 0) process.stdout.write("\n          ");
  }
  const re = /\[tx\/(buy|sell)[^\]]*\]/g;
  return function onChunk(s) {
    let m;
    while ((m = re.exec(s)) !== null) {
      const kind = m[1]; // "buy" | "sell"
      printSymbol(kind === "buy" ? "+" : "−");
    }
  };
}

// ---------- extract blocks ----------
function blockAfter(marker, all) {
  const idx = all.lastIndexOf(marker);
  if (idx < 0) return null;
  const start = Math.max(0, all.lastIndexOf("\n", idx - 40));
  const tail = all.slice(start);
  const nextBanner = tail.indexOf("==============");
  return (nextBanner > 0 ? tail.slice(0, nextBanner) : tail).trim();
}
function finalBlock(all)      { return blockAfter("FINAL TALLY", all); }
function preSettleBlock(all)  { return blockAfter("PRE-SETTLE SUMMARY", all); }
function expectedBlock(all)   { return blockAfter("expected payouts (scale-aware)", all); }

// ---------- parsers ----------
function parsePreSettle(block) {
  if (!block) return null;
  const priceYes = extract(/Price:\s*YES=([0-9.]+)\s*NO=/i, block);
  const qY = extract(/qY=([0-9,.\$]+)sh/i, block);
  const qN = extract(/qN=([0-9,.\$]+)sh/i, block);
  const vault = extract(/Vault=\$?([0-9,.\$]+)/i, block);
  const fees = extract(/Fees=\$?([0-9,.\$]+)/i, block);
  const trades = extract(/Trades=(\d+)/i, block);

  const buysYes = extract(/Buys \(scaled\): YES=\$?([0-9,.\$]+)/i, block);
  const buysNo  = extract(/Buys \(scaled\): [^\n]*NO=\$?([0-9,.\$]+)/i, block);
  const sellsYes= extract(/Sells \(shares\): YES=([0-9,.\$]+)sh/i, block);
  const sellsNo = extract(/Sells \(shares\): [^\n]*NO=([0-9,.\$]+)sh/i, block);

  // Per-User A/B lines
  const userAL = extract(/User A:[^\n]+/i, block);
  const userBL = extract(/User B:[^\n]+/i, block);

  function parseUserLine(line) {
    if (!line) return null;
    const by = extract(/buys YES \$([0-9,.\$]+)/i, line);
    const bn = extract(/NO \$([0-9,.\$]+)/i, line);
    const sy = extract(/sells YES ([0-9,.\$]+)sh/i, line);
    const sn = extract(/NO ([0-9,.\$]+)sh/i, line);
    return {
      buys_yes: cleanNum(by),
      buys_no: cleanNum(bn),
      sells_yes_sh: cleanNum(sy),
      sells_no_sh: cleanNum(sn),
      raw: line
    };
  }

  return {
    raw: block,
    price_yes: cleanNum(priceYes),
    qY: cleanNum(qY),
    qN: cleanNum(qN),
    vault: cleanNum(vault),
    fees: cleanNum(fees),
    trades: cleanNum(trades),
    buys_yes_scaled: cleanNum(buysYes),
    buys_no_scaled: cleanNum(buysNo),
    sells_yes_sh: cleanNum(sellsYes),
    sells_no_sh: cleanNum(sellsNo),
    userA: parseUserLine(userAL),
    userB: parseUserLine(userBL),
  };
}

function parseExpected(block) {
  if (!block) return null;
  const pps = extract(/\(pps=\$?([0-9,.\$]+)\)/i, block);
  // Parse lines: "User TAG…   YES_sh ... NO_sh ... Win_raw ... Win_final ... Payout"
  const lines = block.split(/\r?\n/);
  const users = [];
  for (const line of lines) {
    const m = /^\s*(\S+)…\s+([0-9,.\$]+)\s+([0-9,.\$]+)\s+([0-9,.\$]+)\s+([0-9,.\$]+)\s+[0-9.]+%\s+\$([0-9,.\$]+)/.exec(line);
    if (m) {
      users.push({
        tag: m[1],
        yes_sh: cleanNum(m[2]),
        no_sh: cleanNum(m[3]),
        win_raw: cleanNum(m[4]),
        win_final: cleanNum(m[5]),
        payout: cleanNum(m[6])
      });
    }
  }
  const totalPayout = extract(/Σ[^\n]+?\$([0-9,.\$]+)/, block);
  return {
    raw: block,
    pps: cleanNum(pps),
    users,
    expected_sum: cleanNum(totalPayout)
  };
}

function parseFinal(block) {
  if (!block) return null;
  const winner = extract(/Winner:\s*(YES|NO)/i, block);
  const Wsh    = extract(/W \(winning shares\):\s*([0-9,.\$]+)\s*sh/i, block);
  const pps    = extract(/pps:\s*\$?([0-9,.\$]+)/i, block);
  const vaultB = extract(/Vault before:\s*\$?([0-9,.\$]+)/i, block);
  const vaultA = extract(/Vault after:\s*\$?([0-9,.\$]+)/i, block);
  const drop   = extract(/Drop:\s*\$?([0-9,.\$]+)/i, block);
  const fees   = extract(/Fees accrued:\s*\$?([0-9,.\$]+)/i, block);
  const expSum = extract(/Expected sum payouts:\s*\$?([0-9,.\$]+)/i, block);
  const actDrop= extract(/Actual drop:\s*\$?([0-9,.\$]+)/i, block);

  // Lines: "User A spent: ..." and "User B spent: ..."
  const spentA = extract(/User A spent:[^\n]+/i, block);
  const spentB = extract(/User B spent:[^\n]+/i, block);
  function parseSpent(line) {
    if (!line) return null;
    const y = extract(/YES \$([0-9,.\$]+)/i, line);
    const n = extract(/NO \$([0-9,.\$]+)/i, line);
    const sy = extract(/sold YES ([0-9,.\$]+)sh/i, line);
    const sn = extract(/sold [^\n]* NO ([0-9,.\$]+)sh/i, line);
    return {
      buys_yes: cleanNum(y),
      buys_no: cleanNum(n),
      sells_yes_sh: cleanNum(sy),
      sells_no_sh: cleanNum(sn),
      raw: line
    };
  }

  // Lines: "User TAG winning_sh=... payout=$..."
  const lines = block.split(/\r?\n/);
  const payouts = [];
  for (const line of lines) {
    const m = /User\s+(\S+)\s+winning_sh=([0-9,.\$]+)\s+sh\s+payout=\$([0-9,.\$]+)/.exec(line);
    if (m) {
      payouts.push({ tag: m[1], winning_sh: cleanNum(m[2]), payout: cleanNum(m[3]) });
    }
  }

  return {
    raw: block,
    winner: winner || null,
    W: cleanNum(Wsh),
    pps: cleanNum(pps),
    vault_before: cleanNum(vaultB),
    vault_after: cleanNum(vaultA),
    drop: cleanNum(drop),
    fees: cleanNum(fees),
    expected_sum: cleanNum(expSum),
    actual_drop: cleanNum(actDrop),
    diff: (cleanNum(actDrop) != null && cleanNum(expSum) != null) ? (cleanNum(actDrop) - cleanNum(expSum)) : null,
    spentA: parseSpent(spentA),
    spentB: parseSpent(spentB),
    payouts
  };
}

function countPatterns(text) {
  return {
    market_closed: (text.match(/MarketClosed|market is closed/i) || []).length,
    custom_prog_err: (text.match(/custom program error/i) || []).length,
    tx_failed: (text.match(/TX failed|Simulation failed/i) || []).length,
  };
}

// ---------- child case runner ----------
function buildScenarios() {
  const forceVerbose = ARGS.progress ? ["--verbose"] : [];
  const baseRun = [
    ARGS.trade, "run",
    "--wallets", `${ARGS.a},${ARGS.b}`,
    "--steps", String(ARGS.steps),
    "--pretty",
    ...forceVerbose,
  ];

  return [
    { label: "01 mixed (buys+sells, auto winner)", args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.30", "--sell-frac", "0.35", "--winner", "auto"], fresh: true },
    { label: "02 trend (follow price, auto winner)", args: [...baseRun, "--mode", "trend", "--sell-prob", "0.25", "--sell-frac", "0.30", "--winner", "auto"], fresh: true },
    { label: "03 meanrevert (auto winner)", args: [...baseRun, "--mode", "meanrevert", "--sell-prob", "0.40", "--sell-frac", "0.25", "--winner", "auto"], fresh: true },
    { label: "04 random (auto winner)", args: [...baseRun, "--mode", "random", "--sell-prob", "0.20", "--sell-frac", "0.50", "--winner", "auto"], fresh: true },
    { label: "05 forced YES", args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.30", "--sell-frac", "0.33", "--winner", "yes"], fresh: true },
    { label: "06 forced NO",  args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.30", "--sell-frac", "0.33", "--winner", "no"], fresh: true },
    // closed → reinit and skip paths
    { label: "07 closed → reinit", args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.35", "--sell-frac", "0.4", "--winner", "auto", "--on-closed", "reinit", "--reinit-fee-bps", "25"], fresh: false },
    { label: "08 closed → skip",   args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.35", "--sell-frac", "0.4", "--winner", "auto", "--on-closed", "skip"], fresh: false },
    // Extended / legacy
    { label: "09 test-pps-yes1", args: [ARGS.trade, "test-pps-yes1", "--wallets", `${ARGS.a},${ARGS.b}`, "--yes-usd", "10", "--no-usd", "180", "--iters", "250"], fresh: true },
    { label: "10 random-duel",    args: [ARGS.trade, "test-random-duel", "--wallets", `${ARGS.a},${ARGS.b}`, "--n", "200", "--a-yes-prob", "0.65", "--b-no-prob", "0.65", "--min-usd", "5", "--max-usd", "150", "--force-winner", "auto"], fresh: true },
    // Unit tests
    { label: "11 unit: single",   args: [ARGS.trade, "test"], fresh: true, env: { ANCHOR_WALLET: ARGS.admin } },
    { label: "12 unit: two",      args: [ARGS.trade, "test2", "--wallets", `${ARGS.a},${ARGS.b}`], fresh: true },
  ];
}

function makeProgressCb() {
  return ARGS.progress ? makeProgressPrinter() : null;
}

function printHumanReport(label, pre, fin, exp) {
  // Case header
  console.log("\n--- CASE REPORT ---");
  console.log(label);

  // Case summary
  console.log("\nSummary:");
  const w = fin?.winner || "";
  const W = fin?.W != null ? fmt6(fin.W) : "";
  const pps = fin?.pps != null ? fmt6(fin.pps) : "";
  const vb = fin?.vault_before != null ? fmt6(fin.vault_before) : "";
  const va = fin?.vault_after  != null ? fmt6(fin.vault_after)  : "";
  const vd = fin?.drop         != null ? fmt6(fin.drop)         : "";
  const fees = fin?.fees       != null ? fmt6(fin.fees)         : "";
  const priceYes = pre?.price_yes != null ? pre.price_yes.toFixed(6) : "";
  console.log(`  Winner: ${w} | W: ${W} sh | pps: $${pps}`);
  console.log(`  Vault: before $${vb} → after $${va} | drop $${vd} | fees $${fees}`);
  console.log(`  Last quote: YES=${priceYes}${priceYes ? ` NO=${(1 - pre.price_yes).toFixed(6)}` : ""}`);

  // Market snapshot
  console.log("\nMarket Snapshot (pre-settle):");
  console.log(`  qY: ${pre?.qY != null ? fmt6(pre.qY) : ""} sh | qN: ${pre?.qN != null ? fmt6(pre.qN) : ""} sh`);
  console.log(`  Vault: $${pre?.vault != null ? fmt6(pre.vault) : ""} | Fees: $${pre?.fees != null ? fmt6(pre.fees) : ""} | Trades: ${pre?.trades ?? ""}`);

  // Users A/B summary (spend/sell)
  console.log("\nPer-User Summary (A/B):");
  function lineAB(name, uSpend, uPre) {
    const by = uSpend?.buys_yes ?? uPre?.buys_yes;
    const bn = uSpend?.buys_no  ?? uPre?.buys_no;
    const sy = uSpend?.sells_yes_sh ?? uPre?.sells_yes_sh;
    const sn = uSpend?.sells_no_sh  ?? uPre?.sells_no_sh;
    console.log(`  ${padR(name, 5)} spent: YES $${fmt2(by)} | NO $${fmt2(bn)}   sold: YES ${fmt6(sy)} sh | NO ${fmt6(sn)} sh`);
  }
  lineAB("User A", fin?.spentA, pre?.userA);
  lineAB("User B", fin?.spentB, pre?.userB);

  // Winners & payouts (on-chain tags)
  if (fin?.payouts?.length || exp?.users?.length) {
    console.log("\nWinners & Payouts (on-chain tags):");
    console.log("  " + padR("Tag", 8) + padL("Winning_sh", 16) + padL("Payout", 16));
    const rows = fin?.payouts?.length ? fin.payouts : (exp?.users || []).map(u => ({ tag: u.tag, winning_sh: u.win_final, payout: u.payout }));
    for (const r of rows) {
      console.log("  " + padR(r.tag, 8) + padL(fmt6(r.winning_sh), 16) + padL("$" + fmt6(r.payout), 16));
    }
  }

  // Expected vs actual reconciliation
  console.log("\nPayout Reconciliation:");
  const es = fin?.expected_sum ?? exp?.expected_sum;
  const ad = fin?.actual_drop;
  const df = (es != null && ad != null) ? (ad - es) : null;
  console.log(`  Expected sum payouts: $${es != null ? fmt6(es) : ""}`);
  console.log(`  Actual drop:          $${ad != null ? fmt6(ad) : ""}`);
  console.log(`  Diff (drop - exp):    $${df != null ? fmt6(df) : ""}`);
  console.log("--- END REPORT ---\n");
}

function extractFinalReport(all) {
  const fb = finalBlock(all);
  return fb || null;
}

async function runCase(label, nodeArgs, opts = { fresh: true, env: {} }) {
  banner(label);
  if (opts.fresh) {
    await ensureFreshMarket();
    await sleep(120);
  }

  const progressCb = makeProgressCb();
  const { code, out, err } = await runNode(nodeArgs, opts.env || {}, ARGS.timeout, progressCb);
  if (ARGS.progress) process.stdout.write("\n");

  const merged = out + "\n" + err;

  const preBlock = preSettleBlock(merged);
  const expBlock = expectedBlock(merged);
  const finBlock = finalBlock(merged);

  const pre = parsePreSettle(preBlock);
  const exp = parseExpected(expBlock);
  const fin = parseFinal(finBlock);

  // Failed classification (keep strict; leave epsilon policy to trade.js)
  const failed = (code !== 0) || hasFail(merged) || !finBlock;

  // Print human-readable report
  printHumanReport(label, pre, fin, exp);

  // Print the FINAL TALLY block verbatim (for exact context)
  console.log(finBlock ? finBlock + "\n" : "[NO FINAL TALLY BLOCK FOUND]\n");

  // DIAG JSON block (for copy-paste debugging here)
  const diag = {
    case: label,
    status: failed ? "FAIL" : "PASS",
    exit_code: code,
    pre_settle: pre,
    final_tally: fin,
    logs: countPatterns(merged),
  };
  if (!ARGS.briefPass || failed) {
    if (!ARGS.noTailOnFail && (failed && ARGS.tailLines > 0)) {
      diag.tail = linesTail(merged, ARGS.tailLines);
    }
  }
  console.log("----- BEGIN DIAG JSON -----");
  console.log(JSON.stringify(diag, null, 2));
  console.log("----- END DIAG JSON -----\n");

  console.log(failed ? `>>> ❌ FAILED: ${label}` : `>>> ✅ PASSED: ${label}`);
  return { label, failed, code, diag, out, err };
}

// ---------- scenarios ----------
function buildScenarios() {
  const forceVerbose = ARGS.progress ? ["--verbose"] : [];
  const baseRun = [
    ARGS.trade, "run",
    "--wallets", `${ARGS.a},${ARGS.b}`,
    "--steps", String(ARGS.steps),
    "--pretty",
    ...forceVerbose,
  ];

  return [
    { label: "01 mixed (buys+sells, auto winner)", args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.30", "--sell-frac", "0.35", "--winner", "auto"], fresh: true },
    { label: "02 trend (follow price, auto winner)", args: [...baseRun, "--mode", "trend", "--sell-prob", "0.25", "--sell-frac", "0.30", "--winner", "auto"], fresh: true },
    { label: "03 meanrevert (auto winner)", args: [...baseRun, "--mode", "meanrevert", "--sell-prob", "0.40", "--sell-frac", "0.25", "--winner", "auto"], fresh: true },
    { label: "04 random (auto winner)", args: [...baseRun, "--mode", "random", "--sell-prob", "0.20", "--sell-frac", "0.50", "--winner", "auto"], fresh: true },
    { label: "05 forced YES", args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.30", "--sell-frac", "0.33", "--winner", "yes"], fresh: true },
    { label: "06 forced NO",  args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.30", "--sell-frac", "0.33", "--winner", "no"], fresh: true },
    // closed → reinit and skip
    { label: "07 closed → reinit", args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.35", "--sell-frac", "0.4", "--winner", "auto", "--on-closed", "reinit", "--reinit-fee-bps", "25"], fresh: false },
    { label: "08 closed → skip",   args: [...baseRun, "--mode", "mixed", "--sell-prob", "0.35", "--sell-frac", "0.4", "--winner", "auto", "--on-closed", "skip"], fresh: false },
    // extended / legacy
    { label: "09 test-pps-yes1", args: [ARGS.trade, "test-pps-yes1", "--wallets", `${ARGS.a},${ARGS.b}`, "--yes-usd", "10", "--no-usd", "180", "--iters", "250"], fresh: true },
    { label: "10 random-duel",    args: [ARGS.trade, "test-random-duel", "--wallets", `${ARGS.a},${ARGS.b}`, "--n", "200", "--a-yes-prob", "0.65", "--b-no-prob", "0.65", "--min-usd", "5", "--max-usd", "150", "--force-winner", "auto"], fresh: true },
    // unit
    { label: "11 unit: single",   args: [ARGS.trade, "test"], fresh: true, env: { ANCHOR_WALLET: ARGS.admin } },
    { label: "12 unit: two",      args: [ARGS.trade, "test2", "--wallets", `${ARGS.a},${ARGS.b}`], fresh: true },
  ];
}

// ---------- main ----------
(async function main() {
  if (!exists(ARGS.trade)) { console.error("trade.js not found:", ARGS.trade); process.exit(1); }
  if (!exists(ARGS.a)) { console.error("Wallet A not found:", ARGS.a); process.exit(1); }
  if (!exists(ARGS.b)) { console.error("Wallet B not found:", ARGS.b); process.exit(1); }
  if (!exists(ARGS.admin)) { console.error("Admin wallet not found:", ARGS.admin); process.exit(1); }

  const scenarios = buildScenarios();
  const results = [];
  let anyFailed = false;

  for (const sc of scenarios) {
    if (sc.fresh === false) {
      // Intentionally close to exercise on-closed paths
      await cmd([ARGS.trade, "stop"],   { ANCHOR_WALLET: ARGS.admin });
      await cmd([ARGS.trade, "settle", "yes"], { ANCHOR_WALLET: ARGS.admin });
      await cmd([ARGS.trade, "redeem"], { ANCHOR_WALLET: ARGS.a });
      await cmd([ARGS.trade, "redeem"], { ANCHOR_WALLET: ARGS.b });
      await cmd([ARGS.trade, "close"],  { ANCHOR_WALLET: ARGS.admin });
      await sleep(80);
    }

    const r = await runCase(sc.label, sc.args, { fresh: sc.fresh !== false, env: sc.env || {} });
    results.push(r);
    if (r.failed) anyFailed = true;
    await sleep(120);
  }

  // Summary table
  banner("SUMMARY");
  const maxLabel = Math.max(...results.map(x => x.label.length), 10);
  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  console.log(pad("Case", maxLabel + 2) + "Status");
  console.log("-".repeat(maxLabel + 2 + 10));
  for (const r of results) {
    console.log(pad(r.label, maxLabel + 2) + (r.failed ? "❌ FAIL" : "✅ PASS"));
  }
  console.log("");

  process.exit(anyFailed ? 1 : 0);
})().catch(e => {
  console.error("Tester Fatal:", e?.message || e);
  process.exit(1);
});

