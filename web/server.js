const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = 3434;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUS_FILE = path.join(__dirname, '..', 'market_status.json');
const DB_FILE = path.join(__dirname, 'price_history.db');
const VOLUME_FILE = path.join(__dirname, 'cumulative_volume.json');

// SQLite database for price history
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // Better concurrency

// Ensure schema exists
db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        price REAL NOT NULL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON price_history(timestamp);

    CREATE TABLE IF NOT EXISTS settlement_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_prefix TEXT NOT NULL,
        result TEXT NOT NULL,
        amount REAL NOT NULL,
        side TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_timestamp ON settlement_history(timestamp);

    CREATE TABLE IF NOT EXISTS trading_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_prefix TEXT NOT NULL,
        action TEXT NOT NULL,
        side TEXT NOT NULL,
        shares REAL NOT NULL,
        cost_usd REAL NOT NULL,
        avg_price REAL NOT NULL,
        pnl REAL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trading_user_timestamp ON trading_history(user_prefix, timestamp DESC);
`);

const MAX_PRICE_HISTORY_HOURS = 24; // Keep up to 24 hours of price data
const MAX_SETTLEMENT_HISTORY_HOURS = 168; // Keep 7 days of settlement history
const MAX_TRADING_HISTORY_HOURS = 168; // Keep 7 days of trading history

// Current market volume (resets each market cycle)
let cumulativeVolume = {
    upVolume: 0,     // Total XNT spent on UP/YES trades this cycle
    downVolume: 0,   // Total XNT spent on DOWN/NO trades this cycle
    totalVolume: 0,  // Sum of both
    upShares: 0,     // Total shares bought on UP/YES side
    downShares: 0,   // Total shares bought on DOWN/NO side
    totalShares: 0,  // Sum of both
    lastUpdate: 0,   // Timestamp of last update
    cycleStartTime: Date.now() // When this market cycle started
};

// Get price history count
function getPriceHistoryCount() {
    try {
        const result = db.prepare('SELECT COUNT(*) as count FROM price_history').get();
        return result.count;
    } catch (err) {
        console.error('Failed to get price count:', err.message);
        return 0;
    }
}

// Get price history for a time range
function getPriceHistory(seconds = null) {
    try {
        let stmt;
        if (seconds) {
            const cutoffTime = Date.now() - (seconds * 1000);
            stmt = db.prepare('SELECT price, timestamp FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC');
            return stmt.all(cutoffTime);
        } else {
            stmt = db.prepare('SELECT price, timestamp FROM price_history ORDER BY timestamp ASC');
            return stmt.all();
        }
    } catch (err) {
        console.error('Failed to query price history:', err.message);
        return [];
    }
}

// Add price to history
function addPriceToHistory(price, timestamp = Date.now()) {
    try {
        const stmt = db.prepare('INSERT INTO price_history (price, timestamp) VALUES (?, ?)');
        stmt.run(price, timestamp);
        return true;
    } catch (err) {
        console.error('Failed to add price:', err.message);
        return false;
    }
}

// Cleanup old price data (older than MAX_PRICE_HISTORY_HOURS)
function cleanupOldPrices() {
    try {
        const cutoffTime = Date.now() - (MAX_PRICE_HISTORY_HOURS * 60 * 60 * 1000);
        const stmt = db.prepare('DELETE FROM price_history WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`Cleaned up ${result.changes} old price records`);
        }
        return result.changes;
    } catch (err) {
        console.error('Failed to cleanup old prices:', err.message);
        return 0;
    }
}

// Load cumulative volume from disk on startup
function loadCumulativeVolume() {
    try {
        if (fs.existsSync(VOLUME_FILE)) {
            const data = fs.readFileSync(VOLUME_FILE, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed.upVolume === 'number') {
                // Ensure all fields exist (backward compatibility)
                cumulativeVolume = {
                    upVolume: parsed.upVolume || 0,
                    downVolume: parsed.downVolume || 0,
                    totalVolume: parsed.totalVolume || 0,
                    upShares: parsed.upShares || 0,
                    downShares: parsed.downShares || 0,
                    totalShares: parsed.totalShares || 0,
                    lastUpdate: parsed.lastUpdate || 0,
                    cycleStartTime: parsed.cycleStartTime || Date.now()
                };
                console.log(`Loaded cumulative volume: UP=${cumulativeVolume.upVolume.toFixed(2)} XNT / ${cumulativeVolume.upShares.toFixed(2)} shares, DOWN=${cumulativeVolume.downVolume.toFixed(2)} XNT / ${cumulativeVolume.downShares.toFixed(2)} shares, TOTAL=${cumulativeVolume.totalVolume.toFixed(2)} XNT / ${cumulativeVolume.totalShares.toFixed(2)} shares`);
            }
        }
    } catch (err) {
        console.warn('Failed to load cumulative volume:', err.message);
        cumulativeVolume = {
            upVolume: 0,
            downVolume: 0,
            totalVolume: 0,
            upShares: 0,
            downShares: 0,
            totalShares: 0,
            lastUpdate: 0,
            cycleStartTime: Date.now()
        };
    }
}

// Save cumulative volume to disk (throttled)
let volumeSavePending = false;
function saveCumulativeVolume() {
    if (volumeSavePending) return;
    volumeSavePending = true;

    setTimeout(() => {
        try {
            fs.writeFileSync(VOLUME_FILE, JSON.stringify(cumulativeVolume, null, 2));
        } catch (err) {
            console.warn('Failed to save cumulative volume:', err.message);
        }
        volumeSavePending = false;
    }, 1000); // Batch writes every 1 second
}

// Settlement history functions
function addSettlementHistory(userPrefix, result, amount, side) {
    try {
        const stmt = db.prepare('INSERT INTO settlement_history (user_prefix, result, amount, side, timestamp) VALUES (?, ?, ?, ?, ?)');
        stmt.run(userPrefix, result, amount, side, Date.now());
        return true;
    } catch (err) {
        console.error('Failed to add settlement:', err.message);
        return false;
    }
}

function getSettlementHistory(limit = 100) {
    try {
        const stmt = db.prepare('SELECT * FROM settlement_history ORDER BY timestamp DESC LIMIT ?');
        return stmt.all(limit);
    } catch (err) {
        console.error('Failed to get settlement history:', err.message);
        return [];
    }
}

function cleanupOldSettlements() {
    try {
        const cutoffTime = Date.now() - (MAX_SETTLEMENT_HISTORY_HOURS * 60 * 60 * 1000);
        const stmt = db.prepare('DELETE FROM settlement_history WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`Cleaned up ${result.changes} old settlement records`);
        }
        return result.changes;
    } catch (err) {
        console.error('Failed to cleanup old settlements:', err.message);
        return 0;
    }
}

// Trading history functions
function addTradingHistory(userPrefix, action, side, shares, costUsd, avgPrice, pnl = null) {
    try {
        const stmt = db.prepare('INSERT INTO trading_history (user_prefix, action, side, shares, cost_usd, avg_price, pnl, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        stmt.run(userPrefix, action, side, shares, costUsd, avgPrice, pnl, Date.now());
        return true;
    } catch (err) {
        console.error('Failed to add trading history:', err.message);
        return false;
    }
}

function getTradingHistory(userPrefix, limit = 100) {
    try {
        const stmt = db.prepare('SELECT * FROM trading_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT ?');
        return stmt.all(userPrefix, limit);
    } catch (err) {
        console.error('Failed to get trading history:', err.message);
        return [];
    }
}

function cleanupOldTradingHistory() {
    try {
        const cutoffTime = Date.now() - (MAX_TRADING_HISTORY_HOURS * 60 * 60 * 1000);
        const stmt = db.prepare('DELETE FROM trading_history WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`Cleaned up ${result.changes} old trading records`);
        }
        return result.changes;
    } catch (err) {
        console.error('Failed to cleanup old trading history:', err.message);
        return 0;
    }
}

// Initialize volume and show DB stats
loadCumulativeVolume();

// Log database statistics
const priceCount = getPriceHistoryCount();
const settlementCount = db.prepare('SELECT COUNT(*) as count FROM settlement_history').get().count;
const tradingCount = db.prepare('SELECT COUNT(*) as count FROM trading_history').get().count;
console.log(`SQLite database loaded with ${priceCount} price records, ${settlementCount} settlement records, and ${tradingCount} trading records`);

// Run cleanup on startup
cleanupOldPrices();
cleanupOldSettlements();
cleanupOldTradingHistory();

// Schedule periodic cleanup (every hour)
setInterval(() => {
    cleanupOldPrices();
    cleanupOldSettlements();
    cleanupOldTradingHistory();
}, 60 * 60 * 1000);

// Security headers
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.testnet.x1.xyz wss://rpc.testnet.x1.xyz ws://localhost:3435 wss://localhost:3435; img-src 'self' data:; font-src 'self'"
};

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    // API: Get cumulative volume
    if (req.url === '/api/volume' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify(cumulativeVolume));
        return;
    }

    // API: Add to cumulative volume (only increases, never decreases)
    if (req.url === '/api/volume' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 1000) {
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const side = data.side; // 'YES' or 'NO'
                const amount = parseFloat(data.amount); // XNT amount
                const shares = parseFloat(data.shares); // Number of shares

                if ((side === 'YES' || side === 'NO') && amount > 0 && shares > 0) {
                    // Add to current market volume
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

                    // Save to disk
                    saveCumulativeVolume();

                    console.log(`Volume updated: ${side} +${amount.toFixed(2)} XNT / +${shares.toFixed(2)} shares (Total: ${cumulativeVolume.totalVolume.toFixed(2)} XNT / ${cumulativeVolume.totalShares.toFixed(2)} shares)`);

                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ success: true, volume: cumulativeVolume }));
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid side, amount, or shares' }));
                }
            } catch (err) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // API: Reset volume for new market cycle
    if (req.url === '/api/volume/reset' && req.method === 'POST') {
        cumulativeVolume = {
            upVolume: 0,
            downVolume: 0,
            totalVolume: 0,
            upShares: 0,
            downShares: 0,
            totalShares: 0,
            lastUpdate: Date.now(),
            cycleStartTime: Date.now()
        };
        saveCumulativeVolume();
        console.log('📊 Volume reset for new market cycle');

        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({ success: true, volume: cumulativeVolume }));
        return;
    }

    // API: Get price history
    if (req.url.startsWith('/api/price-history') && req.method === 'GET') {
        // Parse query parameters for time range
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const seconds = parseInt(urlObj.searchParams.get('seconds')) || null;

        // Query from SQLite
        const prices = getPriceHistory(seconds);
        const totalCount = getPriceHistoryCount();

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({
            prices: prices,
            totalPoints: totalCount,
            lastUpdate: Date.now()
        }));
        return;
    }

    // API: Add price to history
    if (req.url === '/api/price-history' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            // Prevent huge payloads
            if (body.length > 1000) {
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (typeof data.price === 'number' && data.price > 0) {
                    // Add to SQLite database
                    const success = addPriceToHistory(data.price);

                    if (success) {
                        const count = getPriceHistoryCount();
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ success: true, count: count }));
                    } else {
                        res.writeHead(500, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ error: 'Failed to save price' }));
                    }
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid price' }));
                }
            } catch (err) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // API: Get settlement history
    if (req.url === '/api/settlement-history' && req.method === 'GET') {
        const history = getSettlementHistory(100);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({ history: history }));
        return;
    }

    // API: Add settlement to history
    if (req.url === '/api/settlement-history' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 1000) {
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.userPrefix && data.result && typeof data.amount === 'number' && data.side) {
                    const success = addSettlementHistory(data.userPrefix, data.result, data.amount, data.side);
                    if (success) {
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ success: true }));
                    } else {
                        res.writeHead(500, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ error: 'Failed to save settlement' }));
                    }
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid settlement data' }));
                }
            } catch (err) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // API: Get trading history for a user
    if (req.url.startsWith('/api/trading-history/') && req.method === 'GET') {
        const userPrefix = req.url.split('/api/trading-history/')[1];
        if (userPrefix && userPrefix.length >= 6) {
            const history = getTradingHistory(userPrefix, 100);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ history: history }));
        } else {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ error: 'Invalid user prefix' }));
        }
        return;
    }

    // API: Add trade to trading history
    if (req.url === '/api/trading-history' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 2000) {
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.userPrefix && data.action && data.side &&
                    typeof data.shares === 'number' && typeof data.costUsd === 'number' &&
                    typeof data.avgPrice === 'number') {
                    const success = addTradingHistory(
                        data.userPrefix,
                        data.action,
                        data.side,
                        data.shares,
                        data.costUsd,
                        data.avgPrice,
                        data.pnl || null
                    );
                    if (success) {
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ success: true }));
                    } else {
                        res.writeHead(500, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ error: 'Failed to save trade' }));
                    }
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid trade data' }));
                }
            } catch (err) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // Handle market_status.json specially (serve from project root)
    if (req.url.startsWith('/market_status.json')) {
        fs.readFile(STATUS_FILE, (err, content) => {
            if (err) {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ state: 'OFFLINE' }));
            } else {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    ...SECURITY_HEADERS
                });
                res.end(content);
            }
        });
        return;
    }

    // Route handling
    let filePath;
    if (req.url === '/') {
        filePath = '/hyperliquid.html';
    } else if (req.url === '/hl' || req.url === '/hyperliquid') {
        filePath = '/hyperliquid.html';
    } else if (req.url === '/proto1') {
        filePath = '/hyperliquid.html';
    } else if (req.url === '/index') {
        filePath = '/index.html';
    } else if (req.url === '/proto1-original') {
        filePath = '/proto1_original.html';
    } else {
        filePath = req.url;
    }
    filePath = path.join(PUBLIC_DIR, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, SECURITY_HEADERS);
                res.end('404 Not Found');
            } else {
                res.writeHead(500, SECURITY_HEADERS);
                res.end('500 Internal Server Error');
            }
        } else {
            // Add no-cache headers for JavaScript and HTML files to prevent stale code
            const headers = {
                'Content-Type': contentType,
                ...SECURITY_HEADERS
            };

            if (ext === '.js' || ext === '.html') {
                headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
                headers['Pragma'] = 'no-cache';
                headers['Expires'] = '0';
            }

            res.writeHead(200, headers);
            res.end(content);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}/`);
    console.log(`Local: http://localhost:${PORT}/`);
});
