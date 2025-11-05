# Dark Pool Orderbook UI

Hyperliquid-style web interface for testing the off-chain limit order system.

## Access

```
http://64.20.42.194:3434/orderbook.html
```

Or locally:
```
http://localhost:3434/orderbook.html
```

## Features

### ✅ Live Orderbook Display
- Real-time pending orders from SQLite database
- Auto-refreshes every 5 seconds
- Color-coded BUY/SELL actions (green/red)
- Order details: ID, Action, Side, Shares, Limit Price, Status, Timestamp
- Connection status banner

### ✅ Order Submission (Browser-Based)
- **Connect Wallet** - Generates test keypair (in production: use Phantom/Solflare)
- **Fill Order Form**:
  - Action: BUY or SELL
  - Side: YES or NO
  - Shares amount
  - Limit price ($0.00 - $1.00)
  - Optional max cost
  - TTL (time to live in seconds)
  - Keeper fee (basis points)
- **Click BUY/SELL button** - Signs with Ed25519 and submits to API
- **No popups** - All feedback via banner notifications

### ✅ Statistics Dashboard
- Total orders
- Pending orders count
- Filled orders count
- API connection status (live indicator)

### ✅ Quick Actions
- 🔄 Refresh orderbook
- 📜 View all orders / pending only
- 💾 Export orders to JSON
- 🗑️ Clear form

## How to Use

### 1. Connect Wallet
Click **"Connect Wallet"** button in top-right. This generates a test keypair for signing orders.

**Note**: This is a TEST wallet. In production, this would use @solana/wallet-adapter for Phantom/Solflare integration.

### 2. Fill Order Form
- Select **Action** (BUY or SELL)
- Select **Side** (YES or NO)
- Enter **Shares** (e.g., 100)
- Enter **Limit Price** (e.g., 0.45 for $0.45)
- Optional: Set **Max Cost** to cap total spend
- Set **TTL** (default: 86400 = 24 hours)
- Set **Keeper Fee** (default: 10 bps = 0.1%)

### 3. Submit Order
Click either:
- **Place BUY Order** (green button)
- **Place SELL Order** (red button)

The page will:
1. Show "Signing order..." in banner
2. Serialize order to Borsh format
3. Sign with Ed25519 (tweetnacl)
4. Show "Submitting order to orderbook..."
5. POST to `/orderbook-api/api/orders/submit`
6. Show success message: "✅ Order #X submitted: BUY 100 YES @ $0.45"
7. Auto-refresh orderbook to display new order

