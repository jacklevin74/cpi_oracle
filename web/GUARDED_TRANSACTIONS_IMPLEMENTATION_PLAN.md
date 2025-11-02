# Guarded Transactions - Implementation & Testing Plan

**Status**: READY TO IMPLEMENT
**Timeline**: 7 weeks
**Priority**: Medium-High

---

## Quick Start

```bash
# Phase 1: Smart Contract
cd /home/ubuntu/dev/cpi_oracle
git checkout -b feature/guarded-transactions

# Phase 2: Frontend
cd web/public
# Edit app.js, index.html

# Phase 3: Testing
anchor test
npm test
```

---

## Phase 1: Smart Contract Foundation (2 weeks)

### Week 1.1: Guard Config & Validation

**Tasks:**

#### 1.1.1 Add Guard Config Struct
**File**: `programs/cpi_oracle/src/lib.rs`

```rust
// Add after existing structs (around line 150)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GuardConfig {
    pub guard_type: u8,              // 0=none, 1=limit, 2=slippage, 3=all-or-nothing, 4=partial
    pub price_limit: Option<i64>,    // Price per share in e6
    pub max_slippage_bps: Option<u16>,  // Max slippage in basis points
    pub quote_price: Option<i64>,    // Reference quote price
    pub quote_timestamp: Option<i64>, // When quote was generated
    pub allow_partial: bool,         // Allow partial fills?
    pub min_fill_shares: Option<i64>,  // Minimum shares to execute
    pub max_total_cost: Option<i64>, // Max total cost for BUY
}

impl Default for GuardConfig {
    fn default() -> Self {
        Self {
            guard_type: 0,  // No guards
            price_limit: None,
            max_slippage_bps: None,
            quote_price: None,
            quote_timestamp: None,
            allow_partial: false,
            min_fill_shares: None,
            max_total_cost: None,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug)]
pub struct TradeResult {
    pub shares_executed: i64,
    pub cost: i64,
    pub avg_price: i64,
    pub fully_executed: bool,
}
```

**Test**:
```bash
anchor build
# Should compile without errors
```

**Checklist**:
- [ ] GuardConfig struct compiles
- [ ] Default implementation works
- [ ] TradeResult struct compiles
- [ ] No breaking changes to existing code

---

#### 1.1.2 Add Error Codes
**File**: `programs/cpi_oracle/src/lib.rs`

```rust
// Add to error enum (around line 900)
#[error_code]
pub enum ErrorCode {
    // ... existing errors ...

    #[msg("Price limit exceeded - cannot execute at current price")]
    PriceLimitExceeded,

    #[msg("Price limit not met - cannot execute at current price")]
    PriceLimitNotMet,

    #[msg("Slippage exceeded maximum tolerance")]
    SlippageExceeded,

    #[msg("Total cost exceeds maximum allowed")]
    CostExceedsLimit,

    #[msg("Minimum fill amount not met")]
    MinFillNotMet,

    #[msg("Quote too stale - maximum 30 seconds old")]
    StaleQuote,

    #[msg("Invalid guard configuration")]
    InvalidGuardConfig,
}
```

**Test**:
```bash
anchor build
```

**Checklist**:
- [ ] Error codes compile
- [ ] Error messages are clear
- [ ] No duplicate error codes

---

### Week 1.2: Core Validation Logic

#### 1.2.1 Add Guard Validation Function
**File**: `programs/cpi_oracle/src/lib.rs`

```rust
// Add before trade function (around line 700)

/// Validates guards and returns the number of shares to execute
fn validate_guards(
    action: u8,
    side: u8,
    amount: i64,
    guards: &GuardConfig,
    amm: &Amm,
) -> Result<i64> {
    // If no guards, execute full amount
    if guards.guard_type == 0 {
        return Ok(amount);
    }

    // Calculate actual cost and average price for the full amount
    let (cost, avg_price) = if action == 0 {  // BUY
        calculate_buy_cost_and_avg_price(side, amount, amm)?
    } else {  // SELL
        calculate_sell_proceeds_and_avg_price(side, amount, amm)?
    };

    // Validate price limit (if set)
    if let Some(limit) = guards.price_limit {
        if action == 0 {  // BUY: price must be <= limit
            require!(avg_price <= limit, ErrorCode::PriceLimitExceeded);
        } else {  // SELL: price must be >= limit
            require!(avg_price >= limit, ErrorCode::PriceLimitNotMet);
        }
    }

    // Validate slippage (if set)
    if let Some(max_slip_bps) = guards.max_slippage_bps {
        if let Some(quote_price) = guards.quote_price {
            // Check quote age
            if let Some(quote_ts) = guards.quote_timestamp {
                let now = Clock::get()?.unix_timestamp;
                require!(
                    now - quote_ts <= 30,
                    ErrorCode::StaleQuote
                );
            }

            // Calculate slippage in basis points
            let slippage_bps = if action == 0 {  // BUY: higher is worse
                ((avg_price - quote_price) * 10000) / quote_price
            } else {  // SELL: lower is worse
                ((quote_price - avg_price) * 10000) / quote_price
            };

            require!(
                slippage_bps <= max_slip_bps as i64,
                ErrorCode::SlippageExceeded
            );
        }
    }

    // Validate max total cost (for BUY)
    if action == 0 {
        if let Some(max_cost) = guards.max_total_cost {
            require!(cost <= max_cost, ErrorCode::CostExceedsLimit);
        }
    }

    // If all-or-nothing, return full amount (already validated)
    if !guards.allow_partial {
        return Ok(amount);
    }

    // For partial fills, we'd need binary search (Phase 2)
    // For now, just execute full amount if it passes
    Ok(amount)
}

/// Helper: Calculate buy cost and average price
fn calculate_buy_cost_and_avg_price(
    side: u8,
    shares: i64,
    amm: &Amm,
) -> Result<(i64, i64)> {
    // Use existing LMSR calculation
    let cost = if side == 0 {
        calculate_buy_cost(shares, amm.q_yes, amm.q_no, amm.b)?
    } else {
        calculate_buy_cost(shares, amm.q_no, amm.q_yes, amm.b)?
    };

    let avg_price = (cost * 1_000_000) / shares;
    Ok((cost, avg_price))
}

/// Helper: Calculate sell proceeds and average price
fn calculate_sell_proceeds_and_avg_price(
    side: u8,
    shares: i64,
    amm: &Amm,
) -> Result<(i64, i64)> {
    // Use existing LMSR calculation
    let proceeds = if side == 0 {
        calculate_sell_proceeds(shares, amm.q_yes, amm.q_no, amm.b)?
    } else {
        calculate_sell_proceeds(shares, amm.q_no, amm.q_yes, amm.b)?
    };

    let avg_price = (proceeds * 1_000_000) / shares;
    Ok((proceeds, avg_price))
}

// NOTE: You'll need to extract these from the existing trade function
// They should already exist in some form
```

