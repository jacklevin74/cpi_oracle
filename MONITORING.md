# Settlement Bot Monitoring Guide

## Health Check Script

Run the health check script to verify the settlement bot is working correctly:

```bash
./check_settlement_bot.sh
```

### What it checks:
- ✓ Settlement bot process is running
- ✓ Process uptime
- ✓ Recent activity in logs
- ✓ Error count (should be 0)
- ✓ Recent settlement results (last 3)
- ✓ Current market state
- ✓ Time until next cycle
- ✓ Web server status (port 3434)
- ✓ Trade monitor status

## Automated Monitoring

### Option 1: Cron Job (Recommended)

Run the health check every 10 minutes and log results:

```bash
# Edit crontab
crontab -e

# Add this line:
*/10 * * * * cd /home/ubuntu/dev/cpi_oracle && ./check_settlement_bot.sh >> monitoring.log 2>&1
```

### Option 2: Manual Periodic Checks

Run the script manually whenever you want to check status:
```bash
cd /home/ubuntu/dev/cpi_oracle
./check_settlement_bot.sh
```

## What to Look For

### ✓ Healthy Signs:
- Process running with consistent uptime
- 0 errors in logs
- Regular settlements every 10 minutes (on :00, :10, :20, :30, :40, :50)
- Market state cycles through: WAITING → ACTIVE → SETTLED → WAITING
- Both YES and NO wins occurring (indicates accurate price tracking)

### ⚠️ Warning Signs:
- Process not running
- High error count
- No recent settlements (more than 15 minutes old)
- Web server or trade monitor not running
- Same winner repeatedly (may indicate oracle issues)

### 🚨 Critical Issues:
- Process crashed or not running
- Market stuck in one state for > 30 minutes
- Continuous errors in logs
- No settlements for > 1 hour

## Manual Intervention

### If settlement bot is not running:
```bash
cd /home/ubuntu/dev/cpi_oracle
node app/settlement_bot.js > settlement_bot.log 2>&1 &
```

### If web server is not running:
```bash
cd /home/ubuntu/dev/cpi_oracle/web
node server.js > server.log 2>&1 &
```

### If trade monitor is not running:
```bash
cd /home/ubuntu/dev/cpi_oracle/web
node trade_monitor.js > trade_monitor.log 2>&1 &
```

## Log Files

- `settlement_bot.log` - Settlement bot activity and errors
- `web/server.log` - Web server activity
- `web/trade_monitor.log` - Trade monitoring activity
- `monitoring.log` - Automated health check results (if using cron)

## Current Status (as of last check)

✓ Settlement bot: **RUNNING** (PID: 292075, Uptime: 5h 3m)
✓ Error count: **0**
✓ Recent settlements: **Working correctly** (every 10 minutes)
✓ Market state: **SETTLED** (next cycle in ~4 minutes)
✓ Web server: **RUNNING** (port 3434)
✓ Trade monitor: **RUNNING**

## Settlement Cycle Timeline

Each 10-minute cycle:
- **0:00** - Market starts, snapshot taken
- **0:00-5:00** - Active trading period
- **5:00** - Market stops, settlement begins
- **5:00** - Oracle price checked, winner determined
- **5:00** - All positions auto-redeemed
- **5:00-10:00** - Waiting period
- **10:00** - Next cycle starts

Markets start on minutes ending in 0: 19:00, 19:10, 19:20, 19:30, etc.
