#!/usr/bin/env node
// app/submit-order.js — Submit signed limit orders to dark pool orderbook

const fs = require('fs');
const crypto = require('crypto');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const borsh = require('@coral-xyz/borsh');
const axios = require('axios');
const nacl = require('tweetnacl');

/* ---------------- CONFIG ---------------- */
const RPC = process.env.ANCHOR_PROVIDER_URL || 'http://127.0.0.1:8899';
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
const ORDER_BOOK_API = process.env.ORDER_BOOK_API || 'http://localhost:3000';

// Program IDs
const PID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v6');

/* ---------------- Borsh Schema ---------------- */
// Must match the on-chain LimitOrder struct exactly
const LimitOrderSchema = borsh.struct([
  borsh.publicKey('market'),
  borsh.publicKey('user'),
  borsh.u8('action'),
  borsh.u8('side'),
  borsh.i64('shares_e6'),
  borsh.i64('limit_price_e6'),
  borsh.i64('max_cost_e6'),
  borsh.i64('min_proceeds_e6'),
  borsh.i64('expiry_ts'),
  borsh.u64('nonce'),
  borsh.u16('keeper_fee_bps'),
  borsh.u16('min_fill_bps'),
]);

/* ---------------- Helpers ---------------- */
function loadWallet(path) {
  const rawKey = JSON.parse(fs.readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(rawKey));
}

