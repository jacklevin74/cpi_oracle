# Volume Double-Counting Fix

## Problem

Volume counters were showing 2x the actual trading volume because the same trade was being counted twice:

1. **app.js** (frontend) - Posted to `/api/volume` after successful trade execution
2. **trade_monitor.js** (backend) - Posted to `/api/volume` after detecting trade from on-chain logs

This resulted in every BUY trade being counted twice, doubling the displayed volume.

## Root Cause Analysis

### The Flow Before Fix:

```
User executes BUY trade
    ↓
app.js: executeTrade() succeeds
    ↓
app.js: POST /api/volume (side, amount, shares)  ← COUNT #1
    ↓
Transaction confirmed on-chain
    ↓
trade_monitor.js: Detects trade from logs
    ↓
trade_monitor.js: POST /api/volume (side, amount, shares)  ← COUNT #2 (DUPLICATE!)
    ↓
hyperliquid.html: Receives WebSocket event
    ↓
hyperliquid.html: Fetches updated volume from server
    ↓
Display shows 2x actual volume ❌
```

## Solution

Removed the duplicate volume POST from `app.js` since `trade_monitor.js` is the authoritative source that reads from on-chain transaction logs.

**Architecture Decision:**
- **trade_monitor.js** = Single source of truth for volume tracking
- Reads actual confirmed transactions from blockchain
- Updates server volume via POST /api/volume
- More reliable than client-side tracking

### The Flow After Fix:

```
User executes BUY trade
    ↓
app.js: executeTrade() succeeds
    ↓
app.js: (no volume POST - removed)
    ↓
Transaction confirmed on-chain
    ↓
trade_monitor.js: Detects trade from logs
    ↓
trade_monitor.js: POST /api/volume (side, amount, shares)  ← COUNT #1 (ONLY)
    ↓
hyperliquid.html: Receives WebSocket event
    ↓
hyperliquid.html: Fetches updated volume from server
    ↓
Display shows correct 1x volume ✅
```

## Files Changed

### 1. `/home/ubuntu/dev/cpi_oracle/web/public/app.js` (Line 2659-2672)

**Before:**
```javascript
if (confirmed) {
    addLog(`Trade SUCCESS: ${tradeDesc}`, 'success');
    showStatus('Trade success: ' + signature.substring(0, 16) + '...');

    // Show toast notification
    const actionText = action.toUpperCase();
    const sideText = side === 'yes' ? 'UP' : 'DOWN';
    const toastTitle = `${actionText} ${sideText} Success`;
    const toastMessage = `${numShares.toFixed(2)} shares @ $${sharePrice.toFixed(4)}`;
    showToast('success', toastTitle, toastMessage);

    // Update server volume for BUY trades
    if (action === 'buy') {
        try {
            await fetch('/api/volume', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    side: side.toUpperCase(),
                    amount: estimatedCost,
                    shares: numShares
                })
            });
        } catch (volumeErr) {
            console.error('Failed to update volume:', volumeErr);
            // Don't fail the trade if volume update fails
        }
    }
}
```

**After:**
```javascript
if (confirmed) {
    addLog(`Trade SUCCESS: ${tradeDesc}`, 'success');
    showStatus('Trade success: ' + signature.substring(0, 16) + '...');

    // Show toast notification
    const actionText = action.toUpperCase();
    const sideText = side === 'yes' ? 'UP' : 'DOWN';
    const toastTitle = `${actionText} ${sideText} Success`;
    const toastMessage = `${numShares.toFixed(2)} shares @ $${sharePrice.toFixed(4)}`;
    showToast('success', toastTitle, toastMessage);

    // Volume is updated by trade_monitor.js (reads from on-chain logs)
    // Don't update here to avoid double-counting
}
```

### 2. `/home/ubuntu/dev/cpi_oracle/web/public/hyperliquid.html` (Line 538-553)

**Before:**
```javascript
// Optimistic volume update (instant feedback)
function updateVolumeOptimistic(trade) {
    // Only update for BUY trades
    if (trade.action !== 'BUY') return;

    const amount = parseFloat(trade.amount) || 0;
    const shares = parseFloat(trade.shares) || 0;
    const side = trade.side.toUpperCase();

    if (side === 'YES') {
        localVolume.upVolume += amount;
        localVolume.upShares += shares;
    } else if (side === 'NO') {
        localVolume.downVolume += amount;
        localVolume.downShares += shares;
    }

    localVolume.totalVolume = localVolume.upVolume + localVolume.downVolume;
    localVolume.totalShares = localVolume.upShares + localVolume.downShares;

    // Instantly update UI with optimistic value
    updateVolumeDisplay(localVolume);

    // Schedule server confirmation (debounced - only if not already scheduled)
    if (!updateVolumeOptimistic.pending) {
        updateVolumeOptimistic.pending = true;
        setTimeout(() => {
            updateCumulativeVolume();
            updateVolumeOptimistic.pending = false;
        }, 1000); // Confirm with server after 1 second
    }
}
```

