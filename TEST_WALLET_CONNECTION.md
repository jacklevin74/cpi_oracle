# Wallet Connection Test Guide

## Test the Session Wallet Display Issue

### Steps to Test:

1. **Open the trading interface**
   - Navigate to: http://localhost:3434/proto1
   - Open browser DevTools (F12 or right-click → Inspect)
   - Go to the **Console** tab

2. **Click "Connect" button**
   - The Backpack wallet popup should appear
   - Click "Connect" to approve

3. **Sign the message**
   - A signature request popup should appear
   - The message is: "x1-markets-deterministic-session-wallet-v1"
   - Click "Sign" or "Approve"

4. **Check the Console for Debug Output**
   Look for these debug messages in order:

```
[DEBUG] About to derive session wallet...
[DEBUG derive] Requesting signature from Backpack...
[DEBUG derive] Got signature, length: 64
[DEBUG derive] Signature type: object
[DEBUG derive] First 8 bytes: [...]
[DEBUG derive] Seed created, length: 32
[DEBUG derive] Keypair created
[DEBUG derive] Keypair publicKey: <PUBKEY_HERE>
[DEBUG derive] Keypair type: object
[DEBUG derive] Keypair is null? false
[DEBUG derive] Returning keypair...
[DEBUG] Wallet object: Keypair {...}
[DEBUG] Wallet is null? false
[DEBUG] Wallet publicKey: PublicKey {...}
[DEBUG] Session address: <FULL_ADDRESS>
[DEBUG] About to call showHasWallet...
[DEBUG showHasWallet] Called with backpackAddr: <BACKPACK_ADDR>
[DEBUG showHasWallet] wallet object: Keypair {...}
[DEBUG showHasWallet] sessionAddr: <SESSION_ADDR>
[DEBUG showHasWallet] shortAddr: <SHORT_ADDR>
[DEBUG showHasWallet] navWalletAddr element: <div>
[DEBUG showHasWallet] Nav bar updated
[DEBUG showHasWallet] sessionAddr element: <div>
[DEBUG showHasWallet] Sidebar updated, text content: <SESSION_ADDR>
[DEBUG showHasWallet] Position status updated
[DEBUG showHasWallet] Function completed
[DEBUG] showHasWallet completed
```

5. **Check the UI Elements**
   - **Top navigation bar**: Should show shortened session wallet (e.g., "2Xj5K8Yz...a3Bc")
   - **Left sidebar "Trading Wallet" section**: Should show FULL session wallet address
   - **Logs section**: Should show "Session wallet: 2Xj5K8Yz..."

### What Could Go Wrong:

#### Issue 1: Signature is rejected
- **Symptom**: Error message "User denied signature request"
- **Fix**: Click "Approve" on the signature popup

#### Issue 2: Keypair is null after creation
- **Symptom**: `[DEBUG] Wallet is null? true`
- **Likely cause**: `Keypair.fromSeed()` failed
- **Check**: Seed length should be exactly 32 bytes

#### Issue 3: Session address not showing in UI
- **Symptom**: Debug shows wallet created but UI still shows "--" or "Connect wallet..."
- **Likely causes**:
  - `sessionAddr` element not found (check: `[DEBUG showHasWallet] sessionAddr element: null`)
  - Element found but not visible (check CSS `.hidden` class)
  - Element text not updated (check: `[DEBUG showHasWallet] Sidebar updated, text content:`)

#### Issue 4: showHasWallet called with null wallet
- **Symptom**: `showHasWallet called but wallet is null`
- **Likely cause**: Order of operations error - showHasWallet called before wallet assignment

### Alternative Simple Test:

Visit the test page for isolated testing:
- http://localhost:3434/test_wallet.html
- This is a minimal test with just the wallet derivation logic

## After Testing:

Please copy and paste the **entire console output** so I can diagnose the exact issue.

Look for:
1. Any error messages in red
2. Which debug statement is the last one that succeeds
3. The actual values being logged (especially `wallet is null?` and `sessionAddr element:`)
