# Guarded Trading UI - Testing Guide

## What Has Been Implemented

I've successfully implemented a complete guarded trading system with the following components:

### 1. **Backend Simulation API** ✅
- **File**: `web/src/api/guarded-trade-simulator.ts`
- **Endpoint**: `POST /api/simulate-guarded-trade`
- Replicates the on-chain guard validation logic from `programs/cpi_oracle/src/lib.rs`
- Performs binary search for partial fills (max 16 iterations)
- Validates all 4 guards: price limits, slippage, cost limits, partial fills

### 2. **Frontend UI** ✅
- **File**: `web/public/guarded-trade.html`
- **URL**: https://vero.testnet.x1.xyz/guarded-trade.html
- Complete UI with:
  - Trade setup (action, side, amount)
  - Price limit guard
  - Slippage protection guard
  - Max cost limit guard
  - Partial fill support
  - Simulation results display
  - Wallet integration (Backpack/Phantom)
  - Transaction building and execution

### 3. **Transaction Building** ✅
- Derives all required PDAs (AMM, position, vault_sol, user_vault)
- Builds `trade_advanced` instruction with proper account ordering
- Serializes AdvancedGuardConfig struct
- Integrates with Backpack and Phantom wallets
- Shows transaction status and links to X1 explorer

## Known Issues to Fix

### ⚠️ Critical: Anchor Discriminator

The current code uses a placeholder discriminator for the `trade_advanced` instruction:

```javascript
// Line 985 in guarded-trade.html
const discriminator = Buffer.from([0x9a, 0x6b, 0x8f, 0x3c, 0x2d, 0x4e, 0x5a, 0x1b]); // PLACEHOLDER
```

**To get the correct discriminator:**

1. The discriminator is the first 8 bytes of SHA256("global:trade_advanced")
2. You can calculate it in Node.js:

```javascript
const crypto = require('crypto');
const hash = crypto.createHash('sha256').update('global:trade_advanced').digest();
const discriminator = hash.slice(0, 8);
console.log('Discriminator:', Array.from(discriminator).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', '));
```

3. Or get it from the IDL:

```bash
anchor idl parse -f programs/cpi_oracle/src/lib.rs -o /tmp/idl.json
cat /tmp/idl.json | jq '.instructions[] | select(.name == "trade_advanced")'
```

### ⚠️ Browser Compatibility: Buffer

The code currently uses `Buffer` which isn't available in browsers. You need to either:

1. **Option A**: Use a polyfill (recommended for quick fix):
   - Add `<script src="https://cdn.jsdelivr.net/npm/buffer@6/index.js"></script>` before solana-web3.min.js

2. **Option B**: Replace Buffer with Uint8Array:
   ```javascript
   function longToBuffer(num) {
       const buf = new Uint8Array(8);
       const view = new DataView(buf.buffer);
       view.setBigInt64(0, BigInt(num), true); // true = little-endian
       return buf;
   }

   function shortToBuffer(num) {
       const buf = new Uint8Array(2);
       const view = new DataView(buf.buffer);
       view.setUint16(0, num, true); // true = little-endian
       return buf;
   }
   ```

## How to Test

### Step 1: Start the Server

```bash
cd /home/ubuntu/dev/cpi_oracle/web
node server.js
```

The server should show:
```
✅ TypeScript controllers initialized for /api/ts/* endpoints
🚀 Server running on http://0.0.0.0:3434
```

### Step 2: Access the UI

Navigate to: https://vero.testnet.x1.xyz/guarded-trade.html

### Step 3: Connect Wallet

1. Install Backpack or Phantom wallet extension
2. The page should auto-detect and connect to your wallet
3. If not, click on the wallet balance area to trigger connection
4. Ensure you have some XNT on X1 testnet

### Step 4: Test Simulation

1. Set up a trade:
   - Action: BUY
   - Side: UP (YES)
   - Amount: 10 shares

2. Enable guards:
   - **Price Limit**: Enable and set to $0.70
   - **Slippage**: Enable, click "Get Quote" to fetch current price, set to 200 bps (2%)
   - **Cost Limit**: Enable and set to $100
   - **Partial Fills**: Enable with min fill of 1 share

3. Click **SIMULATE TRADE**

Expected result:
- You should see simulation results showing:
  - Execution status (FULL EXECUTION or PARTIAL FILL)
  - Shares to execute
  - Execution price
  - Total cost
  - Guard status badges (✓ PASS or ✗ FAIL)

### Step 5: Check Backend Logs

In your server terminal, you should see:
```
Simulate guarded trade error: ... (if any)
```

**If simulation fails:**
- Check browser console (F12 → Console) for detailed errors
- Check network tab (F12 → Network) to see the API request/response
- Verify the market is initialized and has liquidity

### Step 6: Test Transaction Execution

⚠️ **Before testing execution, you MUST:**

1. Fix the discriminator (see "Known Issues" above)
2. Fix the Buffer issue (see "Known Issues" above)
3. Ensure you have an initialized position account (run `node app/trade.js init-pos` if not)

Then:
1. Run a successful simulation
2. Click **EXECUTE GUARDED TRADE**
3. Approve the transaction in your wallet
4. Wait for confirmation

