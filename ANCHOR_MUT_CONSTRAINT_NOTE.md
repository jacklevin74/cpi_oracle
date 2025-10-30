# CRITICAL: Anchor #[account(mut)] Constraint Pattern

## The Problem

When you need to receive SOL into an account via CPI in Anchor, you CANNOT simply add `#[account(mut)]` to enforce writability.

### ❌ WRONG Patterns:

**Pattern 1 (causes ConstraintMut error):**
```rust
#[account(mut)]
pub user: Signer<'info>,
```
The `#[account(mut)]` on `Signer` enforces writability but doesn't work well with CPIs.

**Pattern 2 (causes privilege escalation error):**
```rust
pub user: Signer<'info>,  // No mut, but CPI fails!
```
The `Signer<'info>` type doesn't properly expose writability for CPI contexts.

## The Solution

### ✅ CORRECT Pattern:
```rust
/// Session wallet - UncheckedAccount allows CPI to write when client marks writable
/// CHECK: Session wallet that signs the transaction and may receive SOL topup from vault PDA
pub user: UncheckedAccount<'info>,
```

**Key Points:**
1. **USE** `UncheckedAccount` WITHOUT `#[account(mut)]` for external wallets receiving CPI transfers
2. **DO** mark the account as `isWritable: true` in the client transaction instruction
3. **DO** add a `/// CHECK:` comment explaining the safety reasoning
4. **Verify** the account is a signer through other means (e.g., it's in PDA seeds, or checked in code)
5. **DO NOT** use `#[account(mut)]` - let the client's `isWritable: true` handle writability

## Why This Works

- `UncheckedAccount<'info>` doesn't enforce any Anchor constraints that could fail
- The client's `isWritable: true` marks the account as writable in the transaction
- The System Program's transfer CPI succeeds because the account IS writable (client-side)
- No Anchor validation means no `ConstraintMut` errors
- Account signature verification happens through other means (PDA seeds, manual checks in code)

## Example: Auto-Topup Pattern

### Program Side:
```rust
pub struct UserVault<'info> {
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: AccountInfo<'info>,  // PDA source

    /// CHECK: Session wallet that signs and may receive SOL topup
    pub user: UncheckedAccount<'info>,  // External wallet destination (NO #[account(mut)]!)

    pub system_program: Program<'info, System>,
}

// In the instruction:
transfer_sol_signed(
    &ctx.accounts.system_program,
    &ctx.accounts.user_vault.to_account_info(),
    &ctx.accounts.user.to_account_info(),
    amount,
    signer_seeds,
)?;
```

### Client Side:
```javascript
const keys = [
    // ...
    { pubkey: userVaultPda, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },  // ← Must be writable!
    { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
];
```

## Remember

**For accounts receiving SOL via CPI:**
- ✅ Use: `#[account(mut)] pub user: UncheckedAccount<'info>` (if account doesn't sign)
- ❌ Don't use: `pub user: Signer<'info>` (can't receive in CPI)
- ❌ Don't use: `#[account(mut)] pub user: Signer<'info>` (ConstraintMut error)

**Client's `isWritable: true` = Transaction instruction metadata**
- Always required for accounts that will be modified (including receiving lamports)
- Must match the program's `#[account(mut)]` expectations
- This is what the System Program checks during CPI

## SUCCESSFUL PATTERN: Session Wallet Auto-Topup (WORKING!)

### The Key Insight
The session wallet doesn't need to SIGN the deposit transaction - it just needs to be the correct session wallet for PDA derivation. This allows us to mark it writable and receive topup funds!

### Program Side (Rust):
```rust
#[derive(Accounts)]
pub struct UserVault<'info> {
    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), session_wallet.key().as_ref()],
        bump,
        constraint = pos.owner == session_wallet.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: AccountInfo<'info>,

    /// CHECK: Session wallet - can receive SOL topup from vault. Verified by PDA derivation.
    #[account(mut)]
    pub session_wallet: UncheckedAccount<'info>,  // NOT a signer!

    #[account(mut)]
    pub master_wallet: Signer<'info>,  // Only master wallet signs

    pub system_program: Program<'info, System>,
}

pub fn deposit(ctx: Context<UserVault>, amount_lamports: u64) -> Result<()> {
    // Check session wallet balance
    let session_balance = ctx.accounts.session_wallet.lamports();
    if session_balance < MIN_SESSION_BALANCE {
        // Topup from vault PDA using invoke_signed
        invoke_signed(
            &system_instruction::transfer(
                ctx.accounts.user_vault.key,
                ctx.accounts.session_wallet.key,
                topup_amount,
            ),
            &[
                ctx.accounts.user_vault.to_account_info(),
                ctx.accounts.session_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[Position::USER_VAULT_SEED, pos_key.as_ref(), &[pos.vault_bump]]],
        )?;
    }
    // ... rest of deposit logic
}
```

### Client Side (JavaScript):
```javascript
const keys = [
    { pubkey: ammPda, isSigner: false, isWritable: false },
    { pubkey: posPda, isSigner: false, isWritable: true },
    { pubkey: userVaultPda, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: false, isWritable: true },  // NOT a signer, but writable!
    { pubkey: backpackWallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
];

// Only master wallet signs
const tx = await backpackWallet.signTransaction(transaction);
// Session wallet does NOT sign!
```

### Why This Works
1. **Session wallet doesn't sign** - avoids privilege escalation issue
2. **PDA derivation verifies identity** - we know it's the correct session wallet
3. **Client marks it writable from the start** - no privilege escalation
4. **Vault PDA has authority** - can transfer to session wallet via invoke_signed
5. **No Anchor constraint violations** - UncheckedAccount doesn't enforce signing

## Error Codes

- `ConstraintMut (0x7d0 / 2000)`: Using `#[account(mut)]` on `Signer<'info>` when account isn't writable
  - Solution: Use `UncheckedAccount<'info>` instead of `Signer<'info>`

- `"writable privilege escalated"`: CPI trying to write to account not marked writable in original transaction
  - Cause: Using `Signer<'info>` which doesn't expose writability for CPIs
  - Solution: Use `#[account(mut)] pub user: UncheckedAccount<'info>` + client `isWritable: true`
