#!/usr/bin/env ts-node
// app/keeper.ts — Keeper bot for executing dark pool limit orders

import * as fs from 'fs';
import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import axios from 'axios';
import * as borsh from '@coral-xyz/borsh';

/* ==================== CONFIG ==================== */
const RPC = process.env.ANCHOR_PROVIDER_URL || 'http://127.0.0.1:8899';
const KEEPER_WALLET = process.env.KEEPER_WALLET || process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
const ORDER_BOOK_API = process.env.ORDER_BOOK_API || 'http://localhost:3000';
const CHECK_INTERVAL = parseInt(process.env.KEEPER_CHECK_INTERVAL || '2000'); // ms
const MIN_PROFIT_LAMPORTS = parseInt(process.env.KEEPER_MIN_PROFIT || '100000'); // 0.0001 SOL

// Program IDs
const PID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v6');
const POS_SEED = Buffer.from('pos');
const VAULT_SOL_SEED = Buffer.from('vault_sol');

/* ==================== TYPES ==================== */
interface LimitOrder {
  market: string;
  user: string;
  action: number; // 1=BUY, 2=SELL
  side: number;   // 1=YES, 2=NO
  shares_e6: number;
  limit_price_e6: number;
  max_cost_e6: number;
  min_proceeds_e6: number;
  expiry_ts: number;
  nonce: number;
  keeper_fee_bps: number;
  min_fill_bps: number;
}

interface OrderData {
  order_id: number;
  order_hash: string;
  order: LimitOrder;
  signature: string;
  submitted_at: string;
}

interface PendingOrdersResponse {
  orders: OrderData[];
}

interface AmmAccount {
  bump: number;
  decimals: number;
  b: anchor.BN;
  feeBps: number;
  qYes: anchor.BN;
  qNo: anchor.BN;
  fees: anchor.BN;
  vaultE6: anchor.BN;
  status: number;
  winner: number;
  wTotalE6: anchor.BN;
  ppsE6: anchor.BN;
  feeDest: PublicKey;
  vaultSolBump: number;
  startPriceE6: anchor.BN;
  startTs: anchor.BN;
  settlePriceE6: anchor.BN;
  settleTs: anchor.BN;
  marketEndSlot: anchor.BN;
  marketEndTime: anchor.BN;
}

/* ==================== HELPERS ==================== */
function loadKeeper(path: string): Keypair {
  const rawKey = JSON.parse(fs.readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(rawKey));
}

function getAmmPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  return pda;
}

function getPositionPda(amm: PublicKey, user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [POS_SEED, amm.toBuffer(), user.toBuffer()],
    PID
  );
  return pda;
}

function getVaultPda(amm: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [VAULT_SOL_SEED, amm.toBuffer()],
    PID
  );
  return pda;
}

/* ==================== PRICE CALCULATION ==================== */
function calculateLmsrCost(amm: AmmAccount, qYes: number, qNo: number): number {
  const b = amm.b.toNumber() / 1e6;
  const a = qYes / b;
  const c = qNo / b;
  const m = Math.max(a, c);
  const ea = Math.exp(a - m);
  const ec = Math.exp(c - m);
  return b * (m + Math.log(ea + ec));
}

function calculateCurrentPrice(amm: AmmAccount, action: number, side: number, shares: number): number {
  // Calculate price for buying/selling shares
  const currentQYes = amm.qYes.toNumber() / 1e6;
  const currentQNo = amm.qNo.toNumber() / 1e6;

  const baseCost = calculateLmsrCost(amm, currentQYes, currentQNo);

  let targetCost: number;
  if (action === 1) { // BUY
    if (side === 1) { // YES
      targetCost = calculateLmsrCost(amm, currentQYes + shares, currentQNo - shares);
    } else { // NO
      targetCost = calculateLmsrCost(amm, currentQYes, currentQNo + shares);
    }
  } else { // SELL
    if (side === 1) { // YES
      targetCost = calculateLmsrCost(amm, currentQYes - shares, currentQNo + shares);
    } else { // NO
      targetCost = calculateLmsrCost(amm, currentQYes, currentQNo - shares);
    }
  }

  const netCost = Math.abs(targetCost - baseCost);

  // Apply fees
  const feeBps = amm.feeBps;
  const grossCost = action === 1
    ? netCost / (1 - feeBps / 10000)
    : netCost * (1 - feeBps / 10000);

  // Average price per share
  const avgPrice = (grossCost / shares) * 1e6; // Convert to e6 scale

  return Math.floor(avgPrice);
}

