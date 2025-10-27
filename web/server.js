const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3434;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUS_FILE = path.join(__dirname, '..', 'market_status.json');
const PRICE_HISTORY_FILE = path.join(__dirname, 'price_history.json');

// In-memory price history storage
let priceHistory = [];
const MAX_PRICE_HISTORY = 86400; // Keep up to 24 hours of price data (1 per second)

// Load price history from disk on startup
function loadPriceHistory() {
    try {
        if (fs.existsSync(PRICE_HISTORY_FILE)) {
            const data = fs.readFileSync(PRICE_HISTORY_FILE, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed.prices && Array.isArray(parsed.prices)) {
                priceHistory = parsed.prices;
                console.log(`Loaded ${priceHistory.length} price points from disk`);
            }
        }
    } catch (err) {
        console.warn('Failed to load price history:', err.message);
        priceHistory = [];
    }
}

// Save price history to disk (throttled)
let savePending = false;
function savePriceHistory() {
    if (savePending) return;
    savePending = true;

    setTimeout(() => {
        try {
            const data = {
                prices: priceHistory,
                lastUpdate: Date.now()
            };
            fs.writeFileSync(PRICE_HISTORY_FILE, JSON.stringify(data));
        } catch (err) {
            console.warn('Failed to save price history:', err.message);
        }
        savePending = false;
    }, 1000); // Batch writes every 1 second
}

// Initialize price history
loadPriceHistory();

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
    // API: Get price history
    if (req.url.startsWith('/api/price-history') && req.method === 'GET') {
        // Parse query parameters for time range
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const seconds = parseInt(urlObj.searchParams.get('seconds')) || priceHistory.length;

        // Return only the requested number of recent data points
        const requestedData = seconds >= priceHistory.length
            ? priceHistory
            : priceHistory.slice(-seconds);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({
            prices: requestedData,
            totalPoints: priceHistory.length,
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
                    // Add price with timestamp
                    priceHistory.push({
                        price: data.price,
                        timestamp: Date.now()
                    });

                    // Keep only last MAX_PRICE_HISTORY points
                    if (priceHistory.length > MAX_PRICE_HISTORY) {
                        priceHistory = priceHistory.slice(-MAX_PRICE_HISTORY);
                    }

                    // Save to disk
                    savePriceHistory();

                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ success: true, count: priceHistory.length }));
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
            // Add no-cache headers for JavaScript files to prevent stale code
            const headers = {
                'Content-Type': contentType,
                ...SECURITY_HEADERS
            };

            if (ext === '.js') {
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
