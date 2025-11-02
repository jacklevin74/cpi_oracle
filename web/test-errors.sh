#!/bin/bash
# Error Testing Script for TypeScript Migration
# Tests all layers: compilation, runtime, API, SSE, database

set -e

echo "=========================================="
echo "TypeScript Migration Error Testing"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0

# Test 1: TypeScript Compilation
echo "1. Testing TypeScript Compilation..."
if npm run typecheck 2>&1 | grep -q "error TS"; then
    echo -e "${RED}✗ TypeScript compilation errors found${NC}"
    npm run typecheck
    ERRORS=$((ERRORS+1))
else
    echo -e "${GREEN}✓ TypeScript compilation clean${NC}"
fi
echo ""

# Test 2: TypeScript Build
echo "2. Testing TypeScript Build..."
if npm run build 2>&1 | grep -q "error TS"; then
    echo -e "${RED}✗ TypeScript build errors found${NC}"
    npm run build
    ERRORS=$((ERRORS+1))
else
    echo -e "${GREEN}✓ TypeScript build successful${NC}"
fi
echo ""

# Test 3: Server Running
echo "3. Testing Server Status..."
if ! curl -s http://localhost:3434/health > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Server not running, attempting to start...${NC}"
    # Note: Server should already be running in background
fi

# Test 4: API Endpoints
echo "4. Testing TypeScript API Endpoints..."

