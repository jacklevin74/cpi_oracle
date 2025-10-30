# Volume SQLite Persistence Implementation

## Overview
Volume data is now persisted per market cycle in SQLite3 database, allowing volume to survive server restarts and providing historical volume tracking.

## Database Schema

### New Table: `volume_history`

```sql
CREATE TABLE volume_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL UNIQUE,           -- e.g., "cycle_1761683040758"
    cycle_start_time INTEGER NOT NULL,        -- Timestamp when cycle started
    up_volume REAL NOT NULL DEFAULT 0,        -- Total XNT spent on UP/YES trades
    down_volume REAL NOT NULL DEFAULT 0,      -- Total XNT spent on DOWN/NO trades
    total_volume REAL NOT NULL DEFAULT 0,     -- Sum of both
    up_shares REAL NOT NULL DEFAULT 0,        -- Total shares bought on UP/YES
    down_shares REAL NOT NULL DEFAULT 0,      -- Total shares bought on DOWN/NO
    total_shares REAL NOT NULL DEFAULT 0,     -- Sum of both
    last_update INTEGER NOT NULL,             -- Timestamp of last update
    market_state TEXT                         -- Optional market state
);

CREATE INDEX idx_volume_cycle ON volume_history(cycle_id);
CREATE INDEX idx_volume_start_time ON volume_history(cycle_start_time DESC);
```

## Key Changes

### 1. Volume Object Structure (server.js)

**Before:**
```javascript
let cumulativeVolume = {
    upVolume: 0,
    downVolume: 0,
    totalVolume: 0,
    upShares: 0,
    downShares: 0,
    totalShares: 0,
    lastUpdate: 0,
    cycleStartTime: Date.now()
};
```

**After:**
```javascript
let cumulativeVolume = {
    cycleId: null,   // NEW: Unique cycle identifier
    upVolume: 0,
    downVolume: 0,
    totalVolume: 0,
    upShares: 0,
    downShares: 0,
    totalShares: 0,
    lastUpdate: 0,
    cycleStartTime: Date.now()
};
```

### 2. Load Function (server.js lines 141-194)

**Before:**
- Always started with volume = 0
- No persistence

**After:**
```javascript
function loadCumulativeVolume() {
    // Load most recent cycle from database
    const stmt = db.prepare('SELECT * FROM volume_history ORDER BY cycle_start_time DESC LIMIT 1');
    const row = stmt.get();

    if (row) {
        // Restore volume from database
        cumulativeVolume = {
            cycleId: row.cycle_id,
            upVolume: row.up_volume,
            downVolume: row.down_volume,
            totalVolume: row.total_volume,
            upShares: row.up_shares,
            downShares: row.down_shares,
            totalShares: row.total_shares,
            lastUpdate: row.last_update,
            cycleStartTime: row.cycle_start_time
        };
        console.log(`Loaded volume for cycle ${row.cycle_id}: ${row.total_volume.toFixed(2)} XNT total`);
    } else {
        // No existing cycle, create new one
        const cycleId = `cycle_${Date.now()}`;
        cumulativeVolume = { cycleId, ...zeros };
        saveCumulativeVolume();
    }
}
```

### 3. Save Function (server.js lines 196-230)

**Before:**
- No-op function (did nothing)

**After:**
```javascript
function saveCumulativeVolume() {
    const stmt = db.prepare(`
        INSERT INTO volume_history (
            cycle_id, cycle_start_time, up_volume, down_volume, total_volume,
            up_shares, down_shares, total_shares, last_update, market_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cycle_id) DO UPDATE SET
            up_volume = excluded.up_volume,
            down_volume = excluded.down_volume,
            total_volume = excluded.total_volume,
            up_shares = excluded.up_shares,
            down_shares = excluded.down_shares,
            total_shares = excluded.total_shares,
            last_update = excluded.last_update,
            market_state = excluded.market_state
    `);

    stmt.run(
        cumulativeVolume.cycleId,
        cumulativeVolume.cycleStartTime,
        cumulativeVolume.upVolume,
        cumulativeVolume.downVolume,
        cumulativeVolume.totalVolume,
        cumulativeVolume.upShares,
        cumulativeVolume.downShares,
        cumulativeVolume.totalShares,
        cumulativeVolume.lastUpdate,
        null
    );
}
```

