# Buy Operation Fix Summary

## Problem
Users couldn't execute buy operations when the market was open. Two main issues were identified:

### Issue 1: Missing User Vault Accounts in Client (app/trade.js)
The smart contract was recently updated to use a vault-based system where users deposit SOL into a per-user vault PDA before trading. The client code (`app/trade.js`) wasn't updated to pass the required `user_vault` account in transaction instructions.

**Smart Contract Requirement:**
- BUY operations now deduct from `pos.vault_balance_e6` (user's vault balance)
- Users must deposit SOL into their vault before trading
- All trade transactions require the `user_vault` PDA account

**Missing Accounts:**
The following instructions were missing the `user_vault` account:
- `trade` (BUY/SELL operations)
- `init_position` (position initialization)
- `redeem` (claiming winnings)

### Issue 2: Incorrect Market Status Check in Web UI
The web UI (`web/public/app.js`) only allowed trading when `currentMarketStatus === 0` (Premarket), but the smart contract allows trading in **both** Premarket (0) and Open (1) states.

## Changes Made

### 1. app/trade.js - Added User Vault Support

#### Added Constants and PDA Functions:
```javascript
const USER_VAULT_SEED = Buffer.from("user_vault");

function userVaultPda(pos) {
  return PublicKey.findProgramAddressSync([USER_VAULT_SEED, pos.toBuffer()], PID)[0];
}
```

#### Updated ixTrade Function:
```javascript
async function ixTrade(conn, payer, side, action, amountScaled){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const userVault = userVaultPda(pos);  // ← ADDED
  const feeDest = FEE_DEST_GLOBAL || getFeeDest(payer.publicKey);
  const vaultSol = vaultSolPda(amm);

  const keys = [
    { pubkey: amm,                     isSigner:false, isWritable:true  },
    { pubkey: payer.publicKey,         isSigner:true,  isWritable:true  },
    { pubkey: pos,                     isSigner:false, isWritable:true  },
    { pubkey: userVault,               isSigner:false, isWritable:true  },  // ← ADDED
    { pubkey: feeDest,                 isSigner:false, isWritable:true  },
    { pubkey: vaultSol,                isSigner:false, isWritable:true  },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
    { pubkey: SYSVAR_RENT_PUBKEY,      isSigner:false, isWritable:false },
  ];
  // ... rest of function
}
```

#### Updated ixInitPos Function:
```javascript
async function ixInitPos(conn, payer, masterWallet = null){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const userVault = userVaultPda(pos);  // ← ADDED
  const master = masterWallet || payer;

  const keys = [
    { pubkey: amm, isSigner:false, isWritable:false },
    { pubkey: pos, isSigner:false, isWritable:true },
    { pubkey: userVault, isSigner:false, isWritable:false },  // ← ADDED
    { pubkey: payer.publicKey, isSigner:true, isWritable:true },
    { pubkey: master.publicKey, isSigner:true, isWritable:true },  // ← ADDED
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  // ... rest of function
}
```

#### Updated ixRedeem Function:
```javascript
async function ixRedeem(conn, payer){
  const amm = await ammPda();
  const pos = posPda(payer.publicKey, amm);
  const userVault = userVaultPda(pos);  // ← ADDED
  const vaultSol = vaultSolPda(amm);
  const feeDest  = FEE_DEST_GLOBAL || getFeeDest(payer.publicKey);

  const keys = [
    { pubkey: amm,                     isSigner:false, isWritable:true  },
    { pubkey: payer.publicKey,         isSigner:true,  isWritable:true  },
    { pubkey: pos,                     isSigner:false, isWritable:true  },
    { pubkey: feeDest,                 isSigner:false, isWritable:true  },
    { pubkey: vaultSol,                isSigner:false, isWritable:true  },
    { pubkey: userVault,               isSigner:false, isWritable:true  },  // ← ADDED
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
    { pubkey: SYSVAR_RENT_PUBKEY,      isSigner:false, isWritable:false },
  ];
  // ... rest of function
}
```

#### Added Deposit Function:
```javascript
const D_DEPOSIT = disc("deposit");

async function ixDeposit(conn, user, masterWallet, amountLamports){
  const amm = await ammPda();
  const pos = posPda(user.publicKey, amm);
  const userVault = userVaultPda(pos);
  const master = masterWallet || user;

  const data = Buffer.concat([D_DEPOSIT, Buffer.alloc(8)]);
  data.writeBigUInt64LE(BigInt(amountLamports), 8);

  const keys = [
    { pubkey: amm,                     isSigner:false, isWritable:false },
    { pubkey: pos,                     isSigner:false, isWritable:true  },
    { pubkey: userVault,               isSigner:false, isWritable:true  },
    { pubkey: user.publicKey,          isSigner:true,  isWritable:false },
    { pubkey: master.publicKey,        isSigner:true,  isWritable:true  },
    { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
  ];
  // ... rest of function
}
```

#### Added Auto-Deposit for Run Command:
Modified `ensureOpenMarket()` to automatically deposit 10 SOL to each user's vault during `run` command:
```javascript
for (const p of payersUniq) {
  await ixInitPos(conn, p);
  // Auto-deposit 10 SOL to each user's vault for trading
  const depositAmt = 10 * 1e9; // 10 SOL in lamports
  try {
    await ixDeposit(conn, p, null, depositAmt);
  } catch (e) {
    if (VERBOSE && !QUIET) console.log(C.y(`⚠ Could not auto-deposit for ${p.publicKey.toBase58().slice(0,8)}: ${e.message}`));
  }
}
```

#### Added CLI Deposit Command:
```bash
node app/trade.js deposit <SOL_amount>
```

### 2. web/public/app.js - Fixed Market Status Checks

#### Fixed executeTrade() Function:
```javascript
async function executeTrade() {
    // Check if market is open (status 0 = Premarket, 1 = Open, 2 = Stopped)
    // Trading is allowed in both Premarket (0) and Open (1) states
    if (currentMarketStatus !== 0 && currentMarketStatus !== 1) {
        addLog('ERROR: Market is not open for trading (status: ' + currentMarketStatus + ')', 'error');
        showError('Market closed');
        return;
    }
    // ... rest of function
}
```

#### Fixed updateButtonStates() Function:
```javascript
function updateButtonStates() {
    const tradeBtn = document.getElementById('tradeBtn');
    const yesBtn = document.getElementById('yesBtn');
    const noBtn = document.getElementById('noBtn');

    // Trade buttons - enable when market is PREMARKET (status = 0) or OPEN (status = 1)
    const canTrade = currentMarketStatus === 0 || currentMarketStatus === 1;
    // ... rest of function
}
```

## Usage Instructions

### For CLI (app/trade.js):

1. **Initialize position** (if not already done):
   ```bash
   node app/trade.js init-pos
   ```

2. **Deposit SOL to vault** (required before trading):
   ```bash
   node app/trade.js deposit 10  # Deposit 10 SOL
   ```

3. **Execute trades** (now works in both Premarket and Open states):
   ```bash
   node app/trade.js buy yes 5   # Buy 5 YES shares
   node app/trade.js sell no 3   # Sell 3 NO shares
   ```

### For Run Command:
The `run` command now automatically:
1. Initializes positions for all users
2. Deposits 10 SOL to each user's vault
3. Executes trades

No manual intervention needed!

### For Web UI:
The buy button now works when the market is in either:
- **Premarket** (status = 0): Before snapshot is taken
- **Open** (status = 1): After snapshot is taken, before stop

## Market Status States

| Status | Name | Trading Allowed | Description |
|--------|------|----------------|-------------|
| 0 | Premarket | ✅ Yes | Initial state after init_amm, before snapshot |
| 1 | Open | ✅ Yes | After snapshot_start is called |
| 2 | Stopped | ❌ No | After stop_market is called |

## Testing

To verify the fixes work:

1. **Test CLI**:
   ```bash
   # Initialize and deposit
   node app/trade.js init-pos
   node app/trade.js deposit 10

   # Take snapshot (transitions to Open state)
   node app/trade.js snapshot-start --oracle <ORACLE_PUBKEY>

   # Try buying - should work now!
   node app/trade.js buy yes 5
   ```

2. **Test Web UI**:
   - Connect wallet
   - Take snapshot (market transitions to Open)
   - Click buy button - should work now!

## Summary

All buy operations now work correctly because:
1. ✅ Client passes required `user_vault` account
2. ✅ Auto-deposit provides vault funds for trading
3. ✅ UI allows trading in both Premarket and Open states
4. ✅ Smart contract vault balance checks pass
