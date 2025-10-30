# Force Settlement Guide

## Overview

If the automated settlement bot fails to settle a market or redeem positions, you can manually trigger settlement using the force settlement feature.

## When to Use Force Settlement

Use force settlement when:
- The settlement bot crashed or was interrupted during settlement
- Settlement failed due to network issues or RPC problems
- The market is stuck in "Stopped" state without being settled
- Positions were not redeemed after settlement
- You need to manually complete a settlement cycle

## Quick Start

### Option 1: Using the Shell Script (Recommended)

```bash
cd /home/ubuntu/dev/cpi_oracle
./force_settle.sh
```

This interactive script will:
1. Check the current market state
2. Settle the market if it's stopped but not settled
3. Redeem all winning positions
4. Show you the results

### Option 2: Using Node Directly

```bash
cd /home/ubuntu/dev/cpi_oracle
ANCHOR_WALLET=./operator.json node app/settlement_bot.js force-settle
```

## How It Works

The force settlement function:

1. **Checks Market State**
   - Reads the current market status (Open/Stopped/Settled)
   - Shows winner and market info

2. **Handles Different States**
   - If **Open**: Tells you to stop the market first
   - If **Stopped**: Settles the market via oracle
   - If **Settled**: Skips settlement, goes to redemption

3. **Redeems Positions**
   - Finds all positions with shares
   - Calls admin_redeem for each winning position
   - Transfers payouts to user vault PDAs
   - Records settlement history

4. **Safety Features**
   - Won't settle an open market (must be stopped first)
   - Won't fail if already settled
   - Shows detailed logs at each step
   - Exits with clear error messages if something fails

## Example Output

```
╔═══════════════════════════════════════════════╗
║        FORCE SETTLEMENT - MANUAL TRIGGER      ║
╚═══════════════════════════════════════════════╝

Current Market State:
  Status: Stopped
  Winner: Not set

🛑 Market is STOPPED but not settled. Settling now...

✓ Market settled successfully

Resolution: YES won
  Snapshot price: $115080.58
  Settle price: $115105.06

💰 Processing redemptions...

=== AUTO-REDEEMING ALL POSITIONS ===
[INFO] Settlement prices: Snapshot=$115080.58, Settle=$115105.06
[1/1] Redeeming for 3utn1NM4... (UP: 70.00, DOWN: 100.00)
  Expected payout: 70.0000 XNT
  ✓ Redeemed successfully

✓ Force settlement complete!
```

## Common Scenarios

### Scenario 1: Bot Crashed During Settlement
```bash
# Market is stopped but not settled
./force_settle.sh
# It will settle and redeem
```

### Scenario 2: Settlement Worked But Redemptions Failed
```bash
# Market is already settled but positions still have shares
./force_settle.sh
# It will skip settlement and go straight to redemptions
```

### Scenario 3: Market is Open and Needs Manual Stop
```bash
# First stop the market
ANCHOR_WALLET=./operator.json node app/trade.js stop

# Then force settle
./force_settle.sh
```

## Troubleshooting

### "Market not found"
- Market might have been closed already
- Check AMM PDA address matches your deployment

### "Settlement failed"
- Check oracle is accessible and has recent price data
- Verify you're using operator.json (fee_dest wallet)
- Check RPC connection

### "Redemption failed for user X"
- User vault PDA derivation might be failing
- Check that position accounts are valid
- Verify vault has sufficient SOL for payouts

## Safety Notes

- Only the operator wallet (fee_dest) can run force settlement
- Force settlement will NOT:
  - Stop an open market (you must stop it first)
  - Modify already-settled positions that were successfully redeemed
  - Create duplicate payouts (redeemed positions have shares set to 0)
- Force settlement WILL:
  - Record settlement history properly
  - Update vault balances in position accounts
  - Work even if some positions fail (continues with others)

## Next Steps After Force Settlement

After force settlement completes:

1. **Verify Results**: Check web UI for settlement history
2. **Start New Cycle**: The automated bot will handle the next cycle
3. **Monitor**: Watch logs to ensure next cycle works properly

If you're running the automated bot, it should continue normally after force settlement.
