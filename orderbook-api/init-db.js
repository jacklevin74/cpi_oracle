const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'orders.db');

console.log('🗄️  Initializing database at:', DB_PATH);

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
    process.exit(1);
  }
  console.log('✅ Connected to SQLite database');
});

// Create orders table
const schema = `
CREATE TABLE IF NOT EXISTS orders (
  -- Primary key
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Order hash (SHA256 of serialized order)
  order_hash TEXT UNIQUE NOT NULL,

  -- Full order details (JSON)
  order_json TEXT NOT NULL,

  -- User's Ed25519 signature (hex-encoded, 128 chars)
  signature TEXT NOT NULL,

  -- Indexed fields for efficient queries
  market TEXT NOT NULL,
  user_pubkey TEXT NOT NULL,
  action INTEGER NOT NULL,           -- 1=BUY, 2=SELL
  side INTEGER NOT NULL,             -- 1=YES, 2=NO
  limit_price_e6 INTEGER NOT NULL,
  shares_e6 INTEGER NOT NULL,
  expiry_ts INTEGER NOT NULL,

  -- Order status
  status TEXT NOT NULL DEFAULT 'pending',
  -- Status values: 'pending', 'filled', 'cancelled', 'expired', 'failed'

  -- Execution details (if filled)
  filled_tx TEXT,
  filled_at INTEGER,
  filled_shares_e6 INTEGER,
  execution_price_e6 INTEGER,
  keeper_pubkey TEXT,

  -- Metadata
  submitted_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_market_status ON orders(market, status);
CREATE INDEX IF NOT EXISTS idx_user ON orders(user_pubkey);
CREATE INDEX IF NOT EXISTS idx_expiry ON orders(expiry_ts);
CREATE INDEX IF NOT EXISTS idx_price ON orders(market, action, side, limit_price_e6);
CREATE INDEX IF NOT EXISTS idx_submitted ON orders(submitted_at);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_orders_timestamp
AFTER UPDATE ON orders
BEGIN
  UPDATE orders SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;
`;

db.exec(schema, (err) => {
  if (err) {
    console.error('❌ Error creating schema:', err);
    db.close();
    process.exit(1);
  }

  console.log('✅ Database schema created successfully');

  // Show table info
  db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
    if (err) {
      console.error('❌ Error querying tables:', err);
    } else {
      console.log('📊 Tables:', tables.map(t => t.name).join(', '));
    }

    // Show index info
    db.all("SELECT name FROM sqlite_master WHERE type='index'", [], (err, indexes) => {
      if (err) {
        console.error('❌ Error querying indexes:', err);
      } else {
        console.log('🔍 Indexes:', indexes.map(i => i.name).join(', '));
      }

      db.close((err) => {
        if (err) {
          console.error('❌ Error closing database:', err);
          process.exit(1);
        }
        console.log('✅ Database initialization complete!');
      });
    });
  });
});