/* ==================== ORDER CHECKING ==================== */
async function fetchPendingOrders(): Promise<OrderData[]> {
  try {
    const response = await axios.get<PendingOrdersResponse>(`${ORDER_BOOK_API}/api/orders/pending`, {
      params: { limit: 100 }
    });
    return response.data.orders;
  } catch (err: any) {
    console.error('❌ Error fetching pending orders:', err.message);
    return [];
  }
}

async function checkIfExecutable(
  connection: Connection,
  amm: AmmAccount,
  order: LimitOrder
): Promise<boolean> {
  try {
    // Check market is open
    if (amm.status !== 1) {
      return false;
    }

    // Check not expired
    const now = Math.floor(Date.now() / 1000);
    if (order.expiry_ts <= now) {
      return false;
    }

    // Calculate current price for 1 share to check condition
    const currentPrice = calculateCurrentPrice(amm, order.action, order.side, 1);

    // Check price condition
    if (order.action === 1) { // BUY
      return currentPrice <= order.limit_price_e6;
    } else { // SELL
      return currentPrice >= order.limit_price_e6;
    }
  } catch (err: any) {
    console.error(`❌ Error checking executability:`, err.message);
    return false;
  }
}

/* ==================== ORDER EXECUTION ==================== */
async function executeOrder(
  connection: Connection,
  keeper: Keypair,
  order: LimitOrder,
  signature: string,
  orderId: number
): Promise<string | null> {
  try {
    const ammPda = getAmmPda();
    const userPubkey = new PublicKey(order.user);
    const positionPda = getPositionPda(ammPda, userPubkey);
    const vaultPda = getVaultPda(ammPda);

    console.log(`\n🔧 Building transaction for order ${orderId}...`);
    console.log(`   User: ${order.user}`);
    console.log(`   Action: ${order.action === 1 ? 'BUY' : 'SELL'} ${order.side === 1 ? 'YES' : 'NO'}`);
    console.log(`   Shares: ${order.shares_e6 / 1e6}`);
    console.log(`   Limit Price: $${(order.limit_price_e6 / 1e6).toFixed(6)}`);

    // Build limit order struct for instruction
    const limitOrderStruct = {
      market: new PublicKey(order.market),
      user: userPubkey,
      action: order.action,
      side: order.side,
      sharesE6: new anchor.BN(order.shares_e6),
      limitPriceE6: new anchor.BN(order.limit_price_e6),
      maxCostE6: new anchor.BN(order.max_cost_e6),
      minProceedsE6: new anchor.BN(order.min_proceeds_e6),
      expiryTs: new anchor.BN(order.expiry_ts),
      nonce: new anchor.BN(order.nonce),
      keeperFeeBps: order.keeper_fee_bps,
      minFillBps: order.min_fill_bps,
    };

    // Convert signature from hex to Uint8Array
    const signatureBytes = Buffer.from(signature, 'hex');
    const signatureArray = Array.from(signatureBytes);

    // Create instruction data manually (simplified - actual implementation needs proper IDL)
    // For now, we'll log that we would execute
    console.log(`⚠️  Skipping actual execution (on-chain instruction not yet implemented in keeper)`);
    console.log(`   Would call: execute_limit_order with:`);
    console.log(`     - AMM: ${ammPda.toString()}`);
    console.log(`     - Position: ${positionPda.toString()}`);
    console.log(`     - Vault: ${vaultPda.toString()}`);
    console.log(`     - Keeper: ${keeper.publicKey.toString()}`);

    // TODO: Actually build and send transaction using Anchor IDL
    // const tx = await program.methods
    //   .executeLimitOrder(limitOrderStruct, signatureArray)
    //   .accounts({
    //     amm: ammPda,
    //     position: positionPda,
    //     vaultSol: vaultPda,
    //     user: userPubkey,
    //     keeper: keeper.publicKey,
    //     systemProgram: SystemProgram.programId,
    //   })
    //   .rpc();

    // For now, return a fake transaction signature for testing
    return null; // Would return tx signature

  } catch (err: any) {
    console.error(`❌ Error executing order ${orderId}:`, err.message);
    if (err.logs) {
      console.error('Transaction logs:', err.logs);
    }
    return null;
  }
}

