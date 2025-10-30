# Smart Withdraw/Deposit MAX Button Implementation

## Overview
Enhanced the deposit modal to make the MAX button intelligently set the maximum amount based on whether the user wants to deposit or withdraw.

## Changes Made

### 1. HTML (hyperliquid.html)

**Updated button onclick:**
- Changed `setMaxDeposit()` → `setMaxAmount()` (smart function)
- Added IDs to deposit and withdraw buttons for tracking

```html
<button class="btn-max-deposit" onclick="setMaxAmount()">MAX</button>
<button class="btn-primary" id="depositBtn" onclick="executeDeposit()">Deposit</button>
<button class="btn-withdraw" id="withdrawBtn" onclick="executeWithdraw()">Withdraw</button>
```

### 2. JavaScript (app.js)

#### Added Smart MAX Logic:

```javascript
// Track which action user wants to perform
let lastFocusedAction = 'deposit'; // default

async function setMaxAmount() {
    // Smart MAX: set based on last focused button
    if (lastFocusedAction === 'withdraw') {
        await setMaxWithdraw();  // Set to vault balance
    } else {
        setMaxDeposit();         // Set to Backpack balance
    }
}
```

#### New Functions:

1. **`setMaxWithdraw()`**
   - Sets input to maximum vault balance
   - Reads from user's vault PDA

2. **`setMaxAmount()`**
   - Smart function that delegates to deposit or withdraw max
   - Checks `lastFocusedAction` variable

3. **Enhanced `openDepositModal()`**
   - Adds event listeners to track button hover/focus
   - Updates `lastFocusedAction` when user interacts with buttons

4. **Enhanced `executeDeposit()` and `executeWithdraw()`**
   - Sets `lastFocusedAction` when called
   - Ensures MAX button works correctly after execution

## How It Works

### User Flow for Deposit:
1. User opens deposit modal
2. User hovers over or clicks "Deposit" button
3. `lastFocusedAction` = 'deposit'
4. User clicks "MAX"
5. Input fills with Backpack wallet balance (minus 0.01 XNT for fees)

### User Flow for Withdraw:
1. User opens deposit modal
2. User hovers over or clicks "Withdraw" button
3. `lastFocusedAction` = 'withdraw'
4. User clicks "MAX"
5. Input fills with vault balance

### Smart Detection:
- **Hover tracking**: When user hovers over Deposit/Withdraw button
- **Focus tracking**: When user tabs to/clicks Deposit/Withdraw button
- **Action tracking**: When user executes deposit or withdraw
- **Default**: Falls back to deposit if no interaction

## Example Scenarios

### Scenario 1: User wants to deposit all funds
```
1. Opens modal
2. Hovers over "Deposit" button (lastFocusedAction = 'deposit')
3. Clicks "MAX" → fills with Backpack balance (e.g., 9.99 XNT)
4. Clicks "Deposit" → transfers to vault
```

### Scenario 2: User wants to withdraw all funds
```
1. Opens modal
2. Hovers over "Withdraw" button (lastFocusedAction = 'withdraw')
3. Clicks "MAX" → fills with vault balance (e.g., 50.0000 XNT)
4. Clicks "Withdraw" → transfers to Backpack
```

### Scenario 3: User changes mind
```
1. Opens modal
2. Hovers over "Deposit" (lastFocusedAction = 'deposit')
3. Clicks "MAX" → fills with 9.99 XNT
4. Changes mind, hovers over "Withdraw" (lastFocusedAction = 'withdraw')
5. Clicks "MAX" again → fills with 50.0000 XNT (vault balance)
```

## Technical Details

### Event Listeners
```javascript
depositBtn.addEventListener('mouseenter', () => { lastFocusedAction = 'deposit'; });
depositBtn.addEventListener('focus', () => { lastFocusedAction = 'deposit'; });

withdrawBtn.addEventListener('mouseenter', () => { lastFocusedAction = 'withdraw'; });
withdrawBtn.addEventListener('focus', () => { lastFocusedAction = 'withdraw'; });
```

### Balance Sources

| Action | MAX sets to | Source | Notes |
|--------|-------------|--------|-------|
| Deposit | Backpack balance - 0.01 XNT | `connection.getBalance(backpackWallet.publicKey)` | Leaves 0.01 for fees |
| Withdraw | Vault balance | `getUserVaultBalance()` reads Position account | Full vault balance available |

## Benefits

1. **User-friendly**: No need for separate MAX buttons
2. **Smart**: Automatically detects user intent
3. **Intuitive**: Hover/focus triggers correct behavior
4. **Safe**: Still validates balances on transaction execution

## Edge Cases Handled

- **Modal reopened**: Resets to deposit default
- **No hover/focus**: Defaults to deposit behavior
- **Button clicked directly**: Sets action before execution
- **Rapid switching**: Last interaction wins

## Testing

To test the smart MAX button:

1. **Deposit flow**:
   - Open modal
   - Hover over Deposit
   - Click MAX → should show Backpack balance

2. **Withdraw flow**:
   - Open modal
   - Hover over Withdraw
   - Click MAX → should show vault balance

3. **Switch between**:
   - Open modal
   - Click MAX (should default to deposit)
   - Hover over Withdraw
   - Click MAX again (should switch to withdraw)

## Future Enhancements

- Visual indicator showing which MAX will be used (e.g., button text changes)
- Separate MAX buttons for each action
- Keyboard shortcuts (D for deposit MAX, W for withdraw MAX)
- Tooltip showing "MAX Deposit" vs "MAX Withdraw"