**After:**
```javascript
// Volume update - fetch from server (removes double-counting issue)
function updateVolumeOptimistic(trade) {
    // Only update for BUY trades
    if (trade.action !== 'BUY') return;

    // Don't do optimistic local updates - they cause double counting
    // because trade_monitor.js already POSTs to /api/volume when it detects trades
    // Just fetch the latest server data immediately
    if (!updateVolumeOptimistic.pending) {
        updateVolumeOptimistic.pending = true;
        setTimeout(() => {
            updateCumulativeVolume();
            updateVolumeOptimistic.pending = false;
        }, 500); // Fetch server data after brief delay
    }
}
```

## How Volume Tracking Works Now

### Server-Side (trade_monitor.js):
```javascript
// Line 408-415
if (trade.action === 'BUY') {
    const amount = parseFloat(trade.amount);
    const shares = parseFloat(trade.shares);
    if (!isNaN(amount) && amount > 0 && !isNaN(shares) && shares > 0) {
        updateCumulativeVolume(trade.side, amount, shares);  // POST to /api/volume
    }
}
```

### Server API (server.js):
```javascript
// Line 278-332
if (req.url === '/api/volume' && req.method === 'POST') {
    const data = JSON.parse(body);
    const side = data.side; // 'YES' or 'NO'
    const amount = parseFloat(data.amount); // XNT amount
    const shares = parseFloat(data.shares); // Number of shares

    if ((side === 'YES' || side === 'NO') && amount > 0 && shares > 0) {
        if (side === 'YES') {
            cumulativeVolume.upVolume += amount;
            cumulativeVolume.upShares += shares;
        } else {
            cumulativeVolume.downVolume += amount;
            cumulativeVolume.downShares += shares;
        }
        cumulativeVolume.totalVolume = cumulativeVolume.upVolume + cumulativeVolume.downVolume;
        cumulativeVolume.totalShares = cumulativeVolume.upShares + cumulativeVolume.downShares;
        cumulativeVolume.lastUpdate = Date.now();
    }
}
```

### Client-Side (hyperliquid.html):
```javascript
// Line 556-597
async function updateCumulativeVolume() {
    const response = await fetch('/api/volume');  // GET latest volume
    const data = await response.json();

    localVolume = {
        upVolume: data.upVolume,
        downVolume: data.downVolume,
        totalVolume: data.totalVolume,
        upShares: data.upShares || 0,
        downShares: data.downShares || 0,
        totalShares: data.totalShares || 0
    };

    updateVolumeDisplay(localVolume);  // Update UI
}
```

## Testing

To verify the fix works:

1. **Reset volume:**
   ```bash
   curl -X POST http://localhost:3434/api/volume/reset
   ```

2. **Execute a BUY trade:**
   - Open UI at http://localhost:3434
   - Execute a BUY trade (e.g., 10 YES shares)

3. **Verify volume shows 1x (not 2x):**
   - Check "UP VOLUME" or "DOWN VOLUME" in UI
   - Should show the actual trade amount once
   - Check server logs for single volume update

4. **Check trade monitor logs:**
   ```bash
   tail -f /home/ubuntu/dev/cpi_oracle/web/trade_monitor.log
   ```
   Should see: `Cumulative volume updated: YES +X.XX XNT`

## Benefits

1. **Accurate Volume Tracking** - No more double-counting
2. **Single Source of Truth** - trade_monitor.js reads from blockchain
3. **Reliable** - Based on actual confirmed transactions, not client estimates
4. **Consistent** - All clients see the same volume from server

## Services Required

All three services must be running:

1. **Web Server** (port 3434)
   ```bash
   cd /home/ubuntu/dev/cpi_oracle/web
   node server.js
   ```

2. **Trade Monitor** (reads on-chain logs)
   ```bash
   cd /home/ubuntu/dev/cpi_oracle/web
   node trade_monitor.js
   ```

3. **Settlement Bot** (manages market lifecycle)
   ```bash
   cd /home/ubuntu/dev/cpi_oracle
   node app/settlement_bot.js
   ```

## Implementation Date

2025-10-28
