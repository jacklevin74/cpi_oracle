# API Logs Viewer Guide

## Quick Access

**Live Logs Dashboard:** http://localhost:3434/logs

---

## Overview

The API Logs Viewer is a real-time, terminal-style web interface that shows:
- **Which APIs are being accessed**
- **Which service type is handling each request** (TypeScript vs Original JavaScript)
- **Request/response details** with timestamps
- **Live statistics** (total requests, TypeScript vs JavaScript usage)

---

## Features

### Real-Time Monitoring
- ✅ Updates every 1 second
- ✅ Auto-scrolls to latest logs
- ✅ Shows last 500 entries
- ✅ Color-coded by service type

### Filtering
- **All** - Show all API requests
- **TypeScript** - Show only TypeScript service calls (🔷)
- **JavaScript** - Show only Original JavaScript calls (📦)

### Statistics Dashboard
- **Total Requests** - Count of all API calls
- **TypeScript Count** - TypeScript service usage
- **JavaScript Count** - Original JS service usage
- **Connection Status** - Live indicator (green = connected)

### Controls
- **Clear** - Clear all logs from display
- **Auto-scroll** - Toggle automatic scrolling (ON by default)
- **Filter buttons** - Show All / TypeScript / JavaScript

---

## Color Legend

```
🔵 Blue (Cyan)       = 📥 Incoming API Request
🟣 Purple            = 🔷 TypeScript Service
🟠 Orange            = 📦 Original JavaScript Service
🟢 Green             = ✅ Success / Completion
🔴 Red               = ❌ Error
```

---

## Service Type Indicators

### TypeScript Services (🔷)
```
🔷 SERVICE: TypeScript (OracleService + MarketService)
```
**APIs that use TypeScript:**
- `/api/typescript-demo` - Uses compiled TypeScript services

**What it means:**
- Data fetched using `OracleService.fetchPrice()`
- Market state from `MarketService.fetchMarketState()`
- Type-safe, compiled from `dist/solana/`
- Full compile-time checking

### Original JavaScript (📦)
```
📦 SERVICE: Original JavaScript (in-memory volume data)
📦 SERVICE: Original JavaScript (SQLite database query)
📦 SERVICE: Original JavaScript (cached oracle price)
```
**APIs that use JavaScript:**
- `/api/volume` - In-memory volume data
- `/api/price-history` - SQLite queries
- `/api/current-price` - Cached oracle price
- Most other `/api/*` endpoints

**What it means:**
- Data fetched using inline JavaScript functions
- Direct database queries
- No compile-time type checking
- Traditional implementation

---

## Example Log Entry

```
[2025-11-02T01:22:28.519Z] 📥 REQUEST: GET /api/typescript-demo
[2025-11-02T01:22:28.519Z] 🔷 SERVICE: TypeScript (OracleService + MarketService)
[2025-11-02T01:22:28.519Z] 📊 Fetching data from compiled TypeScript services...
[2025-11-02T01:22:28.520Z] ✅ TypeScript services returned:
[2025-11-02T01:22:28.520Z]    - BTC Price: $109960.15 (age: 0s)
[2025-11-02T01:22:28.520Z]    - Market Status: Stopped
[2025-11-02T01:22:28.520Z]    - YES Prob: 50.00% | NO Prob: 50.00%
```

**Breakdown:**
1. **Line 1:** Request received for `/api/typescript-demo`
2. **Line 2:** Service type identified as TypeScript
3. **Line 3:** Fetching data from compiled services
4. **Lines 4-7:** Results returned with details

---

## Usage Scenarios

### Scenario 1: Monitor Original Page (/)
1. Open http://localhost:3434/ in browser
2. Open http://localhost:3434/logs in another tab
3. Watch logs show **JavaScript services** (📦)
4. See requests like `/api/volume`, `/api/price-history`

### Scenario 2: Monitor TypeScript Page (/proto2)
1. Open http://localhost:3434/proto2 in browser
2. Open http://localhost:3434/logs in another tab
3. Watch logs show mix of services
4. If using `/api/typescript-demo`, see **TypeScript services** (🔷)