function getAmm() {
  const [pda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  return pda;
}

function parseArg(name, defaultVal) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultVal;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

/* ---------------- Main ---------------- */
async function submitLimitOrder() {
  // Parse command line arguments
  const action = parseArg('--action');
  const side = parseArg('--side');
  const shares = parseFloat(parseArg('--shares', '0'));
  const limitPrice = parseFloat(parseArg('--price', '0'));
  const maxCost = parseArg('--max-cost') ? parseFloat(parseArg('--max-cost')) : null;
  const minProceeds = parseArg('--min-proceeds') ? parseFloat(parseArg('--min-proceeds')) : null;
  const ttl = parseInt(parseArg('--ttl', '86400')); // 24 hours default
  const keeperFeeBps = parseInt(parseArg('--keeper-fee', '10')); // 0.1% default
  const minFillBps = parseInt(parseArg('--min-fill', '5000')); // 50% default
  const marketOverride = parseArg('--market');
  const help = hasFlag('--help') || hasFlag('-h');

  if (help) {
    console.log(`
Usage: submit-order.js [options]

Submit a signed limit order to the dark pool orderbook.

Options:
  --action <1|2>          Action: 1=BUY, 2=SELL (required)
  --side <1|2>            Side: 1=YES, 2=NO (required)
  --shares <number>       Desired shares (required)
  --price <number>        Limit price (max for BUY, min for SELL) (required)
  --max-cost <number>     Max total cost for BUY orders (optional)
  --min-proceeds <number> Min proceeds for SELL orders (optional)
  --ttl <seconds>         Time to live in seconds (default: 86400 = 24h)
  --keeper-fee <bps>      Keeper fee in basis points (default: 10 = 0.1%)
  --min-fill <bps>        Minimum fill percentage (default: 5000 = 50%)
  --market <pubkey>       Market pubkey (default: derived from AMM seed)
  -h, --help              Show this help

Environment Variables:
  ANCHOR_WALLET           Path to wallet keypair (default: ~/.config/solana/id.json)
  ORDER_BOOK_API          Order book API URL (default: http://localhost:3000)

Examples:
  # Buy 100 YES shares at max $0.45 per share
  ANCHOR_WALLET=./userA.json node app/submit-order.js \\
    --action 1 --side 1 --shares 100 --price 0.45 --max-cost 50

  # Sell 50 NO shares at min $0.60 per share
  ANCHOR_WALLET=./userB.json node app/submit-order.js \\
    --action 2 --side 2 --shares 50 --price 0.60 --min-proceeds 30
    `);
    process.exit(0);
  }

  // Validate required arguments
  if (!action || !['1', '2'].includes(action)) {
    console.error('❌ Error: --action must be 1 (BUY) or 2 (SELL)');
    process.exit(1);
  }

  if (!side || !['1', '2'].includes(side)) {
    console.error('❌ Error: --side must be 1 (YES) or 2 (NO)');
    process.exit(1);
  }

  if (!shares || shares <= 0) {
    console.error('❌ Error: --shares must be a positive number');
    process.exit(1);
  }

  if (!limitPrice || limitPrice <= 0) {
    console.error('❌ Error: --price must be a positive number');
    process.exit(1);
  }

  // Load wallet
  console.log('📁 Loading wallet:', WALLET);
  const wallet = loadWallet(WALLET);
  console.log('👛 User:', wallet.publicKey.toString());

  // Get market
  const market = marketOverride ? new PublicKey(marketOverride) : getAmm();
  console.log('🏪 Market:', market.toString());

  // Create order
  const now = Math.floor(Date.now() / 1000);
  const expiryTs = now + ttl;
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);

  const order = {
    market,
    user: wallet.publicKey,
    action: parseInt(action),
    side: parseInt(side),
    shares_e6: Math.floor(shares * 1e6),
    limit_price_e6: Math.floor(limitPrice * 1e6),
    max_cost_e6: maxCost ? Math.floor(maxCost * 1e6) : Number.MAX_SAFE_INTEGER,
    min_proceeds_e6: minProceeds ? Math.floor(minProceeds * 1e6) : 0,
    expiry_ts: expiryTs,
    nonce,
    keeper_fee_bps: keeperFeeBps,
    min_fill_bps: minFillBps,
  };

  console.log('\n📝 Order Details:');
  console.log('  Action:', action === '1' ? 'BUY' : 'SELL');
  console.log('  Side:', side === '1' ? 'YES' : 'NO');
  console.log('  Shares:', shares);
  console.log('  Limit Price:', `$${limitPrice.toFixed(6)}`);
  if (maxCost) console.log('  Max Cost:', `$${maxCost.toFixed(2)}`);
  if (minProceeds) console.log('  Min Proceeds:', `$${minProceeds.toFixed(2)}`);
  console.log('  Expires:', new Date(expiryTs * 1000).toISOString(), `(${ttl}s)`);
  console.log('  Keeper Fee:', `${keeperFeeBps / 100}%`);
  console.log('  Min Fill:', `${minFillBps / 100}%`);
  console.log('  Nonce:', nonce);

  // Serialize order with Borsh (manual binary encoding)
  console.log('\n🔐 Signing order...');

  // Helper to write integers in little-endian
  function writeI64LE(value) {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigInt64LE(BigInt(value));
    return buf;
  }

  function writeU64LE(value) {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUInt64LE(BigInt(value));
    return buf;
  }

  function writeU16LE(value) {
    const buf = Buffer.allocUnsafe(2);
    buf.writeUInt16LE(value);
    return buf;
  }

  function writeU8(value) {
    return Buffer.from([value]);
  }

  // Manually encode according to Borsh layout
  const messageBytes = Buffer.concat([
    order.market.toBuffer(),                 // 32 bytes: market pubkey
    order.user.toBuffer(),                   // 32 bytes: user pubkey
    writeU8(order.action),                   // 1 byte: action
    writeU8(order.side),                     // 1 byte: side
    writeI64LE(order.shares_e6),             // 8 bytes: shares_e6
    writeI64LE(order.limit_price_e6),        // 8 bytes: limit_price_e6
    writeI64LE(order.max_cost_e6),           // 8 bytes: max_cost_e6
    writeI64LE(order.min_proceeds_e6),       // 8 bytes: min_proceeds_e6
    writeI64LE(order.expiry_ts),             // 8 bytes: expiry_ts
    writeU64LE(order.nonce),                 // 8 bytes: nonce
    writeU16LE(order.keeper_fee_bps),        // 2 bytes: keeper_fee_bps
    writeU16LE(order.min_fill_bps),          // 2 bytes: min_fill_bps
  ]);

  // Sign with wallet using Ed25519
  const signature = nacl.sign.detached(messageBytes, wallet.secretKey);
  const signatureHex = Buffer.from(signature).toString('hex');

  console.log('✅ Signature:', signatureHex.slice(0, 32) + '...');

  // Compute order hash
  const orderHash = crypto.createHash('sha256').update(messageBytes).digest('hex');
  console.log('🔑 Order Hash:', orderHash.slice(0, 32) + '...');

  // Convert order to JSON-friendly format
  const orderJson = {
    market: order.market.toString(),
    user: order.user.toString(),
    action: order.action,
    side: order.side,
    shares_e6: order.shares_e6,
    limit_price_e6: order.limit_price_e6,
    max_cost_e6: order.max_cost_e6,
    min_proceeds_e6: order.min_proceeds_e6,
    expiry_ts: order.expiry_ts,
    nonce: order.nonce,
    keeper_fee_bps: order.keeper_fee_bps,
    min_fill_bps: order.min_fill_bps,
  };

  // Submit to order book API
  console.log('\n📤 Submitting to order book API:', ORDER_BOOK_API);

  try {
    const response = await axios.post(`${ORDER_BOOK_API}/api/orders/submit`, {
      order: orderJson,
      signature: signatureHex,
    });

    console.log('✅ Order submitted successfully!');
    console.log('   Order ID:', response.data.order_id);
    console.log('   Order Hash:', response.data.order_hash);
    console.log('\n💡 View order status:');
    console.log(`   curl ${ORDER_BOOK_API}/api/orders/${response.data.order_id}`);

  } catch (err) {
    console.error('\n❌ Error submitting order:');
    if (err.response) {
      console.error('   Status:', err.response.status);
      console.error('   Error:', err.response.data.error || err.response.data);
    } else {
      console.error('   ', err.message);
    }
    process.exit(1);
  }
}

// Run
submitLimitOrder().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