async function markOrderFilled(
  orderId: number,
  txSignature: string,
  sharesFilled: number,
  executionPrice: number,
  keeperPubkey: string
): Promise<void> {
  try {
    await axios.post(`${ORDER_BOOK_API}/api/orders/${orderId}/fill`, {
      tx_signature: txSignature,
      shares_filled: sharesFilled,
      execution_price: executionPrice,
      keeper_pubkey: keeperPubkey,
    });
    console.log(`✅ Order ${orderId} marked as filled in database`);
  } catch (err: any) {
    console.error(`❌ Error marking order ${orderId} as filled:`, err.message);
  }
}

/* ==================== MAIN LOOP ==================== */
async function keeperLoop() {
  const keeper = loadKeeper(KEEPER_WALLET);
  const connection = new Connection(RPC, 'confirmed');
  const ammPda = getAmmPda();

  console.log('🤖 Keeper Bot Started');
  console.log('━'.repeat(60));
  console.log(`Keeper:         ${keeper.publicKey.toString()}`);
  console.log(`RPC:            ${RPC}`);
  console.log(`Order Book API: ${ORDER_BOOK_API}`);
  console.log(`AMM:            ${ammPda.toString()}`);
  console.log(`Check Interval: ${CHECK_INTERVAL}ms`);
  console.log('━'.repeat(60));

  let iteration = 0;

  while (true) {
    try {
      iteration++;
      const timestamp = new Date().toISOString();

      // Fetch pending orders
      const orders = await fetchPendingOrders();

      if (orders.length === 0) {
        if (iteration % 10 === 0) {
          console.log(`[${timestamp}] 💤 No pending orders (checked ${iteration} times)`);
        }
      } else {
        console.log(`\n[${timestamp}] 📋 Found ${orders.length} pending order(s)`);

        // Fetch AMM state
        const ammAccountInfo = await connection.getAccountInfo(ammPda);
        if (!ammAccountInfo) {
          console.error('❌ AMM account not found');
          await sleep(CHECK_INTERVAL);
          continue;
        }

        // Deserialize AMM account (simplified - would use Anchor IDL in production)
        // For now, we'll skip actual deserialization and use mock data
        const amm: AmmAccount = {
          bump: 0,
          decimals: 6,
          b: new anchor.BN(500_000_000), // b = 500
          feeBps: 25,
          qYes: new anchor.BN(0),
          qNo: new anchor.BN(0),
          fees: new anchor.BN(0),
          vaultE6: new anchor.BN(0),
          status: 1, // Open
          winner: 0,
          wTotalE6: new anchor.BN(0),
          ppsE6: new anchor.BN(0),
          feeDest: keeper.publicKey,
          vaultSolBump: 0,
          startPriceE6: new anchor.BN(0),
          startTs: new anchor.BN(0),
          settlePriceE6: new anchor.BN(0),
          settleTs: new anchor.BN(0),
          marketEndSlot: new anchor.BN(0),
          marketEndTime: new anchor.BN(0),
        };

        console.log(`📊 AMM State: qYes=${amm.qYes.toNumber() / 1e6}, qNo=${amm.qNo.toNumber() / 1e6}, status=${amm.status}`);

        // Check each order
        for (const orderData of orders) {
          const { order, signature, order_id } = orderData;

          console.log(`\n🔍 Checking order ${order_id}:`);
          console.log(`   ${order.action === 1 ? 'BUY' : 'SELL'} ${order.shares_e6 / 1e6} ${order.side === 1 ? 'YES' : 'NO'} @ limit $${(order.limit_price_e6 / 1e6).toFixed(6)}`);

          const executable = await checkIfExecutable(connection, amm, order);

          if (executable) {
            console.log(`✅ Order ${order_id} is executable!`);

            const tx = await executeOrder(connection, keeper, order, signature, order_id);

            if (tx) {
              console.log(`✅ Order ${order_id} executed: ${tx}`);

              // Mark as filled in database
              await markOrderFilled(
                order_id,
                tx,
                order.shares_e6,
                order.limit_price_e6,
                keeper.publicKey.toString()
              );
            } else {
              console.log(`⚠️  Order ${order_id} execution skipped (implementation pending)`);
            }
          } else {
            console.log(`❌ Order ${order_id} not executable yet (price condition not met or expired)`);
          }
        }
      }

    } catch (err: any) {
      console.error('❌ Error in keeper loop:', err.message);
    }

    await sleep(CHECK_INTERVAL);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ==================== START ==================== */
keeperLoop().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