### Scenario 3: A/B Comparison
1. Open http://localhost:3434/ in left tab
2. Open http://localhost:3434/proto2 in right tab
3. Open http://localhost:3434/logs in bottom panel
4. Compare service types used by each page
5. Verify data accuracy between implementations

---

## Filter Examples

### Show Only TypeScript Calls
1. Click **TypeScript** filter button
2. See only requests with 🔷 indicator
3. Useful for monitoring TypeScript service usage

### Show Only JavaScript Calls
1. Click **JavaScript** filter button
2. See only requests with 📦 indicator
3. Useful for tracking legacy API usage

### Show All Requests
1. Click **All** filter button (default)
2. See all API activity
3. Best for full system monitoring

---

## API Endpoint

The logs are served via:
```
GET /api/logs?from=<position>&limit=<count>
```

**Parameters:**
- `from` - Start position in log buffer (default: 0)
- `limit` - Max number of entries to return (default: 100)

**Response:**
```json
{
  "logs": ["log line 1", "log line 2", ...],
  "position": 37,
  "total": 37
}
```

**Usage:**
```bash
# Get latest logs
curl -s "http://localhost:3434/api/logs?from=0&limit=50"

# Get only new logs since position 100
curl -s "http://localhost:3434/api/logs?from=100"
```

---

## Implementation Details

### Server-Side
- **Log Buffer:** In-memory circular buffer (max 1000 entries)
- **Function:** `logToBuffer(message)` - Logs to both console and buffer
- **Updates:** Real-time, no file system overhead
- **Persistence:** None (resets on server restart)

### Client-Side
- **Polling:** Fetches new logs every 1 second
- **Max Display:** 500 entries (auto-trims older)
- **Auto-scroll:** Enabled by default
- **Filters:** Client-side filtering (no server overhead)

---

## Troubleshooting

### Logs Not Updating
- Check connection status indicator (should be green)
- Verify server is running: `ps aux | grep server.js`
- Check browser console for errors (F12)

### Missing TypeScript Logs
- Verify `/api/typescript-demo` is being called
- Check if proto2 page is actually using TypeScript API
- Clear logs and refresh

### Too Many Logs
- Use filters to focus on specific service type
- Clear logs periodically
- Increase MAX_LOG_ENTRIES in server.js if needed

---

## Statistics Tracking

The dashboard tracks:

**Total Requests:**
- Counts all `📥 REQUEST:` entries
- Increments on every API call

**TypeScript Count:**
- Counts all `🔷` TypeScript service indicators
- Shows TypeScript service usage

**JavaScript Count:**
- Counts all `📦` JavaScript service indicators
- Shows traditional service usage

**Percentage:**
- Can calculate: `(TS / Total) * 100%`
- Shows migration progress

---

## Use Cases

### 1. Development & Debugging
- Monitor API traffic in real-time
- Identify which services are called
- Debug request/response flow

### 2. A/B Testing
- Compare `/` vs `/proto2` behavior
- Verify TypeScript services work correctly
- Ensure data parity

### 3. Migration Tracking
- Monitor TypeScript adoption rate
- Track which APIs still use JavaScript
- Plan migration priorities

### 4. Performance Monitoring
- See request frequency
- Identify hot endpoints
- Check response times (via timestamps)

---

## Keyboard Shortcuts

(Current implementation doesn't have shortcuts, but could add:)
- `A` - Show All
- `T` - Filter TypeScript
- `J` - Filter JavaScript
- `C` - Clear logs
- `S` - Toggle auto-scroll
- `Space` - Pause/Resume

---

## Future Enhancements

Possible improvements:
- 📊 Response time tracking
- 📈 Request rate graphs
- 💾 Export logs to file
- 🔍 Search/filter by text
- 📌 Pin important logs
- ⏸️  Pause/resume streaming
- 🎨 Custom color themes
- ⌨️  Keyboard shortcuts

---

## Quick Reference

| URL | Purpose |
|-----|---------|
| http://localhost:3434/logs | Live logs dashboard |
| http://localhost:3434/api/logs | Raw logs API |
| http://localhost:3434/ | Original page (JavaScript) |
| http://localhost:3434/proto2 | TypeScript test page |

---

**Last Updated:** 2025-11-02
**Status:** ✅ Live and functional
