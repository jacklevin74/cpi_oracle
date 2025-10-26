# Automatic Session Wallet Switching

## Overview

The trading interface now **automatically switches session wallets** when you switch between different Backpack accounts. This is done **securely** using the same deterministic derivation method.

## How It Works

### Security Model

1. **Deterministic Derivation**: Each Backpack wallet has its own unique session wallet
   - Same Backpack wallet → Same signature → Same session wallet (always)
   - Different Backpack wallet → Different signature → Different session wallet

2. **Account Change Detection**:
   - Listens to Backpack's `accountChanged` event
   - Fires when you switch wallets in Backpack extension
   - Only processes changes when already connected

3. **Automatic Re-derivation**:
   - Requests new signature from new Backpack account
   - Derives deterministic session wallet from new signature
   - Updates UI with new session wallet and balance

### User Flow

```
1. Connect Backpack Wallet A
   ↓
2. Sign message to derive Session Wallet A
   ↓
3. Trade with Session Wallet A
   ↓
4. Switch to Backpack Wallet B in extension
   ↓
5. [AUTOMATIC] Request signature from Wallet B
   ↓
6. [AUTOMATIC] Derive Session Wallet B
   ↓
7. [AUTOMATIC] Update UI with Session Wallet B
   ↓
8. Trade with Session Wallet B
```

## What Happens When You Switch

### Console Output:
```
[Account Switch] Backpack account changed to: 5Xj2...
Backpack wallet switched to: 5Xj2...
Re-deriving session wallet for new Backpack account...
[Account Switch] Deriving new session wallet...
[DEBUG derive] Requesting signature from Backpack...
[DEBUG derive] Got signature, length: undefined
[DEBUG derive] Signature constructor: Object
[DEBUG derive] Signature bytes length: 64
[DEBUG derive] Keypair created
[DEBUG derive] Keypair publicKey: 8Ab4...
[Account Switch] New session wallet: 8Ab4...
Switched to session wallet: 8Ab4...
```

### UI Updates:
- **Top nav**: Shows new session wallet address (shortened)
- **Left sidebar**: Shows full new session wallet address
- **Balance**: Updates to show new session wallet balance
- **Position**: Fetches position for new session wallet
- **Status bar**: Shows "Switched! Session wallet: 8Ab4..."

### Log Messages:
- `Backpack wallet switched to: 5Xj2...` - New Backpack account detected
- `Re-deriving session wallet for new Backpack account...` - Starting derivation
- `Switched to session wallet: 8Ab4...` - Switch complete
- `This is the deterministic session wallet for your new Backpack account` - Confirmation

## Security Guarantees

✅ **Each Backpack wallet has a unique session wallet**
- Wallet A session ≠ Wallet B session

✅ **Session wallets are deterministic**
- Switch back to Wallet A → Get same Session A

✅ **No cross-contamination**
- Positions for Wallet A session remain separate
- Balances for Wallet B session are independent

✅ **User must approve signature each time**
- Cannot derive session wallet without user consent
- Signature request popup appears for each switch

## Edge Cases Handled

### 1. Switch Before Connect
- **Trigger**: Account changed event fires before user clicks Connect
- **Behavior**: Ignored, no action taken
- **Console**: `[Account Switch] Not connected yet, ignoring account change`

### 2. Backpack Disconnected
- **Trigger**: User disconnects Backpack or publicKey is null
- **Behavior**: Clean disconnect, UI resets to "Connect wallet" state
- **Console**: `Backpack disconnected`

### 3. User Denies Signature
- **Trigger**: User clicks "Deny" on signature request popup
- **Behavior**: Disconnects wallet, shows error
- **Console**: `Failed to switch session wallet: User denied signature request`
- **UI**: Shows error "Failed to derive session wallet for new account"

### 4. Signature Format Error
- **Trigger**: Backpack returns unexpected signature format
- **Behavior**: Graceful error handling, disconnects wallet
- **Console**: `[DEBUG derive] Unexpected signature format`

## Testing

### Manual Test Steps:

1. **Connect with Wallet A**
   ```
   - Click "Connect"
   - Approve connection
   - Sign message
   - Note session wallet address (e.g., 2Ab3...)
   ```

2. **Make a trade or deposit**
   ```
   - Fund session wallet
   - Check balance shows up
   ```

3. **Switch to Wallet B in Backpack**
   ```
   - Open Backpack extension
   - Click wallet dropdown
   - Select different wallet
   ```

4. **Verify Automatic Switch**
   ```
   - Signature popup should appear automatically
   - Sign the message
   - New session wallet should appear (e.g., 7Cd8...)
   - Balance should update to new session wallet balance
   - Old session wallet (2Ab3...) is no longer active
   ```

5. **Switch Back to Wallet A**
   ```
   - Open Backpack extension
   - Select original wallet
   - Sign message again
   - Original session wallet (2Ab3...) should reappear
   - Original balance and positions restored
   ```

### Expected Results:

✅ Each Backpack wallet has its own unique session wallet
✅ Switching is seamless and automatic
✅ User only needs to sign the message
✅ Balances and positions are wallet-specific
✅ Same Backpack wallet always gives same session wallet

## Technical Implementation

### Event Listener Setup
```javascript
function setupBackpackAccountListener() {
    window.backpack.on('accountChanged', async (publicKey) => {
        // Handle account change
    });
}
```

### Called on Page Load
- Listener is set up when page loads
- Waits for Backpack to be available
- Remains active throughout session

### Security Checks
1. Check if `publicKey` is null (disconnection)
2. Check if `backpackWallet` exists (already connected)
3. Request signature (requires user approval)
4. Derive new session wallet
5. Update all UI elements

## Troubleshooting

### Issue: Signature popup doesn't appear when switching
**Cause**: Event listener not set up
**Solution**: Refresh page, Backpack should be detected on load

### Issue: Same session wallet appears for different Backpack wallets
**Cause**: Signature might be cached (shouldn't happen with Ed25519)
**Solution**: Check console logs, verify different signatures

### Issue: Error "Failed to derive session wallet"
**Cause**: User denied signature or Backpack error
**Solution**: Try switching wallets again, approve signature

### Issue: Old balance shows after switch
**Cause**: Balance update might be delayed
**Solution**: Wait 1-2 seconds, balance polls every second

## Developer Notes

- Event listener uses `window.backpack.on('accountChanged', ...)`
- Compatible with Backpack Wallet API v1
- No polling needed, event-driven architecture
- Graceful degradation if Backpack not available
- All logging prefixed with `[Account Switch]` for easy debugging
