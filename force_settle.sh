#!/bin/bash
# Force settlement script - Use when automated settlement fails

cd "$(dirname "$0")"

echo "╔═══════════════════════════════════════════════╗"
echo "║        FORCE SETTLEMENT UTILITY               ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""
echo "This script will:"
echo "  1. Check market state"
echo "  2. Settle if stopped but not settled"
echo "  3. Redeem all winning positions"
echo ""
echo "Using operator wallet: ./operator.json"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""
ANCHOR_WALLET=./operator.json node app/settlement_bot.js force-settle

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ Settlement completed successfully!"
else
    echo ""
    echo "✗ Settlement failed. Check error messages above."
    exit 1
fi