**Test**:
```bash
anchor build
anchor test
```

**Checklist**:
- [ ] Validation function compiles
- [ ] Price limit validation works
- [ ] Slippage validation works
- [ ] Quote staleness check works
- [ ] All-or-nothing mode works

---

### Week 2.1: Trade Guarded Instruction

#### 2.1.1 Add trade_guarded Instruction
**File**: `programs/cpi_oracle/src/lib.rs`

```rust
// Add after existing trade function (around line 850)

pub fn trade_guarded(
    ctx: Context<Trade>,
    side: u8,
    action: u8,
    amount: i64,
    guards: GuardConfig,
) -> Result<()> {
    // Validate inputs (same as trade())
    require!(side <= 1, ErrorCode::InvalidSide);
    require!(action <= 1, ErrorCode::InvalidAction);
    require!(amount > 0, ErrorCode::InvalidAmount);

    let amm = &mut ctx.accounts.amm;
    let position = &mut ctx.accounts.pos;

    // Check market is open
    require!(amm.is_open, ErrorCode::MarketClosed);

    // Validate guards and get shares to execute
    let shares_to_execute = validate_guards(action, side, amount, &guards, amm)?;

    // If partial fill and shares_to_execute < min_fill, reject
    if guards.allow_partial {
        if let Some(min_fill) = guards.min_fill_shares {
            require!(
                shares_to_execute >= min_fill,
                ErrorCode::MinFillNotMet
            );
        }
    }

    // Execute the trade using existing trade logic
    // (You'll need to extract the core trade logic into a helper function)
    execute_trade_internal(
        ctx,
        side,
        action,
        shares_to_execute,
    )?;

    // Emit event with guard info
    emit!(TradeSnapshot {
        // ... existing fields ...
        shares_requested: amount,
        shares_executed: shares_to_execute,
        guard_type: guards.guard_type,
    });

    Ok(())
}

// Helper function that contains the core trade logic
fn execute_trade_internal(
    ctx: Context<Trade>,
    side: u8,
    action: u8,
    shares: i64,
) -> Result<()> {
    // Extract the core logic from the existing trade() function
    // This is the actual BUY/SELL execution, vault transfers, etc.
    // ... (copy from existing trade function)
    Ok(())
}
```

**Test**:
```bash
anchor build
anchor test
```

**Checklist**:
- [ ] trade_guarded instruction compiles
- [ ] Backward compatibility maintained (trade() still works)
- [ ] Guards are validated before execution
- [ ] Events include guard information

---

### Week 2.2: Integration Tests

#### 2.2.1 Create Guard Tests
**File**: `tests/guarded-trades.test.ts` (NEW)

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CpiOracle } from "../target/types/cpi_oracle";
import { expect } from "chai";

