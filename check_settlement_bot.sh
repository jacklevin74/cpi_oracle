#!/bin/bash
# Health check script for settlement bot
# Run this periodically to verify the bot is working correctly

echo "=========================================="
echo "Settlement Bot Health Check"
echo "Time: $(date)"
echo "=========================================="
echo ""

# Check if process is running
if pgrep -f "settlement_bot.js" > /dev/null; then
    echo "✓ Process: RUNNING (PID: $(pgrep -f 'settlement_bot.js'))"

    # Get process uptime
    PID=$(pgrep -f "settlement_bot.js")
    UPTIME=$(ps -p $PID -o etime= | tr -d ' ')
    echo "  Uptime: $UPTIME"
else
    echo "✗ Process: NOT RUNNING"
    echo "  ACTION REQUIRED: Start the bot with: node app/settlement_bot.js"
    exit 1
fi

echo ""

# Check recent activity in logs
echo "Recent Activity:"
if [ -f "settlement_bot.log" ]; then
    LAST_LINE=$(tail -1 settlement_bot.log)
    echo "  Last log: $LAST_LINE"

    # Check for recent errors
    ERROR_COUNT=$(grep -c "ERROR\|Failed" settlement_bot.log 2>/dev/null || echo 0)
    echo "  Total errors in log: $ERROR_COUNT"

    # Check recent settlements
    RECENT_SETTLEMENTS=$(grep "Resolution:" settlement_bot.log | tail -3)
    if [ ! -z "$RECENT_SETTLEMENTS" ]; then
        echo ""
        echo "Recent Settlements (last 3):"
        echo "$RECENT_SETTLEMENTS" | while read line; do
            echo "  $line"
        done
    fi
else
    echo "  ✗ Log file not found"
fi

echo ""

# Check market status
if [ -f "market_status.json" ]; then
    STATE=$(node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('market_status.json')); console.log(s.state)")
    echo "Market Status:"
    echo "  State: $STATE"

    # Calculate time until next cycle
    NEXT_CYCLE=$(node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('market_status.json')); const diff=(s.nextCycleStartTime-Date.now())/1000; console.log(Math.floor(diff/60)+'m '+Math.floor(diff%60)+'s')")
    echo "  Next cycle in: $NEXT_CYCLE"
else
    echo "  ✗ market_status.json not found"
fi

echo ""

# Check web server
if lsof -ti:3434 > /dev/null 2>&1; then
    echo "✓ Web server: RUNNING on port 3434"
else
    echo "✗ Web server: NOT RUNNING"
    echo "  WARNING: Settlement history won't be recorded"
fi

echo ""

# Check trade monitor
if pgrep -f "trade_monitor.js" > /dev/null; then
    echo "✓ Trade monitor: RUNNING"
else
    echo "✗ Trade monitor: NOT RUNNING"
    echo "  WARNING: Live trades won't be tracked"
fi

echo ""

# Check recent errors
RECENT_ERRORS=$(grep -E "ERROR|Failed" settlement_bot.log 2>/dev/null | tail -5)
if [ ! -z "$RECENT_ERRORS" ]; then
    echo "⚠️  Recent Errors (last 5):"
    echo "$RECENT_ERRORS" | while read line; do
        echo "  $line"
    done
    echo ""
fi

echo "=========================================="
echo "Health Check Complete"
echo "=========================================="