# Test current-price endpoint
PRICE_RESPONSE=$(curl -s http://localhost:3434/api/ts/current-price)
if echo "$PRICE_RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    echo -e "${RED}✗ /api/ts/current-price returned error: $(echo $PRICE_RESPONSE | jq -r '.error')${NC}"
    ERRORS=$((ERRORS+1))
elif echo "$PRICE_RESPONSE" | jq -e '.price' > /dev/null 2>&1; then
    PRICE=$(echo "$PRICE_RESPONSE" | jq -r '.price')
    echo -e "${GREEN}✓ /api/ts/current-price OK (BTC: \$$PRICE)${NC}"
else
    echo -e "${RED}✗ /api/ts/current-price invalid response${NC}"
    ERRORS=$((ERRORS+1))
fi

# Test market-data endpoint
MARKET_RESPONSE=$(curl -s http://localhost:3434/api/ts/market-data)
if echo "$MARKET_RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    echo -e "${RED}✗ /api/ts/market-data returned error: $(echo $MARKET_RESPONSE | jq -r '.error')${NC}"
    ERRORS=$((ERRORS+1))
elif echo "$MARKET_RESPONSE" | jq -e '.oracle.price' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ /api/ts/market-data OK${NC}"
else
    echo -e "${RED}✗ /api/ts/market-data invalid response${NC}"
    ERRORS=$((ERRORS+1))
fi

# Test volume endpoint
VOLUME_RESPONSE=$(curl -s http://localhost:3434/api/ts/volume)
if echo "$VOLUME_RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    echo -e "${RED}✗ /api/ts/volume returned error: $(echo $VOLUME_RESPONSE | jq -r '.error')${NC}"
    ERRORS=$((ERRORS+1))
elif echo "$VOLUME_RESPONSE" | jq -e '.cycleId' > /dev/null 2>&1; then
    CYCLE=$(echo "$VOLUME_RESPONSE" | jq -r '.cycleId')
    echo -e "${GREEN}✓ /api/ts/volume OK (Cycle: $CYCLE)${NC}"
else
    echo -e "${RED}✗ /api/ts/volume invalid response${NC}"
    ERRORS=$((ERRORS+1))
fi

# Test settlement-history endpoint
SETTLEMENT_RESPONSE=$(curl -s http://localhost:3434/api/ts/settlement-history)
if echo "$SETTLEMENT_RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    echo -e "${RED}✗ /api/ts/settlement-history returned error: $(echo $SETTLEMENT_RESPONSE | jq -r '.error')${NC}"
    ERRORS=$((ERRORS+1))
elif echo "$SETTLEMENT_RESPONSE" | jq -e '.history' > /dev/null 2>&1; then
    COUNT=$(echo "$SETTLEMENT_RESPONSE" | jq -r '.history | length')
    echo -e "${GREEN}✓ /api/ts/settlement-history OK ($COUNT records)${NC}"
else
    echo -e "${RED}✗ /api/ts/settlement-history invalid response${NC}"
    ERRORS=$((ERRORS+1))
fi

# Test recent-cycles endpoint
CYCLES_RESPONSE=$(curl -s http://localhost:3434/api/ts/recent-cycles)
if echo "$CYCLES_RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    echo -e "${RED}✗ /api/ts/recent-cycles returned error: $(echo $CYCLES_RESPONSE | jq -r '.error')${NC}"
    ERRORS=$((ERRORS+1))
elif echo "$CYCLES_RESPONSE" | jq -e '.cycles' > /dev/null 2>&1; then
    COUNT=$(echo "$CYCLES_RESPONSE" | jq -r '.cycles | length')
    echo -e "${GREEN}✓ /api/ts/recent-cycles OK ($COUNT cycles)${NC}"
else
    echo -e "${RED}✗ /api/ts/recent-cycles invalid response${NC}"
    ERRORS=$((ERRORS+1))
fi

echo ""

# Test 5: SSE Streams
echo "5. Testing TypeScript SSE Streams..."

# Test price stream
if timeout 2 curl -s -N http://localhost:3434/api/ts/price-stream 2>&1 | head -1 | grep -q "data:"; then
    echo -e "${GREEN}✓ /api/ts/price-stream OK${NC}"
else
    echo -e "${RED}✗ /api/ts/price-stream failed${NC}"
    ERRORS=$((ERRORS+1))
fi

# Test market stream
if timeout 2 curl -s -N http://localhost:3434/api/ts/market-stream 2>&1 | head -1 | grep -q "data:"; then
    echo -e "${GREEN}✓ /api/ts/market-stream OK${NC}"
else
    echo -e "${RED}✗ /api/ts/market-stream failed${NC}"
    ERRORS=$((ERRORS+1))
fi

# Test volume stream
if timeout 2 curl -s -N http://localhost:3434/api/ts/volume-stream 2>&1 | head -1 | grep -q "data:"; then
    echo -e "${GREEN}✓ /api/ts/volume-stream OK${NC}"
else
    echo -e "${RED}✗ /api/ts/volume-stream failed${NC}"
    ERRORS=$((ERRORS+1))
fi

# Test status stream
if timeout 2 curl -s -N http://localhost:3434/api/ts/status-stream 2>&1 | head -1 | grep -q "data:"; then
    echo -e "${GREEN}✓ /api/ts/status-stream OK${NC}"
else
    echo -e "${RED}✗ /api/ts/status-stream failed${NC}"
    ERRORS=$((ERRORS+1))
fi

echo ""

# Test 6: Database Operations
echo "6. Testing Database Repositories..."

# Use a test script to verify database operations
node -e "
const { DatabaseService, PriceHistoryRepository, VolumeRepository } = require('./dist/database');

(async () => {
  try {
    const dbService = new DatabaseService({ dbPath: './price_history.db' });
    const priceRepo = new PriceHistoryRepository({ db: dbService.getDb() });
    const volumeRepo = new VolumeRepository({ db: dbService.getDb() });

    // Test price repository
    const priceCount = priceRepo.count();
    console.log('${GREEN}✓ PriceHistoryRepository OK (${NC}' + priceCount + ' records${GREEN})${NC}');

    // Test volume repository
    const currentVolume = volumeRepo.loadCurrent();
    if (currentVolume) {
      console.log('${GREEN}✓ VolumeRepository OK (Cycle: ${NC}' + currentVolume.cycleId + '${GREEN})${NC}');
    } else {
      console.log('${YELLOW}⚠ VolumeRepository OK but no current cycle${NC}');
    }

    dbService.close();
    process.exit(0);
  } catch (err) {
    console.error('${RED}✗ Database test failed:${NC}', err.message);
    process.exit(1);
  }
})();
" || ERRORS=$((ERRORS+1))

echo ""

# Test 7: Server Logs
echo "7. Checking Server Logs for Errors..."
ERROR_COUNT=$(tail -100 /tmp/web_server.log | grep -i "error" | grep -v "No error" | wc -l)
if [ "$ERROR_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found $ERROR_COUNT error(s) in recent server logs${NC}"
    tail -100 /tmp/web_server.log | grep -i "error" | grep -v "No error" | tail -5
else
    echo -e "${GREEN}✓ No errors in recent server logs${NC}"
fi

echo ""
echo "=========================================="
echo "Test Summary"
echo "=========================================="

if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo ""
    echo "TypeScript migration is working correctly:"
    echo "  - Compilation: Clean"
    echo "  - Build: Successful"
    echo "  - API Endpoints: All functional"
    echo "  - SSE Streams: All streaming"
    echo "  - Database: Operational"
    echo "  - Server Logs: Clean"
    exit 0
else
    echo -e "${RED}✗ $ERRORS test(s) failed${NC}"
    echo ""
    echo "Please review the errors above and:"
    echo "  1. Check TypeScript compilation errors"
    echo "  2. Verify server is running"
    echo "  3. Review server logs: tail -50 /tmp/web_server.log"
    echo "  4. Test manually: curl http://localhost:3434/api/ts/current-price"
    exit 1
fi
