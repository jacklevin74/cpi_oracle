# Settlement Bot Fix - User Vault Redemption

## Problem Identified

The settlement bot was calling `admin_redeem` with the OLD account structure, missing the new `user_vault` PDA that was added to the Rust program.

### Before (Broken)
```javascript
keys: [
  ammPda,
  admin (operator),
  user (session wallet),
  position,
  fee_dest,
  vault_sol,
  system_program
]
// Missing: user_vault PDA!
```

**Result:** The Rust program expected 8 accounts but only got 7, causing the redemption to fail or pay to the wrong account.

### After (Fixed)
```javascript
keys: [
  ammPda,
  admin (operator),
  user (session wallet),
  position,
  fee_dest,
  vault_sol,
  user_vault,  // ← NEW! Derived from [b"user_vault", position_pda]
  system_program
]
```

**Result:** Payouts now go to the user's vault PDA, which can be withdrawn to Backpack at any time.

## Changes Made

### 1. Added PDA Seeds (settlement_bot.js:27-28)
```javascript
const USER_VAULT_SEED = Buffer.from("user_vault");
const POS_SEED = Buffer.from("pos");
```

### 2. Updated `autoRedeemAllPositions` Function (settlement_bot.js:460-509)

**Key improvements:**
- Derives `user_vault` PDA for each position: `[USER_VAULT_SEED, position.key()]`
- Passes `user_vault` as 7th account in the instruction
- Checks BOTH session wallet and user vault balances before/after
- Logs detailed balance changes for debugging
- Uses vault delta (not session delta) as the actual payout amount

### 3. Enhanced Logging

The bot now shows:
```
Redeeming for 3utn1N... (UP: 5.00, DOWN: 0.00)
  Expected payout: 5.2500 XNT (winningSide: YES, pps: 1.050000)
  Position PDA: Abc123...
  User (session wallet): 3utn1N...
  User Vault PDA: Def456...
  Balances BEFORE: session=0.0100 XNT, vault=0.0000 XNT
  Balances AFTER: session=0.0100 XNT, vault=5.2500 XNT
  ✓ Redeemed: 2abc3def...
    → Session wallet change: +0.0000 XNT
    → User vault change: +5.2500 XNT (THIS SHOULD BE THE PAYOUT!)
```

## Testing

To verify the fix works:

1. **Deploy the updated Rust program** (with user_vault in AdminRedeem context)
2. **Restart the settlement bot** with the updated code
3. **Place some trades** and wait for settlement
4. **Check the logs** - you should see:
   - User vault balance increasing (the payout)
   - Session wallet balance staying the same (just 0.01 XNT for fees)

## Next Steps

After the next settlement cycle, you can:
- **Check your user vault balance** in the web UI
- **Withdraw to Backpack** using the withdraw button
- **Trade with your winnings** without needing to deposit again

The payout will no longer be "lost" in the session wallet - it goes directly to your vault!