describe("guarded-trades", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.CpiOracle as Program<CpiOracle>;

    // Test 1: Market order (no guards)
    it("executes market order with no guards", async () => {
        const guards = {
            guardType: 0,
            priceLimit: null,
            maxSlippageBps: null,
            quotePrice: null,
            quoteTimestamp: null,
            allowPartial: false,
            minFillShares: null,
            maxTotalCost: null,
        };

        const tx = await program.methods
            .tradeGuarded(0, 0, new anchor.BN(100_000_000), guards)
            .accounts({
                amm: ammPda,
                pos: positionPda,
                user: provider.wallet.publicKey,
                vault: vaultPda,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();

        // Should succeed
        expect(tx).to.not.be.null;
    });

    // Test 2: Limit order - favorable price
    it("executes limit order when price is favorable", async () => {
        const guards = {
            guardType: 1,  // LIMIT
            priceLimit: new anchor.BN(700_000),  // $0.70
            maxSlippageBps: null,
            quotePrice: null,
            quoteTimestamp: null,
            allowPartial: false,
            minFillShares: null,
            maxTotalCost: null,
        };

        const tx = await program.methods
            .tradeGuarded(0, 0, new anchor.BN(100_000_000), guards)
            .accounts({...})
            .rpc();

        expect(tx).to.not.be.null;
    });

    // Test 3: Limit order - unfavorable price
    it("rejects limit order when price exceeds limit", async () => {
        const guards = {
            guardType: 1,
            priceLimit: new anchor.BN(100_000),  // $0.10 (too low)
            maxSlippageBps: null,
            quotePrice: null,
            quoteTimestamp: null,
            allowPartial: false,
            minFillShares: null,
            maxTotalCost: null,
        };

        try {
            await program.methods
                .tradeGuarded(0, 0, new anchor.BN(100_000_000), guards)
                .accounts({...})
                .rpc();
            expect.fail("Should have thrown PriceLimitExceeded");
        } catch (err) {
            expect(err.message).to.include("PriceLimitExceeded");
        }
    });

    // Test 4: Slippage protection - within tolerance
    it("executes when slippage is within tolerance", async () => {
        const quotePrice = new anchor.BN(650_000);  // $0.65
        const guards = {
            guardType: 2,  // SLIPPAGE
            priceLimit: null,
            maxSlippageBps: 200,  // 2%
            quotePrice: quotePrice,
            quoteTimestamp: new anchor.BN(Math.floor(Date.now() / 1000)),
            allowPartial: false,
            minFillShares: null,
            maxTotalCost: null,
        };

        const tx = await program.methods
            .tradeGuarded(0, 0, new anchor.BN(100_000_000), guards)
            .accounts({...})
            .rpc();

        expect(tx).to.not.be.null;
    });

    // Test 5: Slippage protection - exceeded
    it("rejects when slippage exceeds tolerance", async () => {
        const quotePrice = new anchor.BN(500_000);  // $0.50 (stale)
        const guards = {
            guardType: 2,
            priceLimit: null,
            maxSlippageBps: 100,  // 1% (tight)
            quotePrice: quotePrice,
            quoteTimestamp: new anchor.BN(Math.floor(Date.now() / 1000)),
            allowPartial: false,
            minFillShares: null,
            maxTotalCost: null,
        };

        try {
            await program.methods
                .tradeGuarded(0, 0, new anchor.BN(1000_000_000), guards)  // Large trade
                .accounts({...})
                .rpc();
            expect.fail("Should have thrown SlippageExceeded");
        } catch (err) {
            expect(err.message).to.include("SlippageExceeded");
        }
    });

    // Test 6: Stale quote
    it("rejects stale quotes", async () => {
        const guards = {
            guardType: 2,
            priceLimit: null,
            maxSlippageBps: 500,
            quotePrice: new anchor.BN(650_000),
            quoteTimestamp: new anchor.BN(Math.floor(Date.now() / 1000) - 35),  // 35s ago
            allowPartial: false,
            minFillShares: null,
            maxTotalCost: null,
        };

        try {
            await program.methods
                .tradeGuarded(0, 0, new anchor.BN(100_000_000), guards)
                .accounts({...})
                .rpc();
            expect.fail("Should have thrown StaleQuote");
        } catch (err) {
            expect(err.message).to.include("StaleQuote");
        }
    });

    // Test 7: Max cost limit
    it("respects max cost limit", async () => {
        const guards = {
            guardType: 3,  // ALL_OR_NOTHING
            priceLimit: null,
            maxSlippageBps: null,
            quotePrice: null,
            quoteTimestamp: null,
            allowPartial: false,
            minFillShares: null,
            maxTotalCost: new anchor.BN(50_000_000),  // $50 max
        };

        try {
            await program.methods
                .tradeGuarded(0, 0, new anchor.BN(1000_000_000), guards)  // Costs > $50
                .accounts({...})
                .rpc();
            expect.fail("Should have thrown CostExceedsLimit");
        } catch (err) {
            expect(err.message).to.include("CostExceedsLimit");
        }
    });
});
```

**Run Tests**:
```bash
anchor test -- --grep "guarded-trades"
```

**Checklist**:
- [ ] All 7 tests pass
- [ ] Market orders work (no guards)
- [ ] Limit orders work correctly
- [ ] Slippage protection works
- [ ] Stale quotes are rejected
- [ ] Max cost limits are enforced
- [ ] Error messages are clear

---

## Phase 2: Frontend Integration (2 weeks)

### Week 3.1: Guard Configuration UI

#### 3.1.1 Add Guard State Variables
**File**: `public/app.js`

```javascript
// Add near top with other state variables (around line 25)

// Guard configuration state
let activeGuards = null;
let currentQuotePrice = null;
let currentQuoteTimestamp = null;
let quoteRefreshTimer = null;

// Guard presets
const GUARD_PRESETS = {
    NONE: { type: 'NONE', label: 'Market' },
    SLIP_2: { type: 'SLIPPAGE', maxSlippageBps: 200, label: '+2% Slip' },
    SLIP_5: { type: 'SLIPPAGE', maxSlippageBps: 500, label: '+5% Slip' },
    LIMIT: { type: 'LIMIT', label: 'Limit' },
};
```

**Checklist**:
- [ ] Variables added without errors
- [ ] No conflicts with existing code

---

#### 3.1.2 Add Guard Configuration Modal
**File**: `public/index.html`

```html
<!-- Add after existing modals (around line 500) -->

<!-- Guard Configuration Modal -->
<div id="guardConfigModal" class="modal">
    <div class="modal-content" style="max-width: 600px;">
        <h2>🛡️ Configure Trade Guards</h2>

        <div class="guard-type-selection">
            <label>Protection Type:</label>
            <div class="radio-group">
                <label>
                    <input type="radio" name="guardType" value="NONE" checked>
                    None (Market Order)
                </label>
                <label>
                    <input type="radio" name="guardType" value="LIMIT">
                    Limit Order
                </label>
                <label>
                    <input type="radio" name="guardType" value="SLIPPAGE">
                    Slippage Protection
                </label>
                <label>
                    <input type="radio" name="guardType" value="ALL_OR_NOTHING">
                    All-or-Nothing
                </label>
            </div>
        </div>

        <!-- Limit Order Settings -->
        <div id="limitSettings" class="guard-settings" style="display: none;">
            <h3>Limit Order Settings</h3>
            <label>
                Max Price Per Share (XNT):
                <input type="number" id="priceLimitInput" step="0.01" min="0" placeholder="0.70">
            </label>
            <div class="hint">
                Current avg price: <span id="currentAvgPrice">--</span>
            </div>
        </div>

        <!-- Slippage Settings -->
        <div id="slippageSettings" class="guard-settings" style="display: none;">
            <h3>Slippage Protection</h3>
            <label>
                Max Slippage (%):
                <input type="number" id="slippageInput" step="0.1" min="0" max="100" value="2.0">
            </label>
            <div class="hint">
                Quote price: <span id="quoteDisplay">--</span>
                <span id="quoteAge"></span>
                <button type="button" onclick="refreshQuote()">Refresh</button>
            </div>
        </div>

        <!-- All-or-Nothing Settings -->
        <div id="allOrNothingSettings" class="guard-settings" style="display: none;">
            <h3>All-or-Nothing</h3>
            <label>
                <input type="checkbox" id="maxCostEnabled">
                Set Max Total Cost
            </label>
            <label id="maxCostLabel" style="display: none;">
                Max Cost (XNT):
                <input type="number" id="maxCostInput" step="1" min="0" placeholder="400">
            </label>
        </div>

        <div class="execution-preview">
            <h3>Execution Preview</h3>
            <div id="guardPreview">Select a guard type to see preview</div>
        </div>

        <div class="modal-buttons">
            <button type="button" onclick="closeModal('guardConfigModal')">Cancel</button>
            <button type="button" onclick="applyGuards()" class="primary">Apply Guards</button>
        </div>
    </div>
</div>

<style>
.guard-type-selection {
    margin: 20px 0;
}

.radio-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 10px;
}

