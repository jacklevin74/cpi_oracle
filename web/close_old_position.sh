#!/bin/bash
# Close old Position account and recover rent

echo "🔄 Position Account Migration Helper"
echo ""
echo "This script will help you close your old position account."
echo ""

# Get session wallet address from browser
echo "📋 Step 1: Get your session wallet address"
echo "  1. Open Browser DevTools (F12)"
echo "  2. Go to Console tab"
echo "  3. Run: sessionStorage.getItem('session_wallet_address')"
echo "  4. Copy the address"
echo ""
read -p "Paste your session wallet address here: " SESSION_WALLET

if [ -z "$SESSION_WALLET" ]; then
    echo "❌ No address provided. Exiting."
    exit 1
fi

echo ""
echo "Session wallet: $SESSION_WALLET"
echo ""

# Calculate Position PDA
echo "🔍 Step 2: Finding your position account..."
echo ""

# We need to calculate the PDA
# For now, let's use the Solana CLI to find accounts

echo "Searching for position accounts owned by program..."
solana program show EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF --accounts --output json 2>/dev/null | head -50

echo ""
echo "⚠️  Manual steps required:"
echo ""
echo "To close your old position, you need to:"
echo "1. Use 'wipe_position' instruction in the program (if available)"
echo "2. Or disconnect wallet and let the new connection create a fresh position"
echo ""
echo "Recommended: Just disconnect and reconnect wallet in the UI"
echo "This will automatically create a new position with master_wallet field."
