# Keeper Bot

TypeScript keeper bot for automatically executing dark pool limit orders.

## Overview

The keeper bot continuously monitors the order book API for pending limit orders and executes them on-chain when price conditions are met. Keepers earn a fee (configurable in each order) for providing this service.

## Features

- ✅ **Automated Monitoring** - Polls order book every 2 seconds (configurable)
- ✅ **Price Checking** - Uses LMSR math to determine if orders are executable
- ✅ **PDA Calculation** - Automatically derives all required program addresses
- ✅ **Multi-Order Support** - Processes multiple pending orders concurrently
- ✅ **Graceful Error Handling** - Continues running even if individual orders fail
- ✅ **TypeScript** - Full type safety and IDE support

## Installation

```bash
# Install dependencies (if not already done)
npm install

# Compile TypeScript
npx tsc app/keeper.ts --outDir app --skipLibCheck
```

## Usage

### Run with TypeScript (ts-node)

```bash
# Using default keeper wallet
npx ts-node app/keeper.ts

# Using custom keeper wallet
KEEPER_WALLET=./keeper.json npx ts-node app/keeper.ts

# With custom RPC and order book API
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ORDER_BOOK_API=https://orderbook.example.com \
KEEPER_WALLET=./keeper.json \
npx ts-node app/keeper.ts
```

### Run with Node.js (compiled)

```bash
# Compile first
npx tsc app/keeper.ts --outDir app --skipLibCheck

# Run compiled JavaScript
node app/keeper.js
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KEEPER_WALLET` | Path to keeper's keypair file | `$ANCHOR_WALLET` or `~/.config/solana/id.json` |
| `ANCHOR_PROVIDER_URL` | Solana RPC endpoint | `http://127.0.0.1:8899` |
| `ORDER_BOOK_API` | Order book API URL | `http://localhost:3000` |
| `KEEPER_CHECK_INTERVAL` | Check interval in milliseconds | `2000` (2 seconds) |
| `KEEPER_MIN_PROFIT` | Minimum profit threshold in lamports | `100000` (0.0001 SOL) |

## How It Works

### 1. Initialization
```
- Load keeper wallet from file
- Connect to Solana RPC
- Derive AMM PDA
- Start monitoring loop
```

### 2. Order Monitoring Loop
```
Every CHECK_INTERVAL ms:
  ├─ Fetch pending orders from API
  ├─ Fetch current AMM state from Solana
  ├─ For each order:
  │   ├─ Check if market is open
  │   ├─ Check if order not expired
  │   ├─ Calculate current price
  │   ├─ Check if price condition met
  │   └─ If executable → Execute order
  └─ Sleep and repeat
```

### 3. Order Execution
```
For executable order:
  ├─ Derive Position PDA (for order owner)
  ├─ Derive Vault PDA
  ├─ Build execute_limit_order instruction
  ├─ Send transaction to Solana
  ├─ Wait for confirmation
  └─ Mark order as filled in API
```

## Price Checking Logic

The keeper uses LMSR (Logarithmic Market Scoring Rule) to calculate prices:

```typescript
// For BUY orders: current_price <= limit_price
// For SELL orders: current_price >= limit_price

function calculateCurrentPrice(amm, action, side, shares): number {
  const baseCost = lmsr_cost(qYes, qNo);
  const targetCost = lmsr_cost(qYes + Δq, qNo + Δq);
  const avgPrice = (targetCost - baseCost) / shares;
  return avgPrice;
}
```

## Keeper Economics

### Fee Structure
- **Keeper Fee**: Configurable per order (e.g., 0.1% = 10 bps)
- **Paid From**: Trade proceeds (deducted on-chain)
- **Example**: $50 trade × 0.1% = $0.05 keeper fee

### Profitability
```
Revenue: keeper_fee_bps × trade_value
Cost:    tx_fee (≈0.0001-0.0003 SOL)
Profit:  revenue - cost

Break-even: trade_value > tx_fee / (keeper_fee_bps / 10000)

Example (0.1% fee):
  - Need trade > $0.30 to break even
  - $50 trade = $0.05 revenue - $0.0003 cost = $0.0497 profit
```

## Output Example

```
🤖 Keeper Bot Started
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Keeper:         AivknDqDUqnvyYVmDViiB2bEHKyUK5HcX91gWL2zgTZ4
RPC:            http://127.0.0.1:8899
Order Book API: http://localhost:3000
AMM:            3Mgfh1zgsuRbvBzVCfW6VvvCYHLku8sk7GM5HLhw8Vgc
Check Interval: 2000ms
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[2025-11-03T23:45:18.313Z] 📋 Found 1 pending order(s)
📊 AMM State: qYes=0, qNo=0, status=1

🔍 Checking order 1:
   BUY 100 YES @ limit $0.450000
✅ Order 1 is executable!

🔧 Building transaction for order 1...
   User: 47Vckihe8sZifmYpvATMbcUfeAzqbSsSZLnS1hHM2K1S
   Action: BUY YES
   Shares: 100
   Limit Price: $0.450000
✅ Order 1 executed: 5xYz9...
✅ Order 1 marked as filled in database
```

## Error Handling

The keeper continues running even if individual operations fail:

- **Order fetch fails**: Logs error, waits, retries
- **AMM fetch fails**: Logs error, waits, retries
- **Execution fails**: Logs error, moves to next order
- **API update fails**: Logs warning, order will retry next loop

## Troubleshooting

### No orders being executed

1. Check order book API is running:
   ```bash
   curl http://localhost:3000/api/orders/pending
   ```

2. Check RPC connection:
   ```bash
   curl http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```

3. Check keeper wallet has SOL:
   ```bash
   solana balance $(solana-keygen pubkey ./keeper.json)
   ```

### Orders showing as executable but not executing

- Check keeper wallet permissions
- Check program is deployed
- Check AMM account exists
- Check user position is initialized

### High compute unit usage

- Reduce `CHECK_INTERVAL` if checking too frequently
- Filter orders by market if monitoring multiple

## Production Deployment

### 1. Use systemd for auto-restart

```ini
[Unit]
Description=Limit Order Keeper Bot
After=network.target

[Service]
Type=simple
User=keeper
WorkingDirectory=/home/keeper/cpi_oracle
ExecStart=/usr/bin/npx ts-node app/keeper.ts
Restart=always
RestartSec=10
Environment="KEEPER_WALLET=/home/keeper/keeper.json"
Environment="ORDER_BOOK_API=https://api.yoursite.com"

[Install]
WantedBy=multi-user.target
```

### 2. Use PM2 for process management

```bash
pm2 start app/keeper.ts --name keeper --interpreter=ts-node
pm2 save
pm2 startup
```

### 3. Monitor with logs

```bash
# systemd
journalctl -u keeper -f

# PM2
pm2 logs keeper --lines 100
```

## Security Considerations

1. **Keeper Wallet**:
   - Store securely (encrypted filesystem)
   - Limit SOL balance (only what's needed for tx fees)
   - Rotate regularly

2. **API Access**:
   - Use HTTPS in production
   - Consider API key authentication
   - Rate limit to prevent abuse

3. **Order Validation**:
   - Keeper validates all orders on-chain
   - Invalid signatures will be rejected
   - Expired orders won't execute

## Future Enhancements

- [ ] Multi-keeper coordination (prevent duplicate execution)
- [ ] Priority queue for high-fee orders
- [ ] Gas price optimization
- [ ] Batch execution for multiple orders
- [ ] Profitability calculator before execution
- [ ] Telegram/Discord notifications
- [ ] Metrics dashboard (Prometheus/Grafana)

## License

MIT
