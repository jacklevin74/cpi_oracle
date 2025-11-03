# Dark Pool Limit Orders - Technical Implementation Specification

**Version**: 1.0
**Date**: 2025-11-03
**Architecture**: Fully Off-Chain (Option 1)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Data Structures](#3-data-structures)
4. [Signature Scheme](#4-signature-scheme)
5. [On-Chain Implementation](#5-on-chain-implementation)
6. [Off-Chain Infrastructure](#6-off-chain-infrastructure)
7. [Order Lifecycle](#7-order-lifecycle)
8. [Security Model](#8-security-model)
9. [API Specifications](#9-api-specifications)
10. [Implementation Phases](#10-implementation-phases)
11. [Testing Strategy](#11-testing-strategy)
12. [Performance & Costs](#12-performance--costs)

---

## 1. System Overview

### 1.1 Goal

Enable users to place signed limit orders (BUY/SELL at specific prices) that execute automatically when market conditions are met, without revealing order details publicly until execution.

### 1.2 Key Features

- **Limit Orders**: BUY YES/NO at max price, SELL YES/NO at min price
- **Dark Pool Privacy**: Orders hidden until matched/executed
- **Automatic Execution**: Orders fill when AMM price crosses limit price
- **Zero-Cost Submission**: No gas fees to place orders (signature only)
- **Signed Messages**: Off-chain signing, on-chain verification
- **Keeper Network**: Decentralized bot execution with fee incentives
- **Replay Protection**: Nonce-based prevention of duplicate executions

### 1.3 Design Philosophy

**Fully Off-Chain Storage**:
- Order signatures stored off-chain (database/IPFS)
- NO on-chain order queue or commitments
- Security via Ed25519 signature verification at execution time
- Lower costs, higher scalability, simpler architecture

---

## 2. Architecture

### 2.1 Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         USER                                 │
│  - Creates limit order                                       │
│  - Signs with wallet (Ed25519)                              │
│  - Submits to order book API                                │
└────────────┬────────────────────────────────────────────────┘
             │ HTTPS POST
             ↓
┌─────────────────────────────────────────────────────────────┐
│                   ORDER BOOK API                             │
│  - Stores signed orders (SQLite embedded database)          │
│  - Validates signature format                               │
│  - Indexes by market/side/price                             │
│  - Serves pending orders to keepers                         │
└────────────┬────────────────────────────────────────────────┘
             │ REST API
             ↓
┌─────────────────────────────────────────────────────────────┐
│                    KEEPER BOTS                               │
│  - Poll for executable orders (every 2s)                    │
│  - Check AMM price vs limit price                           │
│  - Submit execution txs to Solana                           │
│  - Compete for keeper fees                                  │
└────────────┬────────────────────────────────────────────────┘
             │ Solana RPC
             ↓
┌─────────────────────────────────────────────────────────────┐
│                 SOLANA PROGRAM                               │
│  - Verifies Ed25519 signature                               │
│  - Checks price condition                                   │
│  - Prevents nonce replay                                    │
│  - Executes trade via existing LMSR logic                   │
│  - Pays keeper fee                                          │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Trust Model

| Component | Trust Assumption | Mitigation |
|-----------|------------------|------------|
| **Order Book API** | Could hide/delete orders | Users can submit to multiple DBs; Run own keeper |
| **Keeper Bots** | Could execute unfavorable orders | On-chain price check prevents this |
| **Solana Program** | Trustless | Open source, on-chain verification |
| **User Signature** | Trustless | Ed25519 cryptographic guarantee |

**Key Insight**: Database cannot forge orders (no private key). Keepers cannot execute unfavorable orders (on-chain price check). System is trustless where it matters.

---

## 3. Data Structures

### 3.1 On-Chain Structures

#### 3.1.1 LimitOrder (Passed as Instruction Argument)

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LimitOrder {
    /// Market this order is for
    pub market: Pubkey,

    /// User who owns this order
    pub user: Pubkey,

    /// Action: 1=BUY, 2=SELL
    pub action: u8,

    /// Side: 1=YES, 2=NO
    pub side: u8,

    /// Desired shares (1e6 scale)
    pub shares_e6: i64,

    /// Limit price (1e6 scale)
    /// - For BUY: maximum price willing to pay
    /// - For SELL: minimum price to accept
    pub limit_price_e6: i64,

    /// Maximum cost (for BUY orders, 1e6 scale)
    /// Set to i64::MAX if no limit
    pub max_cost_e6: i64,

    /// Minimum proceeds (for SELL orders, 1e6 scale)
    /// Set to 0 if no limit
    pub min_proceeds_e6: i64,

    /// Unix timestamp when order expires
    pub expiry_ts: i64,

    /// Unique nonce to prevent replay attacks
    /// Recommended: use timestamp_micros or random u64
    pub nonce: u64,

    /// Keeper fee in basis points (10 = 0.1%, 100 = 1%)
    /// Paid from trade proceeds to keeper
    pub keeper_fee_bps: u16,

    /// Minimum fill percentage (basis points)
    /// E.g., 5000 = must fill at least 50% of order
    /// Set to 0 to allow any partial fill
    pub min_fill_bps: u16,
}
```

**Size**: ~120 bytes
**Storage**: Passed as instruction argument, NOT stored on-chain

#### 3.1.2 Position Account (Modified)

```rust
#[account]
pub struct Position {
    pub amm: Pubkey,
    pub user: Pubkey,
    pub shares_yes_e6: i64,
    pub shares_no_e6: i64,
    pub bump: u8,

    // NEW: Track used nonces to prevent replay attacks
    // Rolling window of last 1000 nonces (or use HashMap in future)
    pub used_nonces: Vec<u64>,
}
```

**Storage Impact**:
- Each nonce: 8 bytes
- Store last 1000 nonces: 8KB
- Alternative: Use Merkle tree or external PDA per nonce (more complex)

**Nonce Cleanup Strategy**:
- Keep rolling window of last 1000 nonces
- Oldest nonces automatically evicted
- Prevents unbounded growth
- Users should use recent timestamps as nonces

### 3.2 Off-Chain Structures (Database)

#### 3.2.1 Orders Table (SQL Schema)

```sql
CREATE TABLE orders (
    -- Primary key: unique order identifier
    id SERIAL PRIMARY KEY,

    -- Order hash (SHA256 of serialized order)
    -- Used for quick lookups and deduplication
    order_hash TEXT UNIQUE NOT NULL,

    -- Full order details (JSON)
    order_json JSONB NOT NULL,

    -- User's Ed25519 signature (hex-encoded)
    signature TEXT NOT NULL,

    -- Indexed fields for efficient queries
    market TEXT NOT NULL,
    user_pubkey TEXT NOT NULL,
    action SMALLINT NOT NULL,  -- 1=BUY, 2=SELL
    side SMALLINT NOT NULL,    -- 1=YES, 2=NO
    limit_price_e6 BIGINT NOT NULL,
    shares_e6 BIGINT NOT NULL,
    expiry_ts BIGINT NOT NULL,

    -- Order status
    status TEXT NOT NULL DEFAULT 'pending',
    -- Status values: 'pending', 'filled', 'cancelled', 'expired', 'failed'

    -- Execution details (if filled)
    filled_tx TEXT,
    filled_at TIMESTAMP,
    filled_shares_e6 BIGINT,
    execution_price_e6 BIGINT,
    keeper_pubkey TEXT,

    -- Metadata
    submitted_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    -- Indexes for common queries
    INDEX idx_status (status),
    INDEX idx_market_status (market, status),
    INDEX idx_user (user_pubkey),
    INDEX idx_expiry (expiry_ts),
    INDEX idx_price (market, action, side, limit_price_e6)
);
```

#### 3.2.2 Example Order JSON

```json
{
  "market": "Gv7... (Pubkey)",
  "user": "8xF... (Pubkey)",
  "action": 1,
  "side": 1,
  "shares_e6": 100000000,
  "limit_price_e6": 450000,
  "max_cost_e6": 50000000,
  "min_proceeds_e6": 0,
  "expiry_ts": 1699200000,
  "nonce": 1699100000123456,
  "keeper_fee_bps": 10,
  "min_fill_bps": 5000
}
```

---

## 4. Signature Scheme

### 4.1 Message Format

```
message = borsh_serialize(LimitOrder)
```

**Borsh Serialization** (same as Anchor uses):
- Deterministic binary format
- Field order matches struct definition
- Fixed-size types (u8, i64, Pubkey)

### 4.2 Signature Generation (Client-Side)

```typescript
import { PublicKey, Keypair } from '@solana/web3.js';
import * as borsh from 'borsh';
import nacl from 'tweetnacl';

// Define borsh schema
const LimitOrderSchema = {
  struct: {
    market: { array: { type: 'u8', len: 32 } },
    user: { array: { type: 'u8', len: 32 } },
    action: 'u8',
    side: 'u8',
    shares_e6: 'i64',
    limit_price_e6: 'i64',
    max_cost_e6: 'i64',
    min_proceeds_e6: 'i64',
    expiry_ts: 'i64',
    nonce: 'u64',
    keeper_fee_bps: 'u16',
    min_fill_bps: 'u16',
  }
};

function signOrder(order: LimitOrder, keypair: Keypair): Uint8Array {
  // Serialize order to bytes
  const message = borsh.serialize(LimitOrderSchema, order);

  // Sign with Ed25519
  const signature = nacl.sign.detached(message, keypair.secretKey);

  return signature; // 64 bytes
}
```

### 4.3 Signature Verification (On-Chain)

```rust
use solana_program::ed25519_program;
use solana_program::sysvar::instructions;

pub fn execute_limit_order(
    ctx: Context<ExecuteLimitOrder>,
    order: LimitOrder,
    signature: [u8; 64],
) -> Result<()> {
    // Serialize order to bytes (same format as client)
    let message = order.try_to_vec()?;

    // Verify Ed25519 signature
    let pubkey = order.user.to_bytes();
    ed25519_verify(&message, &signature, &pubkey)?;

    // Continue with execution...
}

// Helper function for Ed25519 verification
pub fn ed25519_verify(
    message: &[u8],
    signature: &[u8; 64],
    pubkey: &[u8; 32],
) -> Result<()> {
    // Use Solana's native Ed25519 verification
    // (This is a simplified example - actual implementation uses sysvar)

    require!(
        ed25519_dalek::Signature::from_bytes(signature)
            .and_then(|sig| {
                ed25519_dalek::PublicKey::from_bytes(pubkey)
                    .and_then(|pk| Ok(pk.verify(message, &sig).is_ok()))
            })
            .unwrap_or(false),
        ErrorCode::InvalidSignature
    );

    Ok(())
}
```

**Alternative**: Use Solana's Ed25519 sysvar for native verification (cheaper compute):

```rust
// More efficient method using Ed25519 instruction sysvar
pub fn verify_ed25519_ix(
    ix_sysvar: &AccountInfo,
    signature: &[u8; 64],
    pubkey: &[u8; 32],
    message: &[u8],
) -> Result<()> {
    let ix_data = ix_sysvar.data.borrow();

    // Verify this transaction includes an Ed25519 instruction
    // with matching signature, pubkey, and message
    // (Implementation details in Solana Ed25519 program docs)

    Ok(())
}
```

### 4.4 Nonce Selection

**Recommended Nonce Strategy**:

```typescript
// Use microsecond timestamp + random bits
const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
```

**Properties**:
- Unique across orders (timestamp + randomness)
- Monotonically increasing (timestamp)
- Impossible to predict future nonces
- Prevents replay attacks

---

## 5. On-Chain Implementation

### 5.1 New Instruction: `execute_limit_order`

```rust
/// Execute a user's signed limit order
///
/// Validates signature, checks price condition, and executes trade
/// on behalf of the user. Keeper receives fee for executing.
pub fn execute_limit_order(
    ctx: Context<ExecuteLimitOrder>,
    order: LimitOrder,
    signature: [u8; 64],
) -> Result<()> {
    let amm = &ctx.accounts.amm;
    let position = &mut ctx.accounts.position;
    let clock = Clock::get()?;

    // === VALIDATION PHASE ===

    // 1. Verify Ed25519 signature
    let message = order.try_to_vec()?;
    ed25519_verify(&message, &signature, &order.user.to_bytes())?;
    msg!("✅ Signature verified for user {}", order.user);

    // 2. Verify order matches this market
    require_keys_eq!(order.market, amm.key(), ErrorCode::WrongMarket);

    // 3. Verify order owner matches position owner
    require_keys_eq!(order.user, position.user, ErrorCode::WrongUser);

    // 4. Check order not expired
    require!(
        order.expiry_ts > clock.unix_timestamp,
        ErrorCode::OrderExpired
    );
    msg!("⏱️  Order valid until {}", order.expiry_ts);

    // 5. Check nonce not already used
    require!(
        !position.used_nonces.contains(&order.nonce),
        ErrorCode::NonceAlreadyUsed
    );

    // 6. Check market is open
    require!(amm.market_state == 1, ErrorCode::MarketNotOpen);

    // === PRICE CHECK PHASE ===

    // Calculate current price for this action/side
    let current_price = calculate_avg_price_for_one_share(
        order.action,
        order.side,
        amm,
    )?;

    msg!("💰 Current price: {} | Limit: {}", current_price, order.limit_price_e6);

    // Verify price condition is favorable
    let price_ok = match order.action {
        1 => { // BUY: current price must be <= limit price
            current_price <= order.limit_price_e6
        }
        2 => { // SELL: current price must be >= limit price
            current_price >= order.limit_price_e6
        }
        _ => return err!(ErrorCode::InvalidAction),
    };

    require!(price_ok, ErrorCode::PriceConditionNotMet);
    msg!("✅ Price condition satisfied");

    // === EXECUTION PHASE ===

    // Build guards for partial fill logic (reuse existing code)
    let guards = AdvancedGuardConfig {
        has_price_limit: true,
        price_limit_e6: order.limit_price_e6,
        has_slippage_guard: false,
        max_slippage_bps: 0,
        quote_price_e6: current_price,
        has_cost_limit: order.max_cost_e6 < i64::MAX,
        cost_limit_e6: order.max_cost_e6,
        min_fill_shares_e6: (order.shares_e6 as i128 * order.min_fill_bps as i128 / 10000) as i64,
    };

    // Find max executable shares (uses Newton-Raphson or binary search)
    let executable_shares = find_max_executable_shares(
        order.action,
        order.side,
        order.shares_e6,
        &guards,
        amm,
    )?;

    msg!("📊 Executing {} of {} shares", executable_shares, order.shares_e6);

    // Execute trade using existing logic
    let trade_result = execute_trade_internal(
        order.action,
        order.side,
        executable_shares,
        amm,
        position,
        &ctx.accounts.vault_sol,
        &ctx.accounts.user,
        &ctx.accounts.system_program,
    )?;

    // === FEE PAYMENT PHASE ===

    // Calculate keeper fee
    let keeper_fee_lamports = (trade_result.cost_or_proceeds as i128
        * order.keeper_fee_bps as i128
        / 10_000) as u64
        * LAMPORTS_PER_E6;

    // Transfer keeper fee from user to keeper
    if keeper_fee_lamports > 0 {
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &order.user,
            ctx.accounts.keeper.key,
            keeper_fee_lamports,
        );

        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.keeper.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        msg!("💸 Keeper fee paid: {} lamports to {}",
             keeper_fee_lamports, ctx.accounts.keeper.key);
    }

    // === CLEANUP PHASE ===

    // Mark nonce as used
    position.used_nonces.push(order.nonce);

    // Keep only last 1000 nonces (prevent unbounded growth)
    if position.used_nonces.len() > 1000 {
        position.used_nonces.remove(0);
    }

    // Emit event
    emit!(LimitOrderExecuted {
        user: order.user,
        keeper: *ctx.accounts.keeper.key,
        action: order.action,
        side: order.side,
        shares_requested: order.shares_e6,
        shares_executed: executable_shares,
        limit_price: order.limit_price_e6,
        execution_price: trade_result.avg_price_e6,
        keeper_fee_bps: order.keeper_fee_bps,
        nonce: order.nonce,
    });

    Ok(())
}
```

### 5.2 Accounts Context

```rust
#[derive(Accounts)]
pub struct ExecuteLimitOrder<'info> {
    #[account(mut)]
    pub amm: Account<'info, Amm>,

    #[account(
        mut,
        seeds = [b"pos", amm.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [b"vault_sol", amm.key().as_ref()],
        bump,
    )]
    pub vault_sol: SystemAccount<'info>,

    /// CHECK: User whose order is being executed
    #[account(mut)]
    pub user: AccountInfo<'info>,

    /// Keeper who is executing the order (receives fee)
    #[account(mut)]
    pub keeper: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

### 5.3 New Instruction: `cancel_order_nonce`

```rust
/// Allow users to burn a nonce to prevent future execution
///
/// Useful if user wants to cancel an order before it executes
pub fn cancel_order_nonce(
    ctx: Context<CancelOrderNonce>,
    nonce: u64,
) -> Result<()> {
    let position = &mut ctx.accounts.position;

    // Add nonce to used list (prevents execution)
    require!(
        !position.used_nonces.contains(&nonce),
        ErrorCode::NonceAlreadyUsed
    );

    position.used_nonces.push(nonce);

    if position.used_nonces.len() > 1000 {
        position.used_nonces.remove(0);
    }

    emit!(OrderNonceCancelled {
        user: position.user,
        nonce,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelOrderNonce<'info> {
    #[account(mut)]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub user: Signer<'info>,
}
```

### 5.4 Error Codes

```rust
#[error_code]
pub enum ErrorCode {
    // ... existing errors ...

    #[msg("Invalid Ed25519 signature")]
    InvalidSignature,

    #[msg("Order has expired")]
    OrderExpired,

    #[msg("Nonce has already been used")]
    NonceAlreadyUsed,

    #[msg("Price condition not met")]
    PriceConditionNotMet,

    #[msg("Wrong market for this order")]
    WrongMarket,

    #[msg("Wrong user for this position")]
    WrongUser,

    #[msg("Invalid action (must be 1=BUY or 2=SELL)")]
    InvalidAction,
}
```

### 5.5 Events

```rust
#[event]
pub struct LimitOrderExecuted {
    pub user: Pubkey,
    pub keeper: Pubkey,
    pub action: u8,
    pub side: u8,
    pub shares_requested: i64,
    pub shares_executed: i64,
    pub limit_price: i64,
    pub execution_price: i64,
    pub keeper_fee_bps: u16,
    pub nonce: u64,
}

#[event]
pub struct OrderNonceCancelled {
    pub user: Pubkey,
    pub nonce: u64,
}
```

---

## 6. Off-Chain Infrastructure

### 6.1 Order Book API

**Technology Stack**:
- Node.js + Express.js
- SQLite3 (embedded database, single file: `orders.db`)
- No separate database server required
- Optional: PostgreSQL for distributed keeper networks

**Endpoints**:

#### POST `/api/orders/submit`

Submit a new signed order.

**Request**:
```json
{
  "order": {
    "market": "Gv7...",
    "user": "8xF...",
    "action": 1,
    "side": 1,
    "shares_e6": 100000000,
    "limit_price_e6": 450000,
    "max_cost_e6": 50000000,
    "min_proceeds_e6": 0,
    "expiry_ts": 1699200000,
    "nonce": 1699100000123456,
    "keeper_fee_bps": 10,
    "min_fill_bps": 5000
  },
  "signature": "a1b2c3d4..." // 128 hex chars (64 bytes)
}
```

**Response**:
```json
{
  "success": true,
  "order_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "order_id": 12345
}
```

#### GET `/api/orders/pending`

Get all pending orders (for keepers).

**Query Parameters**:
- `market` (optional): Filter by market pubkey
- `action` (optional): Filter by action (1=BUY, 2=SELL)
- `side` (optional): Filter by side (1=YES, 2=NO)
- `limit` (optional): Max results (default 100)

**Response**:
```json
{
  "orders": [
    {
      "order_id": 12345,
      "order_hash": "9f86...",
      "order": { /* full order object */ },
      "signature": "a1b2c3d4...",
      "submitted_at": "2025-11-03T10:30:00Z"
    },
    // ... more orders
  ]
}
```

#### GET `/api/orders/user/:pubkey`

Get all orders for a specific user.

**Response**:
```json
{
  "orders": [
    {
      "order_id": 12345,
      "status": "pending",
      "order": { /* full order */ },
      "submitted_at": "2025-11-03T10:30:00Z",
      "filled_at": null,
      "filled_tx": null
    }
  ]
}
```

#### POST `/api/orders/:order_id/fill`

Mark order as filled (called by keeper after successful execution).

**Request**:
```json
{
  "tx_signature": "5xYz9...",
  "shares_filled": 95000000,
  "execution_price": 455000,
  "keeper_pubkey": "7pQ..."
}
```

#### POST `/api/orders/:order_id/cancel`

Mark order as cancelled by user.

**Authentication**: Requires signed message from order owner.

### 6.2 Order Submission Client

**File**: `app/submit-order.js`

```javascript
const anchor = require('@project-serum/anchor');
const { PublicKey, Keypair } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const borsh = require('borsh');
const axios = require('axios');
const crypto = require('crypto');

const ORDER_BOOK_API = process.env.ORDER_BOOK_API || 'http://localhost:3000';

// Borsh schema for LimitOrder
class LimitOrder {
  constructor(fields) {
    Object.assign(this, fields);
  }

  static schema = new Map([
    [LimitOrder, {
      kind: 'struct',
      fields: [
        ['market', [32]],
        ['user', [32]],
        ['action', 'u8'],
        ['side', 'u8'],
        ['shares_e6', 'i64'],
        ['limit_price_e6', 'i64'],
        ['max_cost_e6', 'i64'],
        ['min_proceeds_e6', 'i64'],
        ['expiry_ts', 'i64'],
        ['nonce', 'u64'],
        ['keeper_fee_bps', 'u16'],
        ['min_fill_bps', 'u16'],
      ],
    }],
  ]);
}

async function submitLimitOrder(params) {
  const wallet = anchor.Wallet.local();

  // Create order
  const order = new LimitOrder({
    market: new PublicKey(params.market).toBytes(),
    user: wallet.publicKey.toBytes(),
    action: params.action, // 1=BUY, 2=SELL
    side: params.side,     // 1=YES, 2=NO
    shares_e6: params.shares * 1e6,
    limit_price_e6: params.limitPrice * 1e6,
    max_cost_e6: params.maxCost ? params.maxCost * 1e6 : Number.MAX_SAFE_INTEGER,
    min_proceeds_e6: params.minProceeds ? params.minProceeds * 1e6 : 0,
    expiry_ts: Math.floor(Date.now() / 1000) + params.ttlSeconds,
    nonce: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    keeper_fee_bps: params.keeperFeeBps || 10, // 0.1%
    min_fill_bps: params.minFillBps || 5000,   // 50%
  });

  // Serialize order
  const orderBytes = borsh.serialize(LimitOrder.schema, order);

  // Sign order
  const signature = nacl.sign.detached(orderBytes, wallet.payer.secretKey);

  // Compute order hash
  const orderHash = crypto.createHash('sha256').update(orderBytes).digest('hex');

  // Convert order to JSON-friendly format
  const orderJson = {
    market: new PublicKey(order.market).toString(),
    user: new PublicKey(order.user).toString(),
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
  const response = await axios.post(`${ORDER_BOOK_API}/api/orders/submit`, {
    order: orderJson,
    signature: Buffer.from(signature).toString('hex'),
  });

  console.log('✅ Order submitted successfully!');
  console.log('Order Hash:', orderHash);
  console.log('Order ID:', response.data.order_id);
  console.log('Expires:', new Date(order.expiry_ts * 1000).toISOString());

  return {
    orderHash,
    orderId: response.data.order_id,
    order: orderJson,
  };
}

// CLI interface
if (require.main === module) {
  const args = require('minimist')(process.argv.slice(2));

  submitLimitOrder({
    market: args.market || process.env.MARKET_PUBKEY,
    action: args.action, // 1=BUY, 2=SELL
    side: args.side,     // 1=YES, 2=NO
    shares: parseFloat(args.shares),
    limitPrice: parseFloat(args.price),
    maxCost: args['max-cost'] ? parseFloat(args['max-cost']) : null,
    minProceeds: args['min-proceeds'] ? parseFloat(args['min-proceeds']) : null,
    ttlSeconds: args.ttl || 86400, // 24 hours default
    keeperFeeBps: args['keeper-fee'] || 10,
    minFillBps: args['min-fill'] || 5000,
  }).catch(console.error);
}

module.exports = { submitLimitOrder };
```

**Usage**:
```bash
# Buy 100 YES shares at max $0.45 per share
ANCHOR_WALLET=./userA.json node app/submit-order.js \
  --action 1 \
  --side 1 \
  --shares 100 \
  --price 0.45 \
  --max-cost 50 \
  --ttl 86400 \
  --keeper-fee 10

# Sell 50 NO shares at min $0.60 per share
ANCHOR_WALLET=./userB.json node app/submit-order.js \
  --action 2 \
  --side 2 \
  --shares 50 \
  --price 0.60 \
  --min-proceeds 30 \
  --ttl 3600
```

### 6.3 Keeper Bot

**File**: `app/keeper.js`

```javascript
const anchor = require('@project-serum/anchor');
const { Connection, PublicKey, SystemProgram } = require('@solana/web3.js');
const axios = require('axios');

const ORDER_BOOK_API = process.env.ORDER_BOOK_API || 'http://localhost:3000';
const CHECK_INTERVAL = 2000; // 2 seconds

async function keeperLoop() {
  const provider = anchor.AnchorProvider.env();
  const program = anchor.workspace.CpiOracle;
  const keeper = provider.wallet;

  console.log('🤖 Keeper bot started');
  console.log('Keeper:', keeper.publicKey.toString());

  while (true) {
    try {
      // Fetch pending orders
      const { data } = await axios.get(`${ORDER_BOOK_API}/api/orders/pending`);

      for (const orderData of data.orders) {
        const { order, signature, order_id } = orderData;

        // Check if order is executable
        const executable = await checkExecutable(program, order);

        if (executable) {
          console.log(`🎯 Executing order ${order_id}...`);

          try {
            const tx = await executeOrder(program, order, signature, keeper);
            console.log(`✅ Order ${order_id} executed: ${tx}`);

            // Mark as filled
            await axios.post(`${ORDER_BOOK_API}/api/orders/${order_id}/fill`, {
              tx_signature: tx,
              keeper_pubkey: keeper.publicKey.toString(),
            });

          } catch (err) {
            console.error(`❌ Execution failed for order ${order_id}:`, err.message);
          }
        }
      }

    } catch (err) {
      console.error('Error in keeper loop:', err.message);
    }

    await sleep(CHECK_INTERVAL);
  }
}

async function checkExecutable(program, order) {
  try {
    const amm = await program.account.amm.fetch(new PublicKey(order.market));

    // Check market is open
    if (amm.marketState !== 1) return false;

    // Check not expired
    const now = Math.floor(Date.now() / 1000);
    if (order.expiry_ts <= now) return false;

    // Calculate current price
    const currentPrice = calculateCurrentPrice(amm, order.action, order.side);

    // Check price condition
    if (order.action === 1) { // BUY
      return currentPrice <= order.limit_price_e6;
    } else { // SELL
      return currentPrice >= order.limit_price_e6;
    }

  } catch (err) {
    return false;
  }
}

async function executeOrder(program, order, signatureHex, keeper) {
  const [ammPda] = await PublicKey.findProgramAddress(
    [Buffer.from('amm_btc_v6')],
    program.programId
  );

  const userPubkey = new PublicKey(order.user);

  const [positionPda] = await PublicKey.findProgramAddress(
    [Buffer.from('pos'), ammPda.toBuffer(), userPubkey.toBuffer()],
    program.programId
  );

  const [vaultPda] = await PublicKey.findProgramAddress(
    [Buffer.from('vault_sol'), ammPda.toBuffer()],
    program.programId
  );

  // Convert signature from hex
  const signature = Buffer.from(signatureHex, 'hex');

  // Convert order to program format
  const orderStruct = {
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

  const tx = await program.methods
    .executeLimitOrder(orderStruct, Array.from(signature))
    .accounts({
      amm: ammPda,
      position: positionPda,
      vaultSol: vaultPda,
      user: userPubkey,
      keeper: keeper.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return tx;
}

function calculateCurrentPrice(amm, action, side) {
  // Simplified - calculate price for 1 share
  const q_yes = amm.qYesE6 / 1e6;
  const q_no = amm.qNoE6 / 1e6;
  const b = amm.b / 1e6;

  const shares = 1; // price for 1 share

  if (action === 1) { // BUY
    const delta_q = side === 1 ? shares : -shares;
    const cost = b * Math.log(
      (Math.exp((q_yes + delta_q) / b) + Math.exp((q_no - delta_q) / b)) /
      (Math.exp(q_yes / b) + Math.exp(q_no / b))
    );
    return Math.floor(cost * 1e6);
  } else { // SELL
    const delta_q = side === 1 ? -shares : shares;
    const proceeds = -b * Math.log(
      (Math.exp((q_yes + delta_q) / b) + Math.exp((q_no - delta_q) / b)) /
      (Math.exp(q_yes / b) + Math.exp(q_no / b))
    );
    return Math.floor(proceeds * 1e6);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (require.main === module) {
  keeperLoop().catch(console.error);
}

module.exports = { keeperLoop, checkExecutable, executeOrder };
```

**Usage**:
```bash
# Run keeper bot
ANCHOR_PROVIDER_URL=http://localhost:8899 \
ANCHOR_WALLET=./keeper.json \
ORDER_BOOK_API=http://localhost:3000 \
node app/keeper.js
```

---

## 7. Order Lifecycle

### 7.1 Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: USER CREATES ORDER                                  │
│                                                              │
│ User decides: "Buy 100 YES @ max $0.45"                     │
│                                                              │
│ ┌─────────────────────────────────────────────────────┐    │
│ │ Client: submit-order.js                              │    │
│ │                                                       │    │
│ │ 1. Create LimitOrder struct                          │    │
│ │ 2. Serialize with Borsh                              │    │
│ │ 3. Sign with wallet (Ed25519)                        │    │
│ │ 4. Compute SHA256 hash                               │    │
│ │ 5. POST to order book API                            │    │
│ └─────────────────────────────────────────────────────┘    │
└───────────────────────┬──────────────────────────────────────┘
                        │ HTTPS
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: API STORES ORDER                                    │
│                                                              │
│ ┌─────────────────────────────────────────────────────┐    │
│ │ Order Book API                                       │    │
│ │                                                       │    │
│ │ 1. Validate signature format                         │    │
│ │ 2. Insert into SQLite database                       │    │
│ │ 3. Index by market/price                             │    │
│ │ 4. Return order_id                                   │    │
│ └─────────────────────────────────────────────────────┘    │
│                                                              │
│ Status: PENDING                                             │
└───────────────────────┬──────────────────────────────────────┘
                        │ REST API
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 3: KEEPER MONITORS                                     │
│                                                              │
│ ┌─────────────────────────────────────────────────────┐    │
│ │ Keeper Bot (keeper.js)                               │    │
│ │                                                       │    │
│ │ Loop every 2 seconds:                                │    │
│ │   1. Fetch pending orders                            │    │
│ │   2. Fetch current AMM state                         │    │
│ │   3. Calculate current price                         │    │
│ │   4. Check: current_price <= limit_price?            │    │
│ │   5. If YES → execute                                │    │
│ └─────────────────────────────────────────────────────┘    │
│                                                              │
│ Waiting for: current_price <= $0.45                         │
└───────────────────────┬──────────────────────────────────────┘
                        │ Solana RPC
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 4: PRICE CROSSES → EXECUTION                           │
│                                                              │
│ Current price drops to $0.44 ✅                             │
│                                                              │
│ ┌─────────────────────────────────────────────────────┐    │
│ │ Keeper submits transaction:                          │    │
│ │                                                       │    │
│ │ program.methods.executeLimitOrder(                   │    │
│ │   order,      // Full order details                  │    │
│ │   signature   // User's signature                    │    │
│ │ )                                                     │    │
│ └─────────────────────────────────────────────────────┘    │
└───────────────────────┬──────────────────────────────────────┘
                        │ Transaction
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 5: ON-CHAIN VALIDATION                                 │
│                                                              │
│ ┌─────────────────────────────────────────────────────┐    │
│ │ Solana Program: execute_limit_order()                │    │
│ │                                                       │    │
│ │ ✅ Verify Ed25519 signature                          │    │
│ │ ✅ Check expiry (not expired)                        │    │
│ │ ✅ Check nonce (not used)                            │    │
│ │ ✅ Check price ($0.44 <= $0.45)                      │    │
│ │ ✅ Find max executable shares                        │    │
│ │ ✅ Execute trade via LMSR                            │    │
│ │ ✅ Transfer shares to user position                  │    │
│ │ ✅ Pay keeper fee                                    │    │
│ │ ✅ Mark nonce as used                                │    │
│ └─────────────────────────────────────────────────────┘    │
│                                                              │
│ Result: 100 YES shares @ $0.442 avg price                   │
│         Keeper fee: 0.044 SOL                               │
└───────────────────────┬──────────────────────────────────────┘
                        │ Event
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 6: UPDATE STATUS                                       │
│                                                              │
│ ┌─────────────────────────────────────────────────────┐    │
│ │ Keeper calls API:                                    │    │
│ │                                                       │    │
│ │ POST /api/orders/12345/fill                          │    │
│ │ {                                                     │    │
│ │   tx_signature: "5xYz...",                           │    │
│ │   shares_filled: 100000000,                          │    │
│ │   execution_price: 442000                            │    │
│ │ }                                                     │    │
│ └─────────────────────────────────────────────────────┘    │
│                                                              │
│ Status: FILLED ✅                                           │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 State Transitions

```
PENDING → FILLED     (successful execution)
PENDING → EXPIRED    (expiry_ts passed, no execution)
PENDING → CANCELLED  (user cancelled nonce on-chain)
PENDING → FAILED     (execution attempted but failed)
```

### 7.3 Timing Examples

**Scenario 1: Immediate Execution**
```
T+0s: User submits BUY 100 YES @ $0.50
      Current price: $0.45 ✅ (already favorable)
T+2s: Keeper detects order, executes immediately
T+3s: Order filled
```

**Scenario 2: Wait for Price**
```
T+0s:    User submits BUY 100 YES @ $0.45
         Current price: $0.52 ❌
T+120s:  Current price: $0.48 ❌
T+300s:  Current price: $0.44 ✅
T+302s:  Keeper executes
T+303s:  Order filled
```

**Scenario 3: Expiry**
```
T+0s:     User submits SELL 50 NO @ $0.60 (expiry: 1 hour)
          Current price: $0.55 ❌
T+3600s:  Order expires (current price never reached $0.60)
T+3602s:  Keeper ignores order (expired)
Status:   EXPIRED
```

---

## 8. Security Model

### 8.1 Threat Model

| Attack Vector | Mitigation |
|---------------|------------|
| **Forged Orders** | Ed25519 signature verification on-chain |
| **Replay Attacks** | Nonce tracking in Position account |
| **Frontrunning** | Orders hidden off-chain; price check on-chain |
| **Unfavorable Execution** | On-chain price validation before execution |
| **Database Tampering** | Signature invalidates if order modified |
| **Keeper Collusion** | Multiple independent keepers; users can run own |
| **Expired Order Execution** | On-chain timestamp check |
| **Nonce Reuse** | Nonce marked as used in Position account |

### 8.2 Security Properties

**Cryptographic Guarantees**:
1. ✅ **Authenticity**: Only user with private key can create valid orders
2. ✅ **Integrity**: Order modification invalidates signature
3. ✅ **Non-repudiation**: User cannot deny creating signed order
4. ✅ **Uniqueness**: Nonce prevents duplicate execution

**Economic Security**:
1. ✅ **Keeper Incentives**: Fee rewards honest execution
2. ✅ **Partial Fill Protection**: `min_fill_bps` prevents dust execution
3. ✅ **Price Protection**: Limit price prevents unfavorable execution
4. ✅ **Time Bounds**: Expiry prevents stale order execution

### 8.3 Attack Examples & Defenses

**Attack 1: Database modifies limit price**
```
Original:  limit_price_e6 = 450000 ($0.45)
Modified:  limit_price_e6 = 550000 ($0.55)

Defense:
- Signature verification fails (message changed)
- Transaction reverts
- Order not executed
```

**Attack 2: Keeper tries to execute expired order**
```
Order:     expiry_ts = 1699200000
Current:   timestamp = 1699200100 (expired!)

Defense:
- On-chain check: require!(order.expiry_ts > clock.unix_timestamp)
- Transaction reverts
- Order not executed
```

**Attack 3: Replay same order twice**
```
First execution:  nonce=123456 → SUCCESS
Second execution: nonce=123456 → FAIL

Defense:
- First execution marks nonce=123456 as used
- Second execution checks: position.used_nonces.contains(123456)
- require!(!used) fails
- Transaction reverts
```

**Attack 4: Keeper executes at unfavorable price**
```
Order:         BUY @ limit=$0.45
Current price: $0.52 (unfavorable!)

Defense:
- On-chain check: require!(current_price <= limit_price)
- Transaction reverts
- Order not executed
```

---

## 9. API Specifications

### 9.1 Order Book REST API

Full OpenAPI spec:

```yaml
openapi: 3.0.0
info:
  title: Limit Order Book API
  version: 1.0.0

paths:
  /api/orders/submit:
    post:
      summary: Submit a new signed limit order
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [order, signature]
              properties:
                order:
                  $ref: '#/components/schemas/LimitOrder'
                signature:
                  type: string
                  description: Hex-encoded Ed25519 signature (128 chars)
                  example: "a1b2c3d4..."
      responses:
        200:
          description: Order submitted successfully
          content:
            application/json:
              schema:
                type: object
                properties:
                  success:
                    type: boolean
                  order_hash:
                    type: string
                  order_id:
                    type: integer

  /api/orders/pending:
    get:
      summary: Get pending orders (for keepers)
      parameters:
        - name: market
          in: query
          schema:
            type: string
        - name: action
          in: query
          schema:
            type: integer
            enum: [1, 2]
        - name: side
          in: query
          schema:
            type: integer
            enum: [1, 2]
        - name: limit
          in: query
          schema:
            type: integer
            default: 100
      responses:
        200:
          description: List of pending orders
          content:
            application/json:
              schema:
                type: object
                properties:
                  orders:
                    type: array
                    items:
                      $ref: '#/components/schemas/OrderResponse'

  /api/orders/user/{pubkey}:
    get:
      summary: Get orders for specific user
      parameters:
        - name: pubkey
          in: path
          required: true
          schema:
            type: string
      responses:
        200:
          description: User's orders
          content:
            application/json:
              schema:
                type: object
                properties:
                  orders:
                    type: array
                    items:
                      $ref: '#/components/schemas/OrderResponse'

  /api/orders/{order_id}/fill:
    post:
      summary: Mark order as filled (keeper only)
      parameters:
        - name: order_id
          in: path
          required: true
          schema:
            type: integer
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [tx_signature]
              properties:
                tx_signature:
                  type: string
                shares_filled:
                  type: integer
                execution_price:
                  type: integer
                keeper_pubkey:
                  type: string
      responses:
        200:
          description: Order marked as filled

  /api/orders/{order_id}/cancel:
    post:
      summary: Cancel order (user only)
      parameters:
        - name: order_id
          in: path
          required: true
          schema:
            type: integer
      responses:
        200:
          description: Order cancelled

components:
  schemas:
    LimitOrder:
      type: object
      required: [market, user, action, side, shares_e6, limit_price_e6, expiry_ts, nonce]
      properties:
        market:
          type: string
          description: Market pubkey
        user:
          type: string
          description: User pubkey
        action:
          type: integer
          enum: [1, 2]
          description: 1=BUY, 2=SELL
        side:
          type: integer
          enum: [1, 2]
          description: 1=YES, 2=NO
        shares_e6:
          type: integer
          format: int64
          description: Shares (1e6 scale)
        limit_price_e6:
          type: integer
          format: int64
          description: Limit price (1e6 scale)
        max_cost_e6:
          type: integer
          format: int64
          description: Max cost for BUY orders
        min_proceeds_e6:
          type: integer
          format: int64
          description: Min proceeds for SELL orders
        expiry_ts:
          type: integer
          format: int64
          description: Unix timestamp
        nonce:
          type: integer
          format: uint64
        keeper_fee_bps:
          type: integer
          description: Keeper fee in basis points
        min_fill_bps:
          type: integer
          description: Minimum fill percentage

    OrderResponse:
      type: object
      properties:
        order_id:
          type: integer
        order_hash:
          type: string
        order:
          $ref: '#/components/schemas/LimitOrder'
        signature:
          type: string
        status:
          type: string
          enum: [pending, filled, cancelled, expired, failed]
        submitted_at:
          type: string
          format: date-time
        filled_at:
          type: string
          format: date-time
        filled_tx:
          type: string
```

---

## 10. Implementation Phases

### Phase 1: On-Chain Foundation (Week 1)

**Goal**: Core smart contract functionality

- [ ] Add `used_nonces: Vec<u64>` to Position struct
- [ ] Implement `execute_limit_order` instruction
  - [ ] Ed25519 signature verification
  - [ ] Nonce replay protection
  - [ ] Price condition checking
  - [ ] Trade execution (reuse existing logic)
  - [ ] Keeper fee payment
- [ ] Implement `cancel_order_nonce` instruction
- [ ] Add error codes
- [ ] Add events
- [ ] Write unit tests

**Deliverable**: Working program that can execute signed orders

### Phase 2: Order Book API (Week 2)

**Goal**: Off-chain order storage and retrieval

- [ ] Set up Express.js server
- [ ] Set up SQLite3 database (single file: orders.db)
- [ ] Implement database schema
- [ ] Implement REST endpoints:
  - [ ] POST /api/orders/submit
  - [ ] GET /api/orders/pending
  - [ ] GET /api/orders/user/:pubkey
  - [ ] POST /api/orders/:id/fill
  - [ ] POST /api/orders/:id/cancel
- [ ] Add request validation
- [ ] Add error handling
- [ ] Write API tests

**Deliverable**: Running order book API

### Phase 3: Client Tools (Week 2-3)

**Goal**: Tools for submitting and managing orders

- [ ] Implement `app/submit-order.js`
  - [ ] Borsh serialization
  - [ ] Ed25519 signing
  - [ ] API submission
  - [ ] CLI interface
- [ ] Implement `app/cancel-order.js`
  - [ ] Nonce cancellation
  - [ ] On-chain transaction
- [ ] Implement `app/list-orders.js`
  - [ ] Fetch user orders
  - [ ] Display status
- [ ] Add to existing CLI documentation

**Deliverable**: Working client tools

### Phase 4: Keeper Bot (Week 3)

**Goal**: Automated order execution

- [ ] Implement `app/keeper.js`
  - [ ] Order polling loop
  - [ ] Price checking logic
  - [ ] Execution transaction building
  - [ ] Error handling & retries
  - [ ] Logging
- [ ] Test on devnet
- [ ] Optimize for compute efficiency
- [ ] Document keeper setup

**Deliverable**: Production-ready keeper bot

### Phase 5: Web UI Integration (Week 4)

**Goal**: User-friendly web interface

- [ ] Add limit order form to guarded-trade.html
  - [ ] Action/side selectors
  - [ ] Price input
  - [ ] Expiry options (1h, 24h, 7d, custom)
  - [ ] Keeper fee slider
- [ ] Display user's active orders
  - [ ] Order list with status
  - [ ] Cancel buttons
  - [ ] Auto-refresh
- [ ] Show order execution history
  - [ ] Filled orders
  - [ ] Execution details
- [ ] Add order book visualization (optional)

**Deliverable**: Complete web UI

### Phase 6: Testing & Deployment (Week 5)

**Goal**: Production readiness

- [ ] End-to-end testing on devnet
- [ ] Load testing (concurrent orders)
- [ ] Security audit
- [ ] Deploy to testnet
- [ ] Deploy to mainnet
- [ ] Monitor initial usage

**Deliverable**: Live system

---

## 11. Testing Strategy

### 11.1 Unit Tests (Rust)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_execute_limit_order_valid_signature() {
        // Setup test accounts
        // Create and sign order
        // Call execute_limit_order
        // Verify success
    }

    #[tokio::test]
    async fn test_execute_limit_order_invalid_signature() {
        // Create order
        // Sign with wrong keypair
        // Call execute_limit_order
        // Verify error: InvalidSignature
    }

    #[tokio::test]
    async fn test_execute_limit_order_expired() {
        // Create order with past expiry
        // Call execute_limit_order
        // Verify error: OrderExpired
    }

    #[tokio::test]
    async fn test_execute_limit_order_nonce_replay() {
        // Execute order once (success)
        // Try to execute same order again
        // Verify error: NonceAlreadyUsed
    }

    #[tokio::test]
    async fn test_execute_limit_order_price_not_met() {
        // Create BUY order with limit=$0.40
        // Current price=$0.50
        // Call execute_limit_order
        // Verify error: PriceConditionNotMet
    }

    #[tokio::test]
    async fn test_keeper_fee_payment() {
        // Execute order with keeper_fee_bps=10
        // Verify keeper received 0.1% of proceeds
    }

    #[tokio::test]
    async fn test_cancel_nonce() {
        // Cancel nonce
        // Try to execute order with that nonce
        // Verify error: NonceAlreadyUsed
    }
}
```

### 11.2 Integration Tests (TypeScript)

```typescript
describe('Limit Orders', () => {
  it('should submit and execute BUY order', async () => {
    // Submit BUY 100 YES @ $0.45
    const { orderId } = await submitOrder({...});

    // Wait for price to drop
    await waitForPrice(0.44);

    // Keeper executes
    await keeper.execute(orderId);

    // Verify user received shares
    const position = await program.account.position.fetch(...);
    expect(position.sharesYesE6).to.be.gte(100_000_000);
  });

  it('should prevent replay attack', async () => {
    // Execute order
    await executeOrder(order, signature);

    // Try again
    await expect(
      executeOrder(order, signature)
    ).to.be.rejectedWith('NonceAlreadyUsed');
  });

  it('should handle partial fill', async () => {
    // Submit order for 1000 shares
    // min_fill_bps = 5000 (50%)
    // Only 600 shares executable at limit price

    const result = await executeOrder(...);

    expect(result.sharesExecuted).to.equal(600_000_000);
  });
});
```

### 11.3 End-to-End Tests

```bash
#!/bin/bash
# test-e2e.sh

# 1. Start local validator
solana-test-validator &

# 2. Deploy program
anchor deploy

# 3. Start order book API
cd orderbook-api && npm start &

# 4. Start keeper bot
cd app && node keeper.js &

# 5. Submit test orders
node submit-order.js --action 1 --side 1 --shares 100 --price 0.45

# 6. Wait for execution
sleep 10

# 7. Verify order filled
node list-orders.js --status filled

# 8. Cleanup
killall solana-test-validator node
```

---

## 12. Performance & Costs

### 12.1 Compute Units

| Operation | Estimated CU | Notes |
|-----------|--------------|-------|
| `execute_limit_order` | ~200-500K | Similar to guarded trade |
| Ed25519 verification | ~3K | Native Solana operation |
| Nonce check | ~1K | Vec scan (max 1000 items) |
| Trade execution | ~150-450K | LMSR calculation + Newton-Raphson |
| Keeper fee transfer | ~5K | System transfer |
| Event emission | ~2K | Logging |

**Total**: 200-500K CU per execution (~$0.0001-$0.0003 at current prices)

### 12.2 Transaction Costs

**For Users**:
- Order submission: **FREE** (no on-chain tx)
- Order cancellation: ~5K CU (~$0.0003)
- Order execution: Paid by keeper
- Keeper fee: 0.1-1% of trade value (user-configurable)

**For Keepers**:
- Execution tx: 200-500K CU (~$0.0001-$0.0003)
- Revenue: 0.1-1% of trade value
- Break-even: Trade value > $0.03-$0.30

**Example**:
```
Trade: BUY 100 YES @ $0.45 avg = $45 total
Keeper fee (0.1%): $0.045
Execution cost: ~$0.0003
Keeper profit: $0.0447 (~150x cost)
```

### 12.3 Storage Costs

**On-Chain**:
- Position account growth: 8 bytes per nonce
- 1000 nonces = 8KB = ~0.056 SOL rent
- Amortized over many trades (minimal)

**Off-Chain**:
- Database row: ~500 bytes per order
- 1M orders = 500 MB
- SQLite file: Single `orders.db` file on local disk
- Storage cost: FREE (local disk space)
- Optional: PostgreSQL for distributed setup (~$10/month)

### 12.4 Scalability

**Orders per second**:
- Database writes: ~50,000/sec (SQLite in-memory mode)
- Database writes: ~10,000/sec (SQLite disk mode)
- Keeper execution: ~10/sec (Solana TPS limit)
- Bottleneck: On-chain execution, not database

**Optimization strategies**:
- Batch execution (execute multiple orders in one tx)
- Priority fee bidding (keepers compete)
- Multiple keeper instances (distributed)

---

## 13. Future Enhancements

### 13.1 Advanced Order Types

**Stop-Loss Orders**:
```rust
pub struct StopLossOrder {
    pub trigger_price_e6: i64,  // Sell if price drops below
    pub limit_price_e6: i64,    // Execute at this price
}
```

**Take-Profit Orders**:
```rust
pub struct TakeProfitOrder {
    pub trigger_price_e6: i64,  // Sell if price rises above
    pub limit_price_e6: i64,    // Execute at this price
}
```

**Iceberg Orders**:
```rust
pub struct IcebergOrder {
    pub total_shares_e6: i64,    // Total order size
    pub visible_shares_e6: i64,  // Amount to show in book
}
```

### 13.2 Order Book Aggregation

**Public Order Book** (opt-in):
- Users can make orders "public" for better discovery
- Trade-off: visibility vs privacy
- Display aggregate depth without revealing individual orders

### 13.3 Cross-Market Orders

Execute order across multiple markets:
```rust
pub struct CrossMarketOrder {
    pub markets: Vec<Pubkey>,
    pub allocation: Vec<u8>,  // Percentage per market
}
```

### 13.4 Order Matching Engine

Instead of keepers, implement on-chain matching:
```rust
pub fn match_orders(
    ctx: Context<MatchOrders>,
    buy_order: LimitOrder,
    sell_order: LimitOrder,
) -> Result<()> {
    // Match compatible orders
    // Transfer shares directly between users
    // No AMM interaction
}
```

---

## Appendix A: Configuration

### A.1 Environment Variables

```bash
# RPC endpoint
export ANCHOR_PROVIDER_URL="https://api.testnet.x1.xyz"

# Wallet
export ANCHOR_WALLET="./keeper.json"

# Order book API
export ORDER_BOOK_API="https://orderbook.example.com"

# Program ID
export PROGRAM_ID="EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF"

# Market pubkey
export MARKET_PUBKEY="Gv7..."

# Keeper settings
export KEEPER_CHECK_INTERVAL=2000  # ms
export KEEPER_MAX_CONCURRENT=5     # orders
export KEEPER_MIN_PROFIT=0.0001    # SOL
```

### A.2 Database Configuration

```bash
# SQLite (default - embedded, no server required)
export DATABASE_PATH="./orders.db"

# Optional: PostgreSQL (for distributed keeper networks)
# export DATABASE_URL="postgresql://user:pass@localhost:5432/orderbook"
# export DATABASE_POOL_SIZE=20
# export DATABASE_TIMEOUT=5000  # ms
```

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **Limit Order** | Order to buy/sell at specific price or better |
| **Dark Pool** | Trading venue where orders are hidden |
| **Keeper** | Bot that executes orders (earns fees) |
| **Nonce** | Unique number preventing replay attacks |
| **Ed25519** | Elliptic curve signature scheme used by Solana |
| **Borsh** | Binary serialization format |
| **Partial Fill** | Executing portion of order |
| **LMSR** | Logarithmic Market Scoring Rule (AMM algorithm) |

---

## Appendix C: References

- [Solana Ed25519 Program](https://docs.solana.com/developing/runtime-facilities/programs#ed25519-program)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Borsh Specification](https://borsh.io/)
- [LMSR Paper](https://mason.gmu.edu/~rhanson/mktscore.pdf)

---

**Document Version**: 1.0
**Last Updated**: 2025-11-03
**Status**: READY FOR IMPLEMENTATION