.guard-settings {
    background: rgba(0, 0, 0, 0.2);
    padding: 15px;
    border-radius: 8px;
    margin: 15px 0;
}

.guard-settings h3 {
    margin-top: 0;
    font-size: 16px;
}

.guard-settings label {
    display: block;
    margin: 10px 0;
}

.guard-settings input[type="number"] {
    width: 100%;
    padding: 8px;
    margin-top: 5px;
}

.hint {
    font-size: 12px;
    color: #888;
    margin-top: 5px;
}

.execution-preview {
    background: rgba(0, 200, 150, 0.1);
    padding: 15px;
    border-radius: 8px;
    margin: 15px 0;
}

.guard-badge {
    background: #00c896;
    color: white;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    margin-left: 8px;
}
</style>
```

**Checklist**:
- [ ] Modal displays correctly
- [ ] Radio buttons work
- [ ] Input validation works
- [ ] Responsive on mobile

---

#### 3.1.3 Add Guard Configuration Logic
**File**: `public/app.js`

```javascript
// Add guard configuration functions (around line 3000)

// Show/hide guard settings based on selection
document.addEventListener('DOMContentLoaded', () => {
    const guardTypeRadios = document.querySelectorAll('input[name="guardType"]');
    guardTypeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            // Hide all settings
            document.querySelectorAll('.guard-settings').forEach(el => {
                el.style.display = 'none';
            });

            // Show selected settings
            const type = e.target.value;
            if (type === 'LIMIT') {
                document.getElementById('limitSettings').style.display = 'block';
                updateCurrentPrice();
            } else if (type === 'SLIPPAGE') {
                document.getElementById('slippageSettings').style.display = 'block';
                refreshQuote();
            } else if (type === 'ALL_OR_NOTHING') {
                document.getElementById('allOrNothingSettings').style.display = 'block';
            }

            updateGuardPreview();
        });
    });

    // Max cost checkbox
    document.getElementById('maxCostEnabled').addEventListener('change', (e) => {
        document.getElementById('maxCostLabel').style.display = e.target.checked ? 'block' : 'none';
    });
});

// Open guard configuration modal
function openGuardConfigModal() {
    document.getElementById('guardConfigModal').classList.add('show');

    // Pre-populate if guards are active
    if (activeGuards) {
        const typeInput = document.querySelector(`input[name="guardType"][value="${activeGuards.type}"]`);
        if (typeInput) typeInput.checked = true;
        typeInput.dispatchEvent(new Event('change'));
    }
}

// Apply guards
function applyGuards() {
    const guardType = document.querySelector('input[name="guardType"]:checked').value;

    if (guardType === 'NONE') {
        activeGuards = null;
        updateGuardIndicators();
        closeModal('guardConfigModal');
        return;
    }

    // Build guard config
    activeGuards = { type: guardType };

    if (guardType === 'LIMIT') {
        const priceLimit = parseFloat(document.getElementById('priceLimitInput').value);
        if (!priceLimit || priceLimit <= 0) {
            alert('Please enter a valid price limit');
            return;
        }
        activeGuards.priceLimit = Math.floor(priceLimit * 1_000_000);
    }

    if (guardType === 'SLIPPAGE') {
        const slippage = parseFloat(document.getElementById('slippageInput').value);
        if (!slippage || slippage < 0) {
            alert('Please enter a valid slippage percentage');
            return;
        }
        if (!currentQuotePrice) {
            alert('Please refresh the quote first');
            return;
        }
        activeGuards.maxSlippageBps = Math.floor(slippage * 100);
        activeGuards.quotePrice = currentQuotePrice;
        activeGuards.quoteTimestamp = currentQuoteTimestamp;
    }

    if (guardType === 'ALL_OR_NOTHING') {
        const maxCostEnabled = document.getElementById('maxCostEnabled').checked;
        if (maxCostEnabled) {
            const maxCost = parseFloat(document.getElementById('maxCostInput').value);
            if (!maxCost || maxCost <= 0) {
                alert('Please enter a valid max cost');
                return;
            }
            activeGuards.maxTotalCost = Math.floor(maxCost * 1_000_000);
        }
    }

    updateGuardIndicators();
    closeModal('guardConfigModal');
    addLog(`Guards applied: ${guardType}`, 'info');
}

// Update UI indicators
function updateGuardIndicators() {
    const tradeBtn = document.getElementById('tradeBtn');
    const guardBadge = tradeBtn.querySelector('.guard-badge');

    if (activeGuards) {
        if (!guardBadge) {
            const badge = document.createElement('span');
            badge.className = 'guard-badge';
            badge.textContent = 'PROTECTED';
            tradeBtn.appendChild(badge);
        }
        tradeBtn.classList.add('guarded');
    } else {
        if (guardBadge) guardBadge.remove();
        tradeBtn.classList.remove('guarded');
    }
}

