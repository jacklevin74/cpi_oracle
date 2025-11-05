/**
 * Example: Using TypeScript database layer from JavaScript
 *
 * This demonstrates how to import and use the compiled TypeScript
 * modules in your existing JavaScript server code.
 */

const { DatabaseService, PriceHistoryRepository, VolumeRepository } = require('./dist/database');

// Initialize database with configuration
const dbService = new DatabaseService({
  dbFile: './price_history.db',
  maxPriceHistoryHours: 24,
  maxSettlementHistoryHours: 168,
  maxTradingHistoryHours: 168
});

const db = dbService.getDatabase();

// Create repositories
const priceRepo = new PriceHistoryRepository(db);
const volumeRepo = new VolumeRepository(db);

// Example 1: Add a price
console.log('Adding price...');
priceRepo.insert(68500.25, Date.now());

// Example 2: Get latest price
const latest = priceRepo.getLatest();
console.log('Latest price:', latest ? `$${latest.price.toFixed(2)}` : 'none');

// Example 3: Get recent prices
const recentPrices = priceRepo.find({ seconds: 3600, limit: 100 });
console.log(`Found ${recentPrices.length} prices in last hour`);

// Example 4: Load current volume cycle
const volume = volumeRepo.loadCurrent();
if (volume) {
  console.log(`Current cycle: ${volume.cycleId}`);
  console.log(`Total volume: ${volume.totalVolume.toFixed(2)} XNT`);
} else {
  console.log('No active volume cycle');
}

// Example 5: Get database stats
const stats = dbService.getStats();
console.log('\nDatabase stats:', JSON.stringify(stats, null, 2));

// Clean up
dbService.close();
console.log('\n✅ TypeScript modules work perfectly from JavaScript!');
