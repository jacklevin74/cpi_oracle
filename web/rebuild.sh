#!/bin/bash
# Rebuild TypeScript and restart server
# Run from: /home/ubuntu/dev/cpi_oracle/web

echo "🔨 Building TypeScript..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed!"
    exit 1
fi

echo "🛑 Stopping old server..."
lsof -ti :3434 | xargs kill -9 2>/dev/null
sleep 2

echo "🚀 Starting new server..."
node server.js > /tmp/web_server.log 2>&1 &
sleep 3

echo "📋 Server logs:"
tail -20 /tmp/web_server.log

echo ""
echo "✅ Done! Server running on http://localhost:3434"
echo "📊 Check logs: tail -f /tmp/web_server.log"