// Refresh quote
async function refreshQuote() {
    try {
        const shares = parseFloat(document.getElementById('tradeAmountShares').value) || 100;
        const action = getSelectedAction();
        const side = getSelectedSide();

        // Fetch quote from API
        const response = await fetch(
            `/api/ts/trade-quote?action=${action}&side=${side}&shares=${shares}`
        );

        if (!response.ok) {
            throw new Error('Failed to fetch quote');
        }

        const quote = await response.json();

        currentQuotePrice = quote.avgPrice;
        currentQuoteTimestamp = Math.floor(Date.now() / 1000);

        // Update display
        document.getElementById('quoteDisplay').textContent =
            `$${(quote.avgPrice / 1_000_000).toFixed(4)}`;
        document.getElementById('quoteAge').textContent = '(just now)';

        // Start age timer
        startQuoteRefresh();

        addLog(`Quote refreshed: $${(quote.avgPrice / 1_000_000).toFixed(4)}/share`, 'info');
    } catch (err) {
        console.error('Failed to refresh quote:', err);
        alert('Failed to refresh quote. Please try again.');
    }
}

// Start quote age timer
function startQuoteRefresh() {
    if (quoteRefreshTimer) clearInterval(quoteRefreshTimer);

    quoteRefreshTimer = setInterval(() => {
        if (!currentQuoteTimestamp) return;

        const age = Math.floor(Date.now() / 1000) - currentQuoteTimestamp;
        document.getElementById('quoteAge').textContent = `(${age}s ago)`;

        if (age > 30) {
            document.getElementById('quoteAge').style.color = '#ff4757';
            document.getElementById('quoteAge').textContent += ' ⚠️ STALE';
        }
    }, 1000);
}

// Update guard preview
function updateGuardPreview() {
    const guardType = document.querySelector('input[name="guardType"]:checked').value;
    const preview = document.getElementById('guardPreview');

    if (guardType === 'NONE') {
        preview.textContent = '✓ Will execute immediately at market price';
    } else if (guardType === 'LIMIT') {
        const limit = document.getElementById('priceLimitInput').value;
        if (limit) {
            preview.textContent = `✓ Will execute if price ≤ $${limit}/share\n✗ Will reject if price > $${limit}/share`;
        } else {
            preview.textContent = 'Enter a price limit to see preview';
        }
    } else if (guardType === 'SLIPPAGE') {
        const slip = document.getElementById('slippageInput').value;
        preview.textContent = `✓ Will execute if slippage ≤ ${slip}%\n✗ Will reject if slippage > ${slip}%`;
    } else if (guardType === 'ALL_OR_NOTHING') {
        preview.textContent = '✓ Will execute full amount or reject completely';
    }

    preview.style.whiteSpace = 'pre-line';
}

// Helper to get selected action
function getSelectedAction() {
    return document.getElementById('tradeAction').value === 'BUY' ? 0 : 1;
}

// Helper to get selected side
function getSelectedSide() {
    return document.getElementById('tradeSide').value === 'YES' ? 0 : 1;
}
```

**Checklist**:
- [ ] Modal opens/closes correctly
- [ ] Guard type selection works
- [ ] Settings show/hide correctly
- [ ] Quote refresh works
- [ ] Preview updates correctly

---

### Week 3.2: Add Guards to Trade Panel

#### 3.2.1 Update Trade Panel HTML
**File**: `public/index.html`

```html
<!-- Update trading panel (around line 300) -->
<div class="trading-panel">
    <!-- Existing trade controls -->

    <!-- Add after RAPID FIRE toggle -->
    <div class="guard-controls">
        <button type="button" onclick="openGuardConfigModal()" class="guard-config-btn">
            🛡️ Guards: <span id="guardStatus">None</span>
        </button>

        <div class="guard-presets">
            <button type="button" onclick="applyPreset('NONE')">Market</button>
            <button type="button" onclick="applyPreset('SLIP_2')">+2%</button>
            <button type="button" onclick="applyPreset('SLIP_5')">+5%</button>
            <button type="button" onclick="applyPreset('LIMIT')">Limit</button>
        </div>
    </div>
</div>

<style>
.guard-controls {
    margin: 15px 0;
}

.guard-config-btn {
    background: rgba(0, 200, 150, 0.2);
    border: 1px solid #00c896;
    color: #00c896;
    padding: 10px 15px;
    border-radius: 8px;
    cursor: pointer;
    width: 100%;
    margin-bottom: 10px;
}

.guard-config-btn:hover {
    background: rgba(0, 200, 150, 0.3);
}

.guard-presets {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
}

.guard-presets button {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: white;
    padding: 8px 5px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
}

.guard-presets button:hover {
    background: rgba(255, 255, 255, 0.2);
}

.guard-presets button.active {
    background: #00c896;
    border-color: #00c896;
}
</style>
```

**Checklist**:
- [ ] Guard controls display correctly
- [ ] Preset buttons work
- [ ] Guard status updates
- [ ] Mobile responsive

---

### Week 4: Backend API & Integration

#### 4.1 Add Quote Endpoint
**File**: `server.js`

```javascript
// Add after existing API routes (around line 200)