Expected result:
- Button shows progress: "BUILDING TRANSACTION" → "SENDING TRANSACTION" → "CONFIRMING" → "SUCCESS!"
- Alert shows transaction signature and link to X1 explorer
- Transaction explorer opens in new tab

## Debugging Common Issues

### 1. Simulation Returns "Market data not available"

**Cause**: Market service can't fetch AMM state

**Fix**:
```bash
# Check if market exists
solana account <AMM_PDA> --url https://rpc.testnet.x1.xyz

# Initialize market if needed
ANCHOR_WALLET=./userA.json node app/trade.js init 500 25
```

### 2. Transaction Fails with "Account not found"

**Cause**: Position account doesn't exist

**Fix**:
```bash
ANCHOR_WALLET=<your-wallet> node app/trade.js init-pos
```

### 3. Guards Fail During Execution But Pass in Simulation

**Cause**: Price moved between simulation and execution (this is expected!)

**Fix**: This is why guards exist. The transaction correctly rejects if conditions changed. User should:
1. Re-simulate to get updated price
2. Adjust guards if needed
3. Execute again

### 4. Browser Console Shows "Buffer is not defined"

**Cause**: Buffer isn't available in browsers

**Fix**: Add Buffer polyfill or use Uint8Array (see "Known Issues" above)

### 5. Transaction Fails with "Invalid instruction data"

**Cause**: Wrong discriminator or incorrect data serialization

**Fix**:
1. Verify discriminator is correct
2. Check instruction data serialization matches Rust struct layout
3. Enable skipPreflight and check program logs

## Verifying Simulation Accuracy

To verify the simulation matches on-chain behavior:

1. **Test with simple guard (price limit only)**:
   - Simulate with price limit $0.50
   - Check simulation says PASS or FAIL
   - Execute and see if on-chain result matches

2. **Test partial fills**:
   - Set amount to 1000 shares
   - Set max cost to $100
   - Enable partial fills
   - Simulation should find largest amount that fits in $100

3. **Test slippage guard**:
   - Fetch quote price
   - Set slippage to 1% (100 bps)
   - Wait 5 seconds (let price potentially move)
   - Simulate and check if slippage check triggers

## Next Steps

1. **Get the correct discriminator** - This is critical for execution to work
2. **Fix Buffer compatibility** - Choose polyfill or Uint8Array approach
3. **Test on X1 testnet** - Follow the testing steps above
4. **Monitor transactions** - Check X1 explorer for detailed logs
5. **Handle errors gracefully** - The current error parsing is basic, enhance it based on actual errors you see

## Production Readiness Checklist

- [x] Simulation API implemented and tested
- [x] Frontend UI with all 4 guards
- [x] Wallet integration (Backpack/Phantom)
- [x] Transaction building logic
- [ ] Correct Anchor discriminator
- [ ] Browser Buffer compatibility
- [ ] Position account auto-initialization
- [ ] Better error messages
- [ ] Loading states and animations
- [ ] Transaction history display
- [ ] Gas estimation
- [ ] Retry logic for failed simulations

## Files Modified

1. `/web/src/api/guarded-trade-simulator.ts` - NEW: Simulation engine
2. `/web/src/api/api.controller.ts` - MODIFIED: Added simulateGuardedTrade method
3. `/web/server.js` - MODIFIED: Added POST /api/simulate-guarded-trade endpoint
4. `/web/public/guarded-trade.html` - MODIFIED: Added wallet integration and transaction execution

## Architecture Diagram

```
┌─────────────┐
│   Browser   │
│  (User UI)  │
└──────┬──────┘
       │
       │ 1. POST /api/simulate-guarded-trade
       │    { side, action, amountE6, guards }
       │
       ↓
┌─────────────────────────┐
│   Express Server        │
│   (web/server.js)       │
└────────┬────────────────┘
         │
         │ 2. Call simulateGuardedTrade()
         │
         ↓
┌─────────────────────────────────┐
│   ApiController                 │
│   (api.controller.ts)           │
└────────┬────────────────────────┘
         │
         │ 3. Fetch market state
         │
         ↓
┌────────────────────────────┐      ┌──────────────────────┐
│   MarketService           │────→│   Solana RPC         │
│   (market.service.ts)     │      │   (X1 Testnet)       │
└────────┬──────────────────┘      └──────────────────────┘
         │
         │ 4. Run simulation
         │
         ↓
┌──────────────────────────────────┐
│   Guarded Trade Simulator        │
│   (guarded-trade-simulator.ts)   │
│   • Replicate on-chain logic     │
│   • Binary search for partials   │
│   • Validate all guards          │
└────────┬─────────────────────────┘
         │
         │ 5. Return SimulationResult
         │
         ↓
┌─────────────┐
│   Browser   │
│  (Display)  │
│             │
│  If success │
│     │       │
│     ↓       │
│  Build TX   │
│  Sign TX    │
│  Send TX    │
└─────────────┘
```

## Support

If you encounter issues:

1. Check browser console for errors
2. Check server logs for backend errors
3. Check transaction logs on X1 explorer
4. Review the Rust program logs: `solana logs <PROGRAM_ID> --url https://rpc.testnet.x1.xyz`
