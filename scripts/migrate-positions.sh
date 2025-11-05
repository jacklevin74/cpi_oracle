#!/bin/bash
# scripts/migrate-positions.sh - Migrate old position accounts to new layout

set -e

RPC="${ANCHOR_PROVIDER_URL:-https://rpc.testnet.x1.xyz}"
PROGRAM_ID="EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF"

echo "🔧 Position Account Migration Tool"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "This tool migrates position accounts from old layout (97 bytes)"
echo "to new layout (901 bytes) by:"
echo "  1. Force-closing old position account (requires upgrade authority)"
echo "  2. Reinitializing new position account"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ $# -lt 1 ]; then
    echo "Usage: $0 <user_wallet.json> [recipient_wallet]"
    echo ""
    echo "Arguments:"
    echo "  user_wallet.json  - The wallet whose position needs migration"
    echo "  recipient_wallet  - (Optional) Where to send reclaimed rent"
    echo "                      Defaults to user_wallet"
    echo ""
    echo "Example:"
    echo "  $0 ./userA.json"
    echo "  $0 ./userB.json ~/.config/solana/id.json"
    echo ""
    exit 1
fi

USER_WALLET="$1"
RECIPIENT="${2:-$USER_WALLET}"

# Calculate position PDA
USER_PUBKEY=$(solana-keygen pubkey "$USER_WALLET")
AMM_PDA=$(node -e "
const { PublicKey } = require('@solana/web3.js');
const pid = new PublicKey('$PROGRAM_ID');
const [pda] = PublicKey.findProgramAddressSync([Buffer.from('amm_btc_v6')], pid);
console.log(pda.toString());
")

POSITION_PDA=$(node -e "
const { PublicKey } = require('@solana/web3.js');
const pid = new PublicKey('$PROGRAM_ID');
const amm = new PublicKey('$AMM_PDA');
const user = new PublicKey('$USER_PUBKEY');
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from('pos'), amm.toBuffer(), user.toBuffer()],
  pid
);
console.log(pda.toString());
")

echo "User:     $USER_PUBKEY"
echo "AMM:      $AMM_PDA"
echo "Position: $POSITION_PDA"
echo ""

# Check if position exists
ANCHOR_PROVIDER_URL="$RPC" solana account "$POSITION_PDA" &>/dev/null || {
    echo "✅ Position account does not exist. No migration needed."
    echo "   You can initialize a new position with:"
    echo "   ANCHOR_WALLET=$USER_WALLET node app/trade.js init-pos"
    exit 0
}

# Get position size
POSITION_SIZE=$(ANCHOR_PROVIDER_URL="$RPC" solana account "$POSITION_PDA" | grep "Length:" | awk '{print $2}')

echo "📊 Current position size: $POSITION_SIZE bytes"

if [ "$POSITION_SIZE" = "901" ]; then
    echo "✅ Position is already using new layout. No migration needed!"
    exit 0
fi

if [ "$POSITION_SIZE" != "97" ]; then
    echo "⚠️  Warning: Unexpected position size (expected 97 or 901 bytes)"
fi

echo ""
echo "⚠️  WARNING: This operation requires program upgrade authority!"
echo "⚠️  Any shares in this position will be LOST!"
echo ""
echo "Press Ctrl+C to cancel, or Enter to continue..."
read

echo ""
echo "📤 Step 1: Force-closing old position account..."
echo "   (This requires program upgrade authority)"
echo ""

# Try to close using program upgrade authority
# Note: This might fail if you don't have upgrade authority
set +e
ANCHOR_PROVIDER_URL="$RPC" solana program close "$POSITION_PDA" --recipient "$RECIPIENT" --bypass-warning 2>&1 | tee /tmp/close-output.txt
CLOSE_RESULT=$?
set -e

if [ $CLOSE_RESULT -ne 0 ]; then
    echo ""
    echo "❌ Failed to close account. This might be because:"
    echo "   1. You don't have program upgrade authority"
    echo "   2. The account is owned by the program and cannot be closed this way"
    echo ""
    echo "Alternative solution:"
    echo "   You need to add a migration instruction to the program that:"
    echo "   - Can deserialize the old 97-byte layout"
    echo "   - Closes the old account"
    echo "   - Then users can re-initialize with new layout"
    exit 1
fi

echo ""
echo "✅ Old position account closed successfully!"
echo ""
echo "📥 Step 2: Initializing new position with updated layout..."
ANCHOR_WALLET="$USER_WALLET" ANCHOR_PROVIDER_URL="$RPC" node app/trade.js init-pos

echo ""
echo "✅ Migration complete!"
echo "   Position PDA: $POSITION_PDA"
echo "   New size: 901 bytes"
