#!/bin/bash
# Start the keeper bot with logging to current directory

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="./keeper.log"

echo "🤖 Starting keeper bot..."
echo "📁 Working directory: $SCRIPT_DIR"
echo "📝 Log file: $LOG_FILE"

# Kill existing keeper processes
pkill -f "ts-node app/keeper.ts" 2>/dev/null

# Start keeper in background
npm exec ts-node app/keeper.ts > "$LOG_FILE" 2>&1 &
KEEPER_PID=$!

echo "✅ Keeper started with PID: $KEEPER_PID"
echo "📋 View logs: tail -f $LOG_FILE"
echo ""
echo "To stop: pkill -f 'ts-node app/keeper.ts'"