// Trade quote endpoint
app.get('/api/ts/trade-quote', async (req, res) => {
    try {
        const { action, side, shares } = req.query;

        if (!action || !side || !shares) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        // Fetch current AMM state
        const amm = await program.account.amm.fetch(ammPda);

        // Calculate quote using LMSR
        const sharesE6 = parseInt(shares) * 1_000_000;
        const quote = calculateTradeQuote(
            parseInt(action),
            parseInt(side),
            sharesE6,
            amm
        );

        res.json({
            shares: parseInt(shares),
            avgPrice: quote.avgPrice,
            totalCost: quote.totalCost,
            timestamp: Date.now(),
            validFor: 30000,  // 30 seconds
            marketState: {
                qYes: amm.qYes.toString(),
                qNo: amm.qNo.toString(),
                b: amm.b.toString()
            }
        });
    } catch (err) {
        console.error('Quote error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper function to calculate quote
function calculateTradeQuote(action, side, sharesE6, amm) {
    // Use existing LMSR calculation
    // This should match the on-chain calculation

    const b = parseInt(amm.b.toString());
    const qYes = parseInt(amm.qYes.toString());
    const qNo = parseInt(amm.qNo.toString());

    let cost;
    if (action === 0) {  // BUY
        if (side === 0) {  // YES
            cost = calculateBuyCost(sharesE6, qYes, qNo, b);
        } else {  // NO
            cost = calculateBuyCost(sharesE6, qNo, qYes, b);
        }
    } else {  // SELL
        if (side === 0) {  // YES
            cost = calculateSellProceeds(sharesE6, qYes, qNo, b);
        } else {  // NO
            cost = calculateSellProceeds(sharesE6, qNo, qYes, b);
        }
    }

    const avgPrice = Math.floor((cost * 1_000_000) / sharesE6);

    return {
        avgPrice,
        totalCost: cost
    };
}

// LMSR cost calculation (matching on-chain)
function calculateBuyCost(shares, q_buy, q_sell, b) {
    // C(q) = b * ln(e^(q_yes/b) + e^(q_no/b))
    // cost = C(q + shares) - C(q)

    const exp_before_buy = Math.exp(q_buy / b) + Math.exp(q_sell / b);
    const exp_after_buy = Math.exp((q_buy + shares) / b) + Math.exp(q_sell / b);

    const cost_before = b * Math.log(exp_before_buy);
    const cost_after = b * Math.log(exp_after_buy);

    return Math.floor(cost_after - cost_before);
}

function calculateSellProceeds(shares, q_sell, q_buy, b) {
    // Inverse of buy
    const exp_before_sell = Math.exp(q_sell / b) + Math.exp(q_buy / b);
    const exp_after_sell = Math.exp((q_sell - shares) / b) + Math.exp(q_buy / b);

    const cost_before = b * Math.log(exp_before_sell);
    const cost_after = b * Math.log(exp_after_sell);

    return Math.floor(cost_before - cost_after);
}
```

**Test**:
```bash
# Start server
node server.js

# Test quote endpoint
curl "http://localhost:3434/api/ts/trade-quote?action=0&side=0&shares=100"
```

**Checklist**:
- [ ] Quote endpoint returns valid data
- [ ] LMSR calculation matches on-chain
- [ ] Error handling works
- [ ] Response format is correct

---

#### 4.2 Update Trade Execution to Use Guards
**File**: `public/app.js`

```javascript
// Update executeTradeInternal function (around line 3570)

async function executeTradeInternal(tradeData) {
    const { action, side, numShares, pricePerShare, totalCost, amount_e6 } = tradeData;

    // Build guard config
    let guardConfig = null;
    if (activeGuards) {
        guardConfig = {
            guardType: getGuardTypeCode(activeGuards.type),
            priceLimit: activeGuards.priceLimit || null,
            maxSlippageBps: activeGuards.maxSlippageBps || null,
            quotePrice: activeGuards.quotePrice || null,
            quoteTimestamp: activeGuards.quoteTimestamp ?
                new anchor.BN(activeGuards.quoteTimestamp) : null,
            allowPartial: false,  // Phase 2
            minFillShares: null,
            maxTotalCost: activeGuards.maxTotalCost ?
                new anchor.BN(activeGuards.maxTotalCost) : null,
        };
    }

    try {
        // Choose instruction based on guards
        let tx;
        if (guardConfig) {
            addLog('Executing guarded trade...', 'info');
            tx = await program.methods
                .tradeGuarded(side, action, new anchor.BN(amount_e6), guardConfig)
                .accounts({
                    amm: ammPda,
                    pos: positionPda,
                    user: wallet.publicKey,
                    vault: vaultPda,
                    systemProgram: SystemProgram.programId
                })
                .rpc();
        } else {
            // Use regular trade
            tx = await program.methods
                .trade(side, action, new anchor.BN(amount_e6))
                .accounts({...})
                .rpc();
        }

        addLog(`Trade SUCCESS: ${tx}`, 'success');

        // Refresh data
        await Promise.all([
            updatePositionDisplay(),
            updateMarketData()
        ]);

    } catch (err) {
        console.error('Trade error:', err);

        // Parse guard errors
        if (err.message.includes('PriceLimitExceeded')) {
            addLog('❌ Trade rejected: Price limit exceeded', 'error');
            alert('Trade rejected: Current price exceeds your limit. Try increasing your limit or using a market order.');
        } else if (err.message.includes('SlippageExceeded')) {
            addLog('❌ Trade rejected: Slippage too high', 'error');
            alert('Trade rejected: Price moved too much from quote. Try refreshing quote or increasing slippage tolerance.');
        } else if (err.message.includes('StaleQuote')) {
            addLog('❌ Trade rejected: Quote is stale', 'error');
            alert('Trade rejected: Quote is too old. Please refresh and try again.');
        } else {
            addLog(`❌ Trade failed: ${err.message}`, 'error');
            alert(`Trade failed: ${err.message}`);
        }

        throw err;
    }
}

// Helper to convert guard type to code
function getGuardTypeCode(type) {
    const codes = {
        'NONE': 0,
        'LIMIT': 1,
        'SLIPPAGE': 2,
        'ALL_OR_NOTHING': 3,
        'PARTIAL': 4
    };
    return codes[type] || 0;
}

// Preset guard application
function applyPreset(presetName) {
    const preset = GUARD_PRESETS[presetName];

    if (!preset) return;

    if (presetName === 'NONE') {
        activeGuards = null;
    } else if (presetName === 'SLIP_2' || presetName === 'SLIP_5') {
        // Auto-refresh quote
        refreshQuote().then(() => {
            activeGuards = {
                type: 'SLIPPAGE',
                maxSlippageBps: preset.maxSlippageBps,
                quotePrice: currentQuotePrice,
                quoteTimestamp: currentQuoteTimestamp
            };
            updateGuardIndicators();
            addLog(`Applied ${preset.label} slippage protection`, 'info');
        });
        return;
    } else if (presetName === 'LIMIT') {
        // Open modal for limit config
        openGuardConfigModal();
        document.querySelector('input[value="LIMIT"]').checked = true;
        document.querySelector('input[value="LIMIT"]').dispatchEvent(new Event('change'));
        return;
    }

    updateGuardIndicators();

    // Update preset buttons
    document.querySelectorAll('.guard-presets button').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
}
```

**Checklist**:
- [ ] Guarded trades execute correctly
- [ ] Regular trades still work
- [ ] Error messages are user-friendly
- [ ] Guard indicators update properly

---

## Phase 3: Testing & Refinement (1 week)

### Week 5: End-to-End Testing

#### 5.1 Manual Testing Checklist

```markdown
## Manual Test Plan

### Setup
- [ ] Market is initialized
- [ ] User has sufficient balance
- [ ] Oracle price is updating

### Test Case 1: Market Order (No Guards)
- [ ] Click "Market" preset
- [ ] Enter 100 shares
- [ ] Execute trade
- [ ] ✓ Trade succeeds immediately

### Test Case 2: Limit Order (Favorable)
- [ ] Current price: ~$0.65
- [ ] Set limit: $0.70
- [ ] Execute 100 shares
- [ ] ✓ Trade succeeds
- [ ] ✓ Actual price ≤ $0.70

### Test Case 3: Limit Order (Unfavorable)
- [ ] Current price: ~$0.65
- [ ] Set limit: $0.10 (too low)
- [ ] Execute 100 shares
- [ ] ✓ Trade rejects with "PriceLimitExceeded"

### Test Case 4: Slippage (2%)
- [ ] Click "+2% Slip" preset
- [ ] ✓ Quote refreshes automatically
- [ ] Execute 100 shares
- [ ] ✓ Trade succeeds if slippage ≤ 2%
- [ ] ✓ Trade rejects if slippage > 2%

### Test Case 5: Slippage (Stale Quote)
- [ ] Get quote
- [ ] Wait 35 seconds
- [ ] Execute trade
- [ ] ✓ Trade rejects with "StaleQuote"

### Test Case 6: All-or-Nothing with Max Cost
- [ ] Select "All-or-Nothing"
- [ ] Enable max cost: $50
- [ ] Enter 1000 shares (costs > $50)
- [ ] ✓ Trade rejects with "CostExceedsLimit"
- [ ] Enter 50 shares (costs < $50)
- [ ] ✓ Trade succeeds

### Test Case 7: Rapid Fire with Guards
- [ ] Enable Rapid Fire mode
- [ ] Set 2% slippage guard
- [ ] Execute multiple trades
- [ ] ✓ All trades respect guards
- [ ] ✓ No confirmation dialogs

### Test Case 8: Large Trade Impact
- [ ] Set 5% slippage guard
- [ ] Execute 5000 shares (large trade)
- [ ] ✓ Trade succeeds if within 5%
- [ ] ✓ Actual slippage visible in logs

### Test Case 9: Mobile Responsiveness
- [ ] Open on mobile device
- [ ] ✓ Guard modal displays correctly
- [ ] ✓ Preset buttons are tappable
- [ ] ✓ All inputs are usable

### Test Case 10: Error Recovery
- [ ] Trigger each error type
- [ ] ✓ Error messages are clear
- [ ] ✓ User can retry after fixing
- [ ] ✓ No stuck states
```

---

#### 5.2 Automated E2E Tests
**File**: `tests/e2e/guarded-trades.spec.ts` (NEW)

```typescript
import { test, expect } from '@playwright/test';

test.describe('Guarded Trades E2E', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3434');
        await page.waitForSelector('#tradeBtn');
    });

    test('can apply 2% slippage preset', async ({ page }) => {
        // Click +2% preset
        await page.click('text=+2%');

        // Verify guard is applied
        await expect(page.locator('.guard-badge')).toHaveText('PROTECTED');

        // Execute trade
        await page.fill('#tradeAmountShares', '100');
        await page.click('#tradeBtn');

        // Should succeed or reject with clear message
        await page.waitForSelector('.trade-result, .error-message', { timeout: 10000 });
    });

    test('can configure limit order', async ({ page }) => {
        // Open guard config
        await page.click('text=Guards:');

        // Select limit order
        await page.click('input[value="LIMIT"]');

        // Enter limit
        await page.fill('#priceLimitInput', '0.70');

        // Apply
        await page.click('text=Apply Guards');

        // Verify guard status
        await expect(page.locator('#guardStatus')).toContainText('Limit');
    });

    test('shows error for stale quote', async ({ page }) => {
        // Apply slippage guard
        await page.click('text=+2%');

        // Wait for quote to become stale (>30s)
        // (In real test, mock the timestamp)

        // Try to execute
        await page.fill('#tradeAmountShares', '100');
        await page.click('#tradeBtn');

        // Should show stale quote error
        await expect(page.locator('.error-message')).toContainText('stale');
    });
});
```

**Run E2E Tests**:
```bash
npx playwright test tests/e2e/guarded-trades.spec.ts
```

---

## Phase 4: Beta Launch (1 week)

### Week 6: Beta Testing

#### 6.1 Beta Launch Checklist

```markdown
## Beta Launch Checklist

### Pre-Launch
- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] All E2E tests passing
- [ ] Manual test plan completed
- [ ] Documentation updated
- [ ] Feature flag added (ENABLE_GUARDS)

