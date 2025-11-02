#!/usr/bin/env node
// Comprehensive test suite for advanced guards on X1 testnet

const fs = require("fs");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const { BN } = require("bn.js");

// Configuration
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://rpc.testnet.x1.xyz";
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
const PID = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const AMM_SEED = Buffer.from("amm_btc_v6");
const POS_SEED = Buffer.from("pos");
const VAULT_SOL_SEED = Buffer.from("vault_sol");
const USER_VAULT_SEED = Buffer.from("user_vault");

// Oracle state on testnet
const ORACLE_STATE = new PublicKey("4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq");

// Trade constants
const SIDE_YES = 1;
const SIDE_NO = 2;
const ACTION_BUY = 1;
const ACTION_SELL = 2;

// Load IDL for instruction encoding
const idl = JSON.parse(fs.readFileSync("./target/idl/cpi_oracle.json", "utf8"));

// Colors
const C = {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
  m: (s) => `\x1b[35m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// Helper functions
function readKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function ammPda() {
  return PublicKey.findProgramAddressSync([AMM_SEED], PID)[0];
}

function posPda(owner, amm) {
  return PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), owner.toBuffer()], PID)[0];
}

function vaultSolPda(amm) {
  return PublicKey.findProgramAddressSync([VAULT_SOL_SEED, amm.toBuffer()], PID)[0];
}

function userVaultPda(pos) {
  return PublicKey.findProgramAddressSync([USER_VAULT_SEED, pos.toBuffer()], PID)[0];
}

// Find discriminator for instruction
function getInstructionDiscriminator(name) {
  const instruction = idl.instructions.find(ix => ix.name === name);
  if (!instruction) throw new Error(`Instruction ${name} not found in IDL`);
  return Buffer.from(instruction.discriminator);
}

// Encode trade_advanced instruction
// Layout: disc(8) + side(1) + action(1) + amount(8) + AdvancedGuardConfig
// AdvancedGuardConfig: price_limit_e6(8) + max_slippage_bps(2) + quote_price_e6(8) +
//                      quote_timestamp(8) + max_total_cost_e6(8) + allow_partial(1) + min_fill_shares_e6(8)
function encodeTradeAdvanced(side, action, amount, guards) {
  const discriminator = getInstructionDiscriminator("trade_advanced");
  const buf = Buffer.alloc(8 + 1 + 1 + 8 + 8 + 2 + 8 + 8 + 8 + 1 + 8); // Total: 61 bytes

  let offset = 0;
  discriminator.copy(buf, offset);
  offset += 8;

  buf.writeUInt8(side, offset);
  offset += 1;

  buf.writeUInt8(action, offset);
  offset += 1;

  // Write amount as i64 (little endian)
  const amountBN = new BN(amount);
  amountBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // AdvancedGuardConfig fields
  // price_limit_e6 (i64)
  const priceLimitBN = new BN(guards.price_limit_e6 || 0);
  priceLimitBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // max_slippage_bps (u16)
  buf.writeUInt16LE(guards.max_slippage_bps || 0, offset);
  offset += 2;

  // quote_price_e6 (i64)
  const quotePriceBN = new BN(guards.quote_price_e6 || 0);
  quotePriceBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // quote_timestamp (i64)
  const quoteTimestampBN = new BN(guards.quote_timestamp || 0);
  quoteTimestampBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // max_total_cost_e6 (i64)
  const maxCostBN = new BN(guards.max_total_cost_e6 || 0);
  maxCostBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // allow_partial (bool/u8)
  buf.writeUInt8(guards.allow_partial ? 1 : 0, offset);
  offset += 1;

  // min_fill_shares_e6 (i64)
  const minFillBN = new BN(guards.min_fill_shares_e6 || 0);
  minFillBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);

  return buf;
}

async function runTest(testName, testFn, shouldFail = false) {
  console.log(C.bold(`\n${testName}`));
  console.log("-".repeat(60));

  try {
    await testFn();
    if (shouldFail) {
      console.log(C.r(`  ✗ Test should have failed but succeeded`));
      return false;
    } else {
      console.log(C.g(`  ✓ Test passed`));
      return true;
    }
  } catch (err) {
    if (shouldFail) {
      // Check if it failed for the right reason
      const errorMsg = err.message || "";
      const logs = err.logs || [];
      const logStr = logs.join(" ");

      if (logStr.includes("StaleQuote") || errorMsg.includes("StaleQuote")) {
        console.log(C.y(`  ⚠ Correctly rejected with StaleQuote`));
        return true;
      } else if (logStr.includes("CostExceedsLimit") || errorMsg.includes("CostExceedsLimit")) {
        console.log(C.y(`  ⚠ Correctly rejected with CostExceedsLimit`));
        return true;
      } else if (logStr.includes("MinFillNotMet") || errorMsg.includes("MinFillNotMet")) {
        console.log(C.y(`  ⚠ Correctly rejected with MinFillNotMet`));
        return true;
      } else if (logStr.includes("PriceLimitExceeded") || errorMsg.includes("PriceLimitExceeded")) {
        console.log(C.y(`  ⚠ Correctly rejected with PriceLimitExceeded`));
        return true;
      } else if (logStr.includes("SlippageExceeded") || errorMsg.includes("SlippageExceeded")) {
        console.log(C.y(`  ⚠ Correctly rejected with SlippageExceeded`));
        return true;
      } else {
        console.log(C.r(`  ✗ Test failed with unexpected error: ${err.message}`));
        if (logs.length > 0) {
          console.log(C.r("  Logs:"));
          logs.forEach(log => console.log(C.r(`    ${log}`)));
        }
        return false;
      }
    } else {
      console.log(C.r(`  ✗ Test failed: ${err.message}`));
      if (err.logs) {
        console.log("  Logs:");
        err.logs.forEach(log => console.log(`    ${log}`));
      }
      return false;
    }
  }
}

async function main() {
  console.log(C.bold(C.c("=".repeat(80))));
  console.log(C.bold(C.c("Advanced Guards Comprehensive Test Suite - X1 Testnet")));
  console.log(C.bold(C.c("=".repeat(80))));
  console.log("");

  // Connect to testnet
  const connection = new Connection(RPC, "confirmed");
  console.log(C.g("✓ Connected to X1 testnet"));

  // Load wallet
  const payer = readKeypair(WALLET);
  console.log(C.g(`✓ Loaded wallet: ${payer.publicKey.toBase58()}`));

  // Check balance
  const balance = await connection.getBalance(payer.publicKey);
  console.log(C.g(`✓ Balance: ${(balance / 1e9).toFixed(4)} SOL`));
  console.log("");

  // Get PDAs
  const amm = ammPda();
  const pos = posPda(payer.publicKey, amm);
  const vaultSol = vaultSolPda(amm);
  const userVault = userVaultPda(pos);

  // Fetch fee_dest from AMM account
  const ammAccount = await connection.getAccountInfo(amm);
  if (!ammAccount) {
    console.log(C.r("✗ AMM account not found. Please initialize the market first."));
    process.exit(1);
  }

  const data = ammAccount.data;
  const feeDestOffset = 8 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 8;
  const feeDest = new PublicKey(data.slice(feeDestOffset, feeDestOffset + 32));

  console.log("PDAs:");
  console.log(`  AMM: ${amm.toBase58()}`);
  console.log(`  Position: ${pos.toBase58()}`);
  console.log(`  Fee dest: ${feeDest.toBase58()}`);
  console.log("");

  const results = [];

  // Test 1: No guards (market order)
  results.push(await runTest("Test 1: Market order with no guards", async () => {
    const amount = 500_000; // 0.5 shares
    const guards = {
      price_limit_e6: 0,
      max_slippage_bps: 0,
      quote_price_e6: 0,
      quote_timestamp: 0,
      max_total_cost_e6: 0,
      allow_partial: false,
      min_fill_shares_e6: 0,
    };

    const guardData = encodeTradeAdvanced(SIDE_YES, ACTION_BUY, amount, guards);
    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: guardData,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  Tx: ${sig}`);
  }));

  // Test 2: Absolute price limit (favorable)
  results.push(await runTest("Test 2: Price limit $1.00 (should pass)", async () => {
    const amount = 300_000;
    const guards = {
      price_limit_e6: 1_000_000, // $1.00 max
      max_slippage_bps: 0,
      quote_price_e6: 0,
      quote_timestamp: 0,
      max_total_cost_e6: 0,
      allow_partial: false,
      min_fill_shares_e6: 0,
    };

    const guardData = encodeTradeAdvanced(SIDE_YES, ACTION_BUY, amount, guards);
    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: guardData,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  Tx: ${sig}`);
  }));

  // Test 3: Absolute price limit (unfavorable) - should fail
  results.push(await runTest("Test 3: Price limit $0.01 (should fail)", async () => {
    const amount = 200_000;
    const guards = {
      price_limit_e6: 10_000, // $0.01 max (way too low)
      max_slippage_bps: 0,
      quote_price_e6: 0,
      quote_timestamp: 0,
      max_total_cost_e6: 0,
      allow_partial: false,
      min_fill_shares_e6: 0,
    };

    const guardData = encodeTradeAdvanced(SIDE_YES, ACTION_BUY, amount, guards);
    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: guardData,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer], {
      skipPreflight: false,
    });
    await connection.confirmTransaction(sig, "confirmed");
  }, true)); // Should fail

  // Test 4: Slippage protection with fresh quote
  results.push(await runTest("Test 4: Slippage 10% with fresh quote", async () => {
    const amount = 400_000;
    const guards = {
      price_limit_e6: 0,
      max_slippage_bps: 1000, // 10%
      quote_price_e6: 500_000, // $0.50 quote
      quote_timestamp: Math.floor(Date.now() / 1000), // Fresh quote
      max_total_cost_e6: 0,
      allow_partial: false,
      min_fill_shares_e6: 0,
    };

    const guardData = encodeTradeAdvanced(SIDE_YES, ACTION_BUY, amount, guards);
    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: guardData,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  Tx: ${sig}`);
  }));

  // Test 5: Stale quote - should fail
  results.push(await runTest("Test 5: Stale quote (should fail)", async () => {
    const amount = 200_000;
    const guards = {
      price_limit_e6: 0,
      max_slippage_bps: 1000, // 10%
      quote_price_e6: 500_000,
      quote_timestamp: Math.floor(Date.now() / 1000) - 60, // 60 seconds old (stale)
      max_total_cost_e6: 0,
      allow_partial: false,
      min_fill_shares_e6: 0,
    };

    const guardData = encodeTradeAdvanced(SIDE_YES, ACTION_BUY, amount, guards);
    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: guardData,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
  }, true)); // Should fail with StaleQuote

  // Test 6: Max cost limit (should pass)
  results.push(await runTest("Test 6: Max cost $1.00 (should pass)", async () => {
    const amount = 500_000;
    const guards = {
      price_limit_e6: 0,
      max_slippage_bps: 0,
      quote_price_e6: 0,
      quote_timestamp: 0,
      max_total_cost_e6: 1_000_000, // $1.00 max cost
      allow_partial: false,
      min_fill_shares_e6: 0,
    };

    const guardData = encodeTradeAdvanced(SIDE_YES, ACTION_BUY, amount, guards);
    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: guardData,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  Tx: ${sig}`);
  }));

  // Test 7: Partial fills enabled
  results.push(await runTest("Test 7: Partial fills with $0.10 max cost", async () => {
    const amount = 10_000_000; // 10 shares (likely too expensive)
    const guards = {
      price_limit_e6: 0,
      max_slippage_bps: 0,
      quote_price_e6: 0,
      quote_timestamp: 0,
      max_total_cost_e6: 100_000, // $0.10 max cost - will trigger partial
      allow_partial: true,
      min_fill_shares_e6: 50_000, // Min 0.05 shares
    };

    const guardData = encodeTradeAdvanced(SIDE_YES, ACTION_BUY, amount, guards);
    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: guardData,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  Tx: ${sig} (partial fill expected)`);
  }));

  // Test 8: Combined guards (price + slippage + cost)
  results.push(await runTest("Test 8: Combined guards", async () => {
    const amount = 300_000;
    const guards = {
      price_limit_e6: 800_000, // $0.80 max
      max_slippage_bps: 500, // 5%
      quote_price_e6: 600_000, // $0.60 quote
      quote_timestamp: Math.floor(Date.now() / 1000),
      max_total_cost_e6: 500_000, // $0.50 max cost
      allow_partial: false,
      min_fill_shares_e6: 0,
    };

    const guardData = encodeTradeAdvanced(SIDE_YES, ACTION_BUY, amount, guards);
    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: guardData,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  Tx: ${sig}`);
  }));

  // Print summary
  console.log("");
  console.log(C.bold(C.c("=".repeat(80))));
  console.log(C.bold(C.c("Test Summary")));
  console.log(C.bold(C.c("=".repeat(80))));
  const passed = results.filter(r => r).length;
  const failed = results.length - passed;
  console.log(`Total: ${results.length} tests`);
  console.log(C.g(`Passed: ${passed}`));
  if (failed > 0) {
    console.log(C.r(`Failed: ${failed}`));
  }
  console.log("");
}

main().catch(err => {
  console.error(C.r(`Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
