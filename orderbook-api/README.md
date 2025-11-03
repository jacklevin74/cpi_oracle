# Order Book API

Dark pool limit order book for Solana prediction market.

## Features

- ✅ **SQLite database** - Single file, no separate server
- ✅ **REST API** - Simple HTTP endpoints
- ✅ **Auto-expiry** - Orders automatically expire after TTL
- ✅ **Order validation** - Checks all required fields
- ✅ **Query filters** - Filter by market, action, side, user
- ✅ **CORS enabled** - Works with web frontends

## Quick Start

### 1. Install Dependencies

```bash
cd orderbook-api
npm install
```

### 2. Initialize Database

```bash
npm run init-db
```

This creates `orders.db` with the schema and indexes.

### 3. Start Server

```bash
npm start
```

Server runs on `http://localhost:3000`

### 4. Development Mode (auto-reload)

```bash
npm run dev
```

## API Endpoints

### Health Check

```bash
GET /health

Response:
{
  "status": "ok",
  "timestamp": 1699200000000
}
```

### Get Statistics

```bash
GET /api/stats

Response:
{
  "total": 1250,
  "pending": 45,
  "filled": 1150,
  "cancelled": 35,
  "expired": 20
}
```

### Submit Order

```bash
POST /api/orders/submit

Body:
{
  "order": {
    "market": "Gv7...",
    "user": "8xF...",
    "action": 1,               // 1=BUY, 2=SELL
    "side": 1,                 // 1=YES, 2=NO
    "shares_e6": 100000000,    // 100 shares
    "limit_price_e6": 450000,  // $0.45
    "max_cost_e6": 50000000,   // $50 max
    "min_proceeds_e6": 0,
    "expiry_ts": 1699200000,   // Unix timestamp
    "nonce": 1699100000123456,
    "keeper_fee_bps": 10,      // 0.1%
    "min_fill_bps": 5000       // 50% min fill
  },
  "signature": "a1b2c3d4..."   // 128 hex chars (64 bytes)
}

Response:
{
  "success": true,
  "order_id": 12345,
  "order_hash": "9f86d081884c7d659a2feaa0c55ad015..."
}
```

### Get Pending Orders

```bash
GET /api/orders/pending?market=Gv7...&limit=50

Response:
{
  "orders": [
    {
      "order_id": 12345,
      "order_hash": "9f86...",
      "order": { /* full order object */ },
      "signature": "a1b2c3d4...",
      "submitted_at": "2025-11-03T10:30:00.000Z"
    }
  ]
}
```

Query parameters:
- `market` (optional): Filter by market pubkey
- `action` (optional): Filter by action (1=BUY, 2=SELL)
- `side` (optional): Filter by side (1=YES, 2=NO)
- `limit` (optional): Max results (default: 100)

### Get User Orders

```bash
GET /api/orders/user/8xF...?status=pending

Response:
{
  "orders": [
    {
      "order_id": 12345,
      "order_hash": "9f86...",
      "order": { /* full order */ },
      "signature": "a1b2...",
      "status": "pending",
      "submitted_at": "2025-11-03T10:30:00.000Z",
      "filled_at": null,
      "filled_tx": null
    }
  ]
}
```

Query parameters:
- `status` (optional): Filter by status (pending, filled, cancelled, expired)

### Get Specific Order

```bash
GET /api/orders/12345

Response:
{
  "order_id": 12345,
  "order_hash": "9f86...",
  "order": { /* full order */ },
  "signature": "a1b2...",
  "status": "filled",
  "submitted_at": "2025-11-03T10:30:00.000Z",
  "filled_at": "2025-11-03T10:35:00.000Z",
  "filled_tx": "5xYz9...",
  "filled_shares_e6": 95000000,
  "execution_price_e6": 455000,
  "keeper_pubkey": "7pQ..."
}
```

### Mark Order as Filled

```bash
POST /api/orders/12345/fill

Body:
{
  "tx_signature": "5xYz9...",
  "shares_filled": 95000000,
  "execution_price": 455000,
  "keeper_pubkey": "7pQ..."
}

Response:
{
  "success": true,
  "order_id": 12345
}
```

### Cancel Order

```bash
POST /api/orders/12345/cancel

Response:
{
  "success": true,
  "order_id": 12345
}
```

### Expire Old Orders

```bash
POST /api/orders/expire

Response:
{
  "success": true,
  "expired_count": 5
}
```

## Order Schema