### Launch
- [ ] Deploy updated smart contract to devnet
- [ ] Deploy frontend with guards behind feature flag
- [ ] Enable for beta testers only
- [ ] Monitor error rates
- [ ] Collect feedback

### Monitoring
- [ ] Track guard usage rates
- [ ] Monitor error types
- [ ] Check gas costs
- [ ] Measure latency impact
- [ ] User feedback surveys

### Success Criteria
- [ ] < 5% transaction failure rate
- [ ] > 80% beta tester satisfaction
- [ ] No critical bugs found
- [ ] Gas cost increase < 20%
- [ ] Latency increase < 25%
```

---

#### 6.2 Beta Feedback Collection

**Add feedback form to UI:**

```html
<!-- Add to index.html -->
<div id="guardFeedbackModal" class="modal">
    <div class="modal-content">
        <h2>Guards Feedback</h2>
        <p>Help us improve trade protection!</p>

        <label>
            Did guards work as expected?
            <select id="feedbackWorked">
                <option value="yes">Yes</option>
                <option value="no">No</option>
                <option value="partial">Partially</option>
            </select>
        </label>

        <label>
            Which guard type did you use?
            <select id="feedbackType">
                <option value="limit">Limit Order</option>
                <option value="slippage">Slippage Protection</option>
                <option value="all-or-nothing">All-or-Nothing</option>
            </select>
        </label>

        <label>
            Additional feedback:
            <textarea id="feedbackText" rows="4"></textarea>
        </label>

        <div class="modal-buttons">
            <button onclick="closeModal('guardFeedbackModal')">Skip</button>
            <button onclick="submitGuardFeedback()" class="primary">Submit</button>
        </div>
    </div>
