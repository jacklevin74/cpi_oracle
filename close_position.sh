#!/bin/bash
# Close old position account to get a fresh one

echo "This will close your old position account so you can create a fresh one with vault support."
echo ""
read -p "Press Enter to continue..."

# Use the operator wallet
export ANCHOR_WALLET=./operator.json

# Wipe the position (sets shares to 0)
echo "Wiping position shares..."
node app/trade.js wipe-pos

echo ""
echo "Done! Now disconnect and reconnect your wallet in the UI to create a fresh position."