```javascript
{
  market: "Pubkey",           // Market this order is for
  user: "Pubkey",             // Order owner
  action: 1 | 2,              // 1=BUY, 2=SELL
  side: 1 | 2,                // 1=YES, 2=NO
  shares_e6: number,          // Desired shares (1e6 scale)
  limit_price_e6: number,     // Max price (BUY) or min price (SELL)
  max_cost_e6: number,        // Max spend for BUY (or i64::MAX)
  min_proceeds_e6: number,    // Min receive for SELL (or 0)
  expiry_ts: number,          // Unix timestamp when order expires
  nonce: number,              // Unique nonce (prevents replay)
  keeper_fee_bps: number,     // Keeper fee (10 = 0.1%)
  min_fill_bps: number        // Min fill % (5000 = 50%)
}
```

## Order States

- **pending**: Order submitted, waiting for execution
- **filled**: Order executed successfully
- **cancelled**: User cancelled the order
- **expired**: Order passed expiry_ts without execution
- **failed**: Execution attempted but failed

## Database

SQLite database stored in `orders.db` (configurable via `DATABASE_PATH` env var).

### Schema

```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_hash TEXT UNIQUE NOT NULL,
  order_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  market TEXT NOT NULL,
  user_pubkey TEXT NOT NULL,
  action INTEGER NOT NULL,
  side INTEGER NOT NULL,
  limit_price_e6 INTEGER NOT NULL,
  shares_e6 INTEGER NOT NULL,
  expiry_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  filled_tx TEXT,
  filled_at INTEGER,
  filled_shares_e6 INTEGER,
  execution_price_e6 INTEGER,
  keeper_pubkey TEXT,
  submitted_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### Indexes

- `idx_status` - Fast status queries
- `idx_market_status` - Market + status queries
- `idx_user` - User order lookups
- `idx_expiry` - Expiry checks
- `idx_price` - Price range queries

## Environment Variables

```bash
# Port (default: 3000)
PORT=3000

# Database path (default: ./orders.db)
DATABASE_PATH=/path/to/orders.db
```

## Background Tasks

The server runs automatic background tasks:

- **Auto-Expiry**: Every 60 seconds, marks expired orders as 'expired'

## Example Usage

### Submit Order with curl

```bash
curl -X POST http://localhost:3000/api/orders/submit \
  -H "Content-Type: application/json" \
  -d '{
    "order": {
      "market": "Gv7Xvt9J8LkuB3nG9PcRz5wF2hQ7kN1mX8vY4sT6dW2p",
      "user": "8xF9NzJh3LmQ5pK6rW2vY7sT1dH4nM9cX8vB6jR5gP3k",
      "action": 1,
      "side": 1,
      "shares_e6": 100000000,
      "limit_price_e6": 450000,
      "max_cost_e6": 50000000,
      "min_proceeds_e6": 0,
      "expiry_ts": 1730000000,
      "nonce": 1699100000123456,
      "keeper_fee_bps": 10,
      "min_fill_bps": 5000
    },
    "signature": "a1b2c3d4e5f6..."
  }'
```

### Query Pending Orders

```bash
curl http://localhost:3000/api/orders/pending?limit=10
```

### Get User Orders

```bash
curl http://localhost:3000/api/orders/user/8xF9NzJh3LmQ5pK6rW2vY7sT1dH4nM9cX8vB6jR5gP3k
```

## Security Notes

1. **Signature Validation**: Currently basic format check only. Production should verify Ed25519 signatures.
2. **Rate Limiting**: Consider adding rate limiting for production.
3. **Authentication**: Consider adding API keys for admin endpoints (fill, cancel).
4. **HTTPS**: Use HTTPS in production.

## Monitoring

Check logs for:
- Order submissions: `✅ Order submitted: 9f86...`
- Order fills: `✅ Order 12345 marked as filled`
- Order cancellations: `🚫 Order 12345 cancelled`
- Auto-expiry: `⏱️  Auto-expired 5 orders`

## Troubleshooting

### Database locked error
- SQLite is in WAL mode for better concurrency
- If issues persist, consider PostgreSQL for high-concurrency scenarios

### Orders not auto-expiring
- Check server logs for expiry task errors
- Manually trigger: `curl -X POST http://localhost:3000/api/orders/expire`

### Duplicate order hash
- Each order must be unique
- Change nonce to create new order

## Production Checklist

- [ ] Enable HTTPS
- [ ] Add rate limiting
- [ ] Add API authentication
- [ ] Implement proper Ed25519 verification
- [ ] Set up monitoring/alerts
- [ ] Configure database backups
- [ ] Add request logging
- [ ] Set up reverse proxy (nginx)
- [ ] Configure CORS whitelist

## License

MIT