</div>

<script>
async function submitGuardFeedback() {
    const feedback = {
        worked: document.getElementById('feedbackWorked').value,
        type: document.getElementById('feedbackType').value,
        text: document.getElementById('feedbackText').value,
        timestamp: new Date().toISOString()
    };

    try {
        await fetch('/api/feedback/guards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(feedback)
        });

        addLog('Feedback submitted. Thank you!', 'success');
        closeModal('guardFeedbackModal');
    } catch (err) {
        console.error('Failed to submit feedback:', err);
    }
}
</script>
```

---

## Phase 5: Full Rollout (2 weeks)

### Week 7: Gradual Rollout

#### 7.1 Rollout Plan

```markdown
## Rollout Schedule

### Day 1-2: 10% of Users
- Enable guards for 10% of traffic
- Monitor closely
- Fix any critical issues

### Day 3-4: 25% of Users
- Increase to 25%
- Collect more feedback
- Monitor metrics

### Day 5-7: 50% of Users
- Half of users have access
- Performance testing at scale
- Optimize based on data

### Week 2: 100% Rollout
- Enable for all users
- Set smart defaults (5% slippage for large trades)
- Add in-app tutorials
- Remove feature flag

### Post-Launch
- Monitor adoption rates
- Iterate based on feedback
- Plan Phase 2 features (partial fills)
```

---

#### 7.2 Success Metrics Dashboard

**Track these metrics:**

```javascript
// Add to server.js
const guardMetrics = {
    totalTrades: 0,
    guardedTrades: 0,
    guardTypes: {
        limit: 0,
        slippage: 0,
        allOrNothing: 0
    },
    rejections: {
        priceLimit: 0,
        slippage: 0,
        staleQuote: 0,
        costLimit: 0
    },
    avgGasCost: {
        market: [],
        guarded: []
    }
};

// Log guard usage
app.post('/api/metrics/guard-usage', (req, res) => {
    const { type, success, gasUsed } = req.body;

    guardMetrics.totalTrades++;
    if (type !== 'none') {
        guardMetrics.guardedTrades++;
        guardMetrics.guardTypes[type]++;
    }

    if (type === 'none') {
        guardMetrics.avgGasCost.market.push(gasUsed);
    } else {
        guardMetrics.avgGasCost.guarded.push(gasUsed);
    }

    res.json({ received: true });
});

// Metrics dashboard
app.get('/api/metrics/guards', (req, res) => {
    const adoptionRate = (guardMetrics.guardedTrades / guardMetrics.totalTrades * 100).toFixed(1);

    const avgGasMarket = guardMetrics.avgGasCost.market.reduce((a,b) => a+b, 0) /
        guardMetrics.avgGasCost.market.length || 0;
    const avgGasGuarded = guardMetrics.avgGasCost.guarded.reduce((a,b) => a+b, 0) /
        guardMetrics.avgGasCost.guarded.length || 0;

    res.json({
        adoptionRate: `${adoptionRate}%`,
        totalTrades: guardMetrics.totalTrades,
        guardedTrades: guardMetrics.guardedTrades,
        guardTypes: guardMetrics.guardTypes,
        rejections: guardMetrics.rejections,
        gasCostIncrease: `${((avgGasGuarded - avgGasMarket) / avgGasMarket * 100).toFixed(1)}%`
    });
});
```

---

## Phase 2 (Future): Advanced Features

**Partial Fills** (Next iteration after successful rollout)

```rust
// Binary search implementation
fn find_max_executable_shares(
    action: u8,
    side: u8,
    max_shares: i64,
    guards: &GuardConfig,
    amm: &Amm
) -> Result<i64> {
    let mut left = guards.min_fill_shares.unwrap_or(1_000_000);
    let mut right = max_shares;
    let mut best = 0;

    while left <= right {
        let mid = (left + right) / 2;

        if shares_pass_guards(mid, action, side, guards, amm)? {
            best = mid;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    Ok(best)
}
```

---

## Quick Commands

```bash
# Build & Test
anchor build
anchor test

# Frontend
cd web
npm install
node server.js

# Run specific tests
anchor test -- --grep "guarded"
npx playwright test tests/e2e/guarded-trades.spec.ts

# Deploy
anchor deploy --provider.cluster devnet

# Monitor
tail -f /tmp/web_server.log
curl http://localhost:3434/api/metrics/guards
```

---

## Troubleshooting

### Common Issues

**Issue**: Guards not applying
- Check `activeGuards` is set
- Verify guard config structure
- Check console for errors

**Issue**: Quote always stale
- Increase timeout to 60s for testing
- Verify timestamp is in seconds, not ms
- Check clock synchronization

**Issue**: Slippage calculation wrong
- Verify LMSR math matches on-chain
- Check for integer overflow
- Test with small amounts first

**Issue**: Gas costs too high
- Disable partial fills
- Limit guard combinations
- Optimize binary search iterations

---

## Support & Documentation

- Full Design: `GUARDED_TRANSACTIONS_DESIGN.md`
- Quick Reference: `GUARDED_TRANSACTIONS_SUMMARY.md`
- This Plan: `GUARDED_TRANSACTIONS_IMPLEMENTATION_PLAN.md`

---

**Status**: READY TO IMPLEMENT
**Start Date**: TBD
**Expected Completion**: 7 weeks from start
**Next Step**: Begin Phase 1, Week 1.1
