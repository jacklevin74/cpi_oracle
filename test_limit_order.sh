#!/bin/bash
set -e

echo "=== Limit Order E2E Test ==="
echo ""

# Step 1: Close existing market
echo "Step 1: Closing existing market (if any)..."
ANCHOR_WALLET=./userA.json node app/trade.js close 2>&1 || true

# Step 2: Initialize new market
echo ""
echo "Step 2: Initializing market (b=500, fee=25bps)..."
ANCHOR_WALLET=./userA.json node app/trade.js init 500 25

# Step 3: Initialize position for userA
echo ""
echo "Step 3: Initializing position for userA..."
ANCHOR_WALLET=./userA.json node app/trade.js init-pos

# Step 4: Fund userA's position vault with 10 SOL
echo ""
echo "Step 4: Funding userA vault with 10 SOL..."
ANCHOR_WALLET=./userA.json node app/trade.js deposit 10

# Step 5: Submit a limit order
echo ""
echo "Step 5: Submitting limit order (BUY 5 YES @ $0.60)..."
ANCHOR_WALLET=./userA.json node app/submit-order.js \
  --action 1 \
  --side 1 \
  --shares 5 \
  --price 0.60 \
  --keeper-fee 50

# Step 6: Start keeper bot (in background, kill after 10 seconds)
echo ""
echo "Step 6: Starting keeper bot..."
timeout 10 npx ts-node app/keeper.ts || echo "Keeper stopped after 10s"

echo ""
echo "=== Test Complete ==="
