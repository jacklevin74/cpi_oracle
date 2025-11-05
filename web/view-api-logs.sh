#!/bin/bash

# API Request Logger - Shows which APIs are accessed and which services they use
# Usage: ./view-api-logs.sh [options]

LOG_FILE="/tmp/web_server.log"

show_help() {
    echo "============================================================================"
    echo "                      API Request Log Viewer"
    echo "============================================================================"
    echo ""
    echo "Usage: $0 [option]"
    echo ""
    echo "Options:"
    echo "  (none)      - Show last 50 API requests with full details"
    echo "  live        - Follow log in real-time"
    echo "  typescript  - Show only TypeScript service calls"
    echo "  javascript  - Show only Original JavaScript calls"
    echo "  summary     - Show count of each service type"
    echo "  stats       - Show API usage statistics"
    echo "  clear       - Clear the log file"
    echo "  help        - Show this help"
    echo ""
    echo "Examples:"
    echo "  $0              # View recent requests"
    echo "  $0 live         # Watch real-time"
    echo "  $0 typescript   # Filter TypeScript only"
    echo ""
    echo "============================================================================"
}

case "$1" in
    "live")
        echo "📡 Following API requests in real-time..."
        echo "   Press Ctrl+C to stop"
        echo ""
        tail -f "$LOG_FILE" | grep --line-buffered -E "REQUEST:|SERVICE:|✅|📊|📦|🔷"
        ;;

    "typescript")
        echo "============================================================================"
        echo "                  TypeScript Service Calls"
        echo "============================================================================"
        echo ""
        grep -E "🔷.*TypeScript|TypeScript services returned" "$LOG_FILE" | tail -50
        ;;

    "javascript")
        echo "============================================================================"
        echo "                Original JavaScript Service Calls"
        echo "============================================================================"
        echo ""
        grep -E "📦.*Original JavaScript" "$LOG_FILE" | tail -50
        ;;

    "summary")
        echo "============================================================================"
        echo "                      Service Usage Summary"
        echo "============================================================================"
        echo ""

        TS_COUNT=$(grep -c "🔷.*TypeScript" "$LOG_FILE" 2>/dev/null || echo "0")
        JS_COUNT=$(grep -c "📦.*Original JavaScript" "$LOG_FILE" 2>/dev/null || echo "0")
        TOTAL=$((TS_COUNT + JS_COUNT))

        echo "TypeScript Services:       $TS_COUNT calls"
        echo "Original JavaScript:       $JS_COUNT calls"
        echo "                          --------"
        echo "Total API Calls:           $TOTAL"
        echo ""

        if [ $TOTAL -gt 0 ]; then
            TS_PERCENT=$(echo "scale=1; $TS_COUNT * 100 / $TOTAL" | bc)
            JS_PERCENT=$(echo "scale=1; $JS_COUNT * 100 / $TOTAL" | bc)
            echo "TypeScript:    ${TS_PERCENT}%"
            echo "JavaScript:    ${JS_PERCENT}%"
        fi
        echo ""
        ;;

    "stats")
        echo "============================================================================"
        echo "                      API Usage Statistics"
        echo "============================================================================"
        echo ""

        echo "Top API Endpoints:"
        grep "📥 REQUEST" "$LOG_FILE" | awk '{print $NF}' | sort | uniq -c | sort -rn | head -10

        echo ""
        echo "Service Type Breakdown:"
        echo "  TypeScript:  $(grep -c "🔷.*TypeScript" "$LOG_FILE" 2>/dev/null || echo "0") calls"
        echo "  JavaScript:  $(grep -c "📦.*Original JavaScript" "$LOG_FILE" 2>/dev/null || echo "0") calls"

        echo ""
        echo "Recent Activity (last 10 minutes):"
        RECENT_TIME=$(date -d '10 minutes ago' '+%Y-%m-%dT%H:%M' 2>/dev/null || date -v-10M '+%Y-%m-%dT%H:%M')
        grep "📥 REQUEST" "$LOG_FILE" | grep -E "$RECENT_TIME|$(date '+%Y-%m-%dT%H:%M')" | wc -l | xargs echo "  Requests:"
        ;;

    "clear")
        read -p "⚠️  Clear log file? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            > "$LOG_FILE"
            echo "✅ Log file cleared"
        else
            echo "Cancelled"
        fi
        ;;

    "help"|"-h"|"--help")
        show_help
        ;;

    *)
        echo "============================================================================"
        echo "                  Recent API Requests (Last 50)"
        echo "============================================================================"
        echo ""
        echo "Legend:"
        echo "  📥 REQUEST    - Incoming API request"
        echo "  🔷 TypeScript - Using compiled TypeScript services"
        echo "  📦 JavaScript - Using original JavaScript functions"
        echo "  ✅ Success    - Request completed successfully"
        echo ""
        echo "----------------------------------------------------------------------------"
        grep -E "📥 REQUEST|🔷 SERVICE|📦 SERVICE|✅" "$LOG_FILE" | tail -100 | sed 's/\[20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9]*Z\]//' | tail -50
        echo ""
        echo "----------------------------------------------------------------------------"
        echo "💡 Tips:"
        echo "   - Use './view-api-logs.sh live' to watch in real-time"
        echo "   - Use './view-api-logs.sh summary' for statistics"
        echo "   - Use './view-api-logs.sh typescript' to see only TS calls"
        echo "============================================================================"
        ;;
esac