### 4. Reset Endpoint (server.js lines 417-440)

**Before:**
```javascript
POST /api/volume/reset
// Just reset in-memory object
```

**After:**
```javascript
POST /api/volume/reset
// Create NEW cycle with unique ID
const cycleId = `cycle_${Date.now()}`;
cumulativeVolume = { cycleId, ...zeros };
saveCumulativeVolume();
console.log(`📊 Volume reset - new cycle started: ${cycleId}`);
```

## Data Flow

### On Server Start:
1. Server loads most recent cycle from `volume_history` table
2. If cycle exists, restores volume data
3. If no cycle exists, creates new cycle with ID `cycle_${timestamp}`

### On Trade:
1. Trade monitor POSTs to `/api/volume` with trade data
2. Server updates in-memory `cumulativeVolume` object
3. Server calls `saveCumulativeVolume()`
4. Data is written to SQLite via `INSERT ... ON CONFLICT ... UPDATE`

### On New Market Cycle:
1. Settlement bot calls `POST /api/volume/reset`
2. Server creates NEW cycle with unique ID
3. Old cycle remains in database for history
4. New cycle starts at volume = 0

### On Server Restart:
1. Server loads most recent cycle from database
2. Volume persists across restarts! ✅

## API Endpoints

### GET /api/volume
Returns current cycle volume:
```json
{
    "cycleId": "cycle_1761683040758",
    "upVolume": 123.45,
    "downVolume": 67.89,
    "totalVolume": 191.34,
    "upShares": 1500.0,
    "downShares": 800.0,
    "totalShares": 2300.0,
    "lastUpdate": 1761683040758,
    "cycleStartTime": 1761683040758
}
```

### POST /api/volume
Update current cycle volume (called by trade_monitor):
```json
{
    "side": "YES",
    "amount": 10.5,
    "shares": 15.0
}
```

### POST /api/volume/reset
Start new market cycle:
```json
{
    "success": true,
    "volume": { /* new cycle object */ }
}
```

## Benefits

1. **Persistence**: Volume survives server restarts
2. **Historical Data**: Each cycle is preserved in database
3. **Audit Trail**: Can query past cycle volumes
4. **Reliability**: No data loss on crashes

## Querying Volume History

### Get all cycles:
```bash
sqlite3 price_history.db "SELECT * FROM volume_history ORDER BY cycle_start_time DESC;"
```

### Get specific cycle:
```bash
sqlite3 price_history.db "SELECT * FROM volume_history WHERE cycle_id = 'cycle_1761683040758';"
```

### Get total volume per cycle:
```bash
sqlite3 price_history.db "SELECT cycle_id, total_volume, total_shares, datetime(cycle_start_time/1000, 'unixepoch') as start_time FROM volume_history ORDER BY cycle_start_time DESC;"
```

### Get summary statistics:
```bash
sqlite3 price_history.db "
    SELECT
        COUNT(*) as total_cycles,
        SUM(total_volume) as cumulative_volume,
        AVG(total_volume) as avg_volume_per_cycle,
        MAX(total_volume) as max_volume_cycle,
        SUM(total_shares) as cumulative_shares
    FROM volume_history;
"
```

## Migration Notes

- Existing installations will automatically create the new table on server start
- First run will create a new cycle (cycle_${timestamp})
- No data migration needed (old in-memory data was ephemeral)

## Database Location

`/home/ubuntu/dev/cpi_oracle/web/price_history.db`

## Testing

### Test persistence:
```bash
# 1. Check current volume
curl http://localhost:3434/api/volume

# 2. Restart server
kill <server_pid>
node server.js

# 3. Check volume again - should be the same!
curl http://localhost:3434/api/volume
```

### Test new cycle:
```bash
# Reset volume
curl -X POST http://localhost:3434/api/volume/reset

# Check database - should see new cycle
sqlite3 price_history.db "SELECT * FROM volume_history;"
```

## Implementation Date

2025-10-28
