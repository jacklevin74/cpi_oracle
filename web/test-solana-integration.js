/**
 * JavaScript Integration Test for Solana Services
 *
 * Verifies that compiled TypeScript modules can be used from plain JavaScript
 */

const { Connection } = require('@solana/web3.js');
const { OracleService, MarketService } = require('./dist/solana');

const RPC_URL = 'https://rpc.testnet.x1.xyz';
const ORACLE_STATE = '4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq';
const PROGRAM_ID = 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF';

async function main() {
  console.log('\n=== JavaScript Integration Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');

  // Test OracleService
  console.log('Testing OracleService from JavaScript...');
  const oracleService = new OracleService(connection, ORACLE_STATE, {
    enableLogging: false,
  });

  const price = await oracleService.fetchPrice();
  if (!price) {
    console.error('❌ Failed to fetch oracle price');
    process.exit(1);
  }

  console.log(`✅ Oracle: BTC $${price.price.toFixed(2)} (age: ${price.age}s)`);

  // Test MarketService
  console.log('\nTesting MarketService from JavaScript...');
  const marketService = new MarketService(connection, PROGRAM_ID, {
    ammSeed: 'amm_btc_v6',
    lamportsPerE6: 100,
    enableLogging: false,
  });

  const marketState = await marketService.fetchMarketState();
  if (!marketState) {
    console.error('❌ Failed to fetch market state');
    process.exit(1);
  }

  console.log(`✅ Market: status=${marketState.status} vault=${marketState.vault.toFixed(2)}`);

  // Test LMSR calculation
  const prices = marketService.calculatePrices(marketState);
  console.log(`✅ LMSR: YES=${(prices.probYes * 100).toFixed(2)}% NO=${(prices.probNo * 100).toFixed(2)}%`);

  console.log('\n=== All JavaScript Integration Tests Passed! ===\n');
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