### 4. View Orders
Orders appear in the main table with:
- **ID**: Order number (#1, #2, etc.)
- **Action**: BUY (green) or SELL (red)
- **Side**: YES (blue badge) or NO (orange badge)
- **Shares**: Quantity (formatted to 2 decimals)
- **Limit Price**: Max/min price (formatted to 6 decimals)
- **Status**: PENDING (yellow badge) / FILLED (green) / EXPIRED (gray)
- **Submitted**: Timestamp of order creation

## Technical Details

### Architecture
- **Frontend**: Pure HTML/CSS/JavaScript (no framework)
- **Wallet**: Solana web3.js + tweetnacl for Ed25519 signing
- **API**: Proxied through web server port 3434 → orderbook API port 3000
- **Database**: SQLite (orderbook-api/orders.db)
- **Signing**: Client-side Ed25519 signature verification

### API Endpoints (Proxied)

All endpoints accessible via `/orderbook-api/*`:

```javascript
GET  /orderbook-api/api/stats              // Order statistics
GET  /orderbook-api/api/orders/pending     // Pending orders
POST /orderbook-api/api/orders/submit      // Submit signed order
GET  /orderbook-api/api/orders/:id         // Get specific order
```

### Order Serialization (Borsh)

Orders are serialized to match the on-chain Rust struct:

```
market          (32 bytes)  Pubkey
user            (32 bytes)  Pubkey
action          (1 byte)    u8 (1=BUY, 2=SELL)
side            (1 byte)    u8 (1=YES, 2=NO)
shares_e6       (8 bytes)   i64
limit_price_e6  (8 bytes)   i64
max_cost_e6     (8 bytes)   i64
min_proceeds_e6 (8 bytes)   i64
expiry_ts       (8 bytes)   i64
nonce           (8 bytes)   u64
keeper_fee_bps  (2 bytes)   u16
min_fill_bps    (2 bytes)   u16
─────────────────────────────
Total: 118 bytes
```

### Security Notes

**Current Implementation** (Testing):
- Generates ephemeral keypair in browser
- No private key storage
- Test wallet only (no real funds)

**Production Requirements**:
1. Integrate `@solana/wallet-adapter-react` for Phantom/Solflare
2. Never store private keys in browser storage
3. Add HTTPS for signature security
4. Implement proper session management
5. Add rate limiting to prevent spam

## Example Usage

### Submit a BUY Order

1. **Connect Wallet** → Test keypair generated
2. **Fill form**:
   - Action: BUY
   - Side: YES
   - Shares: 100
   - Price: 0.45
   - TTL: 86400 (24h)
3. **Click "Place BUY Order"**
4. Banner shows: ✅ Order #4 submitted: BUY 100 YES @ $0.45
5. Table updates with new order

### Submit a SELL Order

1. **Connect Wallet** (if not already)
2. **Fill form**:
   - Action: SELL
   - Side: NO
   - Shares: 50
   - Price: 0.60
   - Max Cost: (leave empty)
3. **Click "Place SELL Order"**
4. Order appears in orderbook

### Export All Orders

Click **"💾 Export Orders JSON"** to download `orders-{timestamp}.json` with full orderbook data.

## Troubleshooting

### "Cannot connect to API"
- Check orderbook API is running: `curl http://localhost:3000/api/stats`
- Check web server is running: `lsof -i :3434`
- Restart web server: `cd web && node server.js`

### "Please connect wallet first"
- Click **"Connect Wallet"** button before submitting orders

### Orders not appearing
- Check browser console (F12) for errors
- Verify API is accessible: Open Network tab, check for 200 responses
- Hard refresh page: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)

### Signature errors
- Ensure all form fields are filled correctly
- Check console for serialization errors
- Verify Market PDA derivation matches on-chain program

## Development

### Enable Debug Logging

Open browser console (F12) to see:
```
🔌 Orderbook API URL: http://localhost:3434/orderbook-api
📊 Fetching stats from: http://localhost:3434/orderbook-api/api/stats
✅ Stats loaded: {total: 3, pending: 3, filled: 0}
📋 Fetching pending orders from: http://localhost:3434/orderbook-api/api/orders/pending
✅ Orders loaded: 3 orders
[INFO] Signing order...
[INFO] Submitting order to orderbook...
[SUCCESS] ✅ Order #4 submitted: BUY 100 YES @ $0.45
```

### Modify Styling

Edit `/home/ubuntu/dev/cpi_oracle/web/public/orderbook.html`:
- Lines 1-320: CSS styles (Hyperliquid-inspired dark theme)
- Lines 321-451: HTML structure
- Lines 455+: JavaScript logic

### Add New Features

Ideas:
- User-specific order filtering (show only my orders)
- Order cancellation button
- Price chart integration (TradingView)
- Order book depth visualization
- Trade history timeline
- Real-time WebSocket updates
- Order edit/modify functionality

## API Proxy Configuration

The web server (`web/server.js`) proxies orderbook API requests:

```javascript
// In server.js (lines 656-684)
if (req.url.startsWith('/orderbook-api/')) {
    const targetPath = req.url.replace('/orderbook-api', '');
    const options = {
        hostname: 'localhost',
        port: 3000,
        path: targetPath,
        method: req.method,
        headers: req.headers
    };
    // ... proxy logic
}
```

This allows:
- Single port access (3434) for both web UI and API
- No CORS issues (same origin)
- Simplified firewall rules (only port 3434 needs to be open)

## Current Orders

As of deployment:
- **Order #1**: BUY 100 YES @ $0.45 (userA)
- **Order #2**: SELL 50 NO @ $0.60 (userB)
- **Order #3**: BUY 200 YES @ $0.48 (userA)

All orders are **PENDING** and visible in the orderbook.

## Next Steps

1. **Test order submission** via web UI
2. **Run keeper bot** to execute orders: `npx ts-node app/keeper.ts`
3. **Monitor order fills** in real-time on the webpage
4. **Integrate with production wallets** (Phantom/Solflare)
5. **Deploy to production** with HTTPS

## License

MIT
