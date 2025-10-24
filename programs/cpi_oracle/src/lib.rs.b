use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction,
};
use anchor_lang::system_program::{self, System};

declare_id!("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");

// =========================
// Oracle (foreign) settings
// =========================
pub const ORACLE_PROGRAM_ID: Pubkey =
    pubkey!("7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OracleStateMirror {
    pub update_authority: Pubkey,
    pub btc: Triplet,
    pub eth: Triplet,
    pub sol: Triplet,
    pub decimals: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Triplet {
    pub param1: i64, pub param2: i64, pub param3: i64,
    pub ts1: i64,    pub ts2: i64,    pub ts3: i64,
}

// ===========================
// Market (single) with LMSR + coverage + settlement
// ===========================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum MarketStatus { Open = 0, Stopped = 1, Settled = 2 }

#[account]
pub struct Amm {
    // core
    pub bump: u8,
    pub decimals: u8,     // fixed point (6)
    pub b: i64,           // LMSR liquidity (1e6)
    pub fee_bps: u16,     // taker fee in bps

    // inventory (shares 1e6)
    pub q_yes: i64,
    pub q_no: i64,

    // fees accrued (1e6) - accounting mirror
    pub fees: i64,

    // coverage mirror (real lamports in vault_sol PDA)
    pub vault_e6: i64,

    // lifecycle
    pub status: u8,       // MarketStatus as u8
    pub winner: u8,       // 0=unknown, 1=YES, 2=NO

    // settlement snapshot
    pub w_total_e6: i64,  // total winning shares at stop
    pub pps_e6: i64,      // payout per winning share: min(1e6, floor(vault / W))

    // fee treasury (lamports)
    pub fee_dest: Pubkey,

    // bump for the system-owned SOL vault PDA
    pub vault_sol_bump: u8,
}
impl Amm {
    pub const SEED: &'static [u8] = b"amm_btc_v2";
    pub const VAULT_SOL_SEED: &'static [u8] = b"vault_sol";
    // base 62 + 32 (fee_dest) + 1 (vault_sol_bump) = 95
    pub const SIZE: usize = 95;

    #[inline] pub fn status(&self) -> MarketStatus {
        match self.status { 0 => MarketStatus::Open, 1 => MarketStatus::Stopped, _ => MarketStatus::Settled }
    }
}

// Per-user position (PDA is per-market: [b"pos", amm, user])
#[account]
pub struct Position {
    pub owner: Pubkey,
    pub yes_shares_e6: i64,
    pub no_shares_e6: i64,
}
impl Position {
    pub const SEED: &'static [u8] = b"pos";
    pub const SIZE: usize = 32 + 8 + 8;
}

// ---- Limits (all scaled 1e6) ----
const MIN_BUY_E6: i64   = 100_000;         // $0.10 min
const MIN_SELL_E6: i64  = 100_000;         // 0.100000 share min
const SPEND_MAX_E6: i64 = 50_000_000_000;  // $50,000 per trade
const DQ_MAX_E6: i64    = 50_000_000_000;  // 50,000,000 shares per trade

// ---- Events ----
#[event]
pub struct TradeSnapshot {
    pub side: u8,            // 1=YES, 2=NO
    pub action: u8,          // 1=BUY, 2=SELL
    pub net_e6: i64,         // BUY: net spend; SELL: net proceeds
    pub dq_e6: i64,          // BUY: shares minted; SELL: shares sold
    pub avg_price_e6: i64,   // average price per share (1e6)
    pub q_yes: i64,
    pub q_no: i64,
    pub vault_e6: i64,
    pub p_yes_e6: i64,
    pub fees_e6: i64,
}

// ============================== Accounts ==============================

#[derive(Accounts)]
pub struct LogOracle<'info> {
    /// CHECK: read-only; we assert `owner == ORACLE_PROGRAM_ID` in the handler.
    #[account(owner = ORACLE_PROGRAM_ID)]
    pub oracle_state: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitAmm<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Amm::SIZE,
        seeds = [Amm::SEED],
        bump
    )]
    pub amm: Account<'info, Amm>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: fee treasury (lamports). We require `fee_dest.owner == System` in handler.
    #[account(mut)]
    pub fee_dest: UncheckedAccount<'info>,

    /// CHECK: system-owned 0-space vault PDA for SOL: seeds [VAULT_SOL_SEED, amm].
    /// We **do not** try to create this; it can simply receive lamports later.
    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Quote<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,
}

#[derive(Accounts)]
pub struct InitPosition<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(
        init,
        payer = user,
        space = 8 + Position::SIZE,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub pos: Account<'info, Position>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: writable lamport recipient for fees; address checked against `amm.fee_dest`.
    #[account(mut, address = amm.fee_dest)]
    pub fee_dest: UncheckedAccount<'info>,

    /// CHECK: writable SOL vault PDA (system-owned, 0 space) used as lamports pool.
    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump = amm.vault_sol_bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: fee treasury (lamports) — no longer used as rent payer here.
    #[account(mut, address = amm.fee_dest)]
    pub fee_dest: UncheckedAccount<'info>,

    /// CHECK: writable SOL vault PDA (system-owned, 0 space)
    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump = amm.vault_sol_bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CloseAmm<'info> {
    #[account(
        mut,
        seeds = [Amm::SEED],
        bump = amm.bump,
        close = recipient
    )]
    pub amm: Account<'info, Amm>,
    #[account(mut)]
    pub recipient: Signer<'info>,
}

// =========================== Program ===========================
#[program]
pub mod cpi_oracle {
    use super::*;

    // ---------- ORACLE print ----------
    pub fn log_oracle(ctx: Context<LogOracle>) -> Result<()> {
        let ai = &ctx.accounts.oracle_state;
        require_keys_eq!(*ai.owner, ORACLE_PROGRAM_ID, ReaderError::WrongOwner);

        let data = ai.try_borrow_data()?;
        require!(data.len() >= 8, ReaderError::DataTooSmall);
        let payload = &data[8..];
        let s = OracleStateMirror::try_from_slice(payload)
            .map_err(|_| error!(ReaderError::DeserializeFail))?;

        let scale = 10i64.pow(s.decimals as u32) as f64;
        let to_f = |v: i64| (v as f64)/scale;

        msg!("── ORACLE (dec={}): BTC {:.2} / {:.2} / {:.2}",
            s.decimals, to_f(s.btc.param1), to_f(s.btc.param2), to_f(s.btc.param3));
        Ok(())
    }

    // ---------- INIT market ----------
    pub fn init_amm(ctx: Context<InitAmm>, b: i64, fee_bps: u16) -> Result<()> {
        let amm = &mut ctx.accounts.amm;

        // Safety: require fee_dest is a System account
        let fee_owner: Pubkey = *ctx.accounts.fee_dest.to_account_info().owner;
        require_keys_eq!(fee_owner, System::id(), ReaderError::BadParam);

        amm.bump = ctx.bumps.amm;
        amm.decimals = 6;
        require!(b > 0, ReaderError::BadParam);
        amm.b = b;
        amm.fee_bps = fee_bps;
        amm.q_yes = 0;
        amm.q_no  = 0;
        amm.fees = 0;
        amm.vault_e6 = 0;
        amm.status = MarketStatus::Open as u8;
        amm.winner = 0;
        amm.w_total_e6 = 0;
        amm.pps_e6 = 0;
        amm.fee_dest = ctx.accounts.fee_dest.key();
        amm.vault_sol_bump = ctx.bumps.vault_sol;

        // If vault already has lamports from a prior run, sweep to fee_dest; otherwise leave it.
        let vault_ai = ctx.accounts.vault_sol.to_account_info();
        let fee_dest_ai = ctx.accounts.fee_dest.to_account_info();
        if vault_ai.lamports() > 0 {
            let bal = vault_ai.lamports();
            let amm_key = amm.key();
            let seeds: &[&[u8]] = &[
                Amm::VAULT_SOL_SEED,
                amm_key.as_ref(),
                core::slice::from_ref(&amm.vault_sol_bump),
            ];
            let ix = system_instruction::transfer(&vault_ai.key(), &fee_dest_ai.key(), bal);
            invoke_signed(
                &ix,
                &[
                    vault_ai.clone(),
                    fee_dest_ai.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[seeds],
            )?;
        }

        msg!("✅ INIT: b={} (1e-6), fee_bps={}, status=Open, fee_dest={}, vault_sol ready",
             b, fee_bps, amm.fee_dest);
        Ok(())
    }

    // ---------- INIT position (per user & market) ----------
    pub fn init_position(ctx: Context<InitPosition>) -> Result<()> {
        let pos = &mut ctx.accounts.pos;
        pos.owner = ctx.accounts.user.key();
        pos.yes_shares_e6 = 0;
        pos.no_shares_e6 = 0;
        msg!("✅ Position initialized for {}", pos.owner);
        Ok(())
    }

    // ---------- QUOTE ----------
    pub fn quote(ctx: Context<Quote>) -> Result<()> {
        let amm = &ctx.accounts.amm;
        let p = lmsr_p_yes(amm);
        msg!("── QUOTE  pYes={:.6}  pNo={:.6}  skew={:.6}sh",
             p, 1.0 - p, sh((amm.q_yes - amm.q_no) as i64));
        msg!("          qYes={:.6}sh  qNo={:.6}sh  b={:.0}sh  vault=${:.6}  fees=${:.6}",
             sh(amm.q_yes), sh(amm.q_no), sh(amm.b), usd(amm.vault_e6), usd(amm.fees));
        Ok(())
    }

    // ---------- TRADE ----------
    /// side: 1=YES, 2=NO
    /// action: 1=BUY (amount=spend 1e6), 2=SELL (amount=shares 1e6)
    pub fn trade(ctx: Context<Trade>, side: u8, action: u8, amount: i64) -> Result<()> {
        let amm  = &mut ctx.accounts.amm;
        let pos  = &mut ctx.accounts.pos;
        let sys  = &ctx.accounts.system_program;

        require!(amount > 0, ReaderError::BadParam);
        require!(amm.status() == MarketStatus::Open, ReaderError::MarketClosed);

        match (side, action) {
            (1, 1) => { // BUY YES
                require!(amount >= MIN_BUY_E6 && amount <= SPEND_MAX_E6, ReaderError::BadParam);
                let (dq_e6, avg_h) = lmsr_buy_yes(amm, amount)?;
                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_add(dq_e6.round() as i64);

                // Collect lamports from user: fee + net
                let fee_e6 = ((amount as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = amount.saturating_sub(fee_e6);

                transfer_sol(sys, &ctx.accounts.user.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(net_e6))?;
                transfer_sol(sys, &ctx.accounts.user.to_account_info(), &ctx.accounts.fee_dest.to_account_info(), e6_to_lamports(fee_e6))?;

                emit_trade(amm, 1, 1, amount, dq_e6.round() as i64, avg_h);
                log_trade_buy("BUY YES", amount, dq_e6, avg_h, lmsr_p_yes(amm), amm);
            }
            (2, 1) => { // BUY NO
                require!(amount >= MIN_BUY_E6 && amount <= SPEND_MAX_E6, ReaderError::BadParam);
                let (dq_e6, avg_h) = lmsr_buy_no(amm, amount)?;
                pos.no_shares_e6 = pos.no_shares_e6.saturating_add(dq_e6.round() as i64);

                let fee_e6 = ((amount as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = amount.saturating_sub(fee_e6);

                transfer_sol(sys, &ctx.accounts.user.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(net_e6))?;
                transfer_sol(sys, &ctx.accounts.user.to_account_info(), &ctx.accounts.fee_dest.to_account_info(), e6_to_lamports(fee_e6))?;

                emit_trade(amm, 2, 1, amount, dq_e6.round() as i64, avg_h);
                log_trade_buy("BUY NO ", amount, dq_e6, avg_h, lmsr_p_yes(amm), amm);
            }
            (1, 2) => { // SELL YES → pay user from vault_sol
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);
                let sell_e6 = amount.min(pos.yes_shares_e6);
                require!(sell_e6 > 0, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_yes(amm, sell_e6)?;
                require!(amm.vault_e6 >= proceeds_e6, ReaderError::NoCoverage);

                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_sub(sold_e6.round() as i64);
                emit_trade(amm, 1, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
                log_trade_sell("SELL YES", sold_e6, proceeds_e6, avg_h, lmsr_p_yes(amm), amm);
            }
            (2, 2) => { // SELL NO → pay user from vault_sol
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);
                let sell_e6 = amount.min(pos.no_shares_e6);
                require!(sell_e6 > 0, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_no(amm, sell_e6)?;
                require!(amm.vault_e6 >= proceeds_e6, ReaderError::NoCoverage);

                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                pos.no_shares_e6 = pos.no_shares_e6.saturating_sub(sold_e6.round() as i64);
                emit_trade(amm, 2, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
                log_trade_sell("SELL NO ", sold_e6, proceeds_e6, avg_h, lmsr_p_yes(amm), amm);
            }
            _ => return err!(ReaderError::BadParam),
        }
        Ok(())
    }

    // ---------- STOP ----------
    pub fn stop_market(ctx: Context<AdminOnly>) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        require!(amm.status() == MarketStatus::Open, ReaderError::WrongState);
        amm.status = MarketStatus::Stopped as u8;
        msg!("⏹️  Market STOPPED");
        Ok(())
    }

    // ---------- SETTLE (winner: 1=YES, 2=NO) ----------
    pub fn settle_market(ctx: Context<AdminOnly>, winner: u8) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        require!(amm.status() == MarketStatus::Stopped, ReaderError::WrongState);
        require!(winner == 1 || winner == 2, ReaderError::BadParam);
        amm.winner = winner;

        // Snapshot W (total winning shares at stop)
        let w = if winner == 1 { amm.q_yes } else { amm.q_no };
        amm.w_total_e6 = w.max(0);

        // pps = min(1e6, floor(vault / W)) with exact integers
        let pps_e6 = if amm.w_total_e6 <= 0 {
            0
        } else {
            let num: i128 = (amm.vault_e6.max(0) as i128) * 1_000_000i128;
            let den: i128 = amm.w_total_e6 as i128;
            let floored: i64 = (num / den) as i64;
            floored.min(1_000_000)
        };
        amm.pps_e6 = pps_e6;
        amm.status = MarketStatus::Settled as u8;

        msg!("✅ SETTLED winner={}  W={}  vault=${:.6}  pps={:.6}",
             winner, amm.w_total_e6, usd(amm.vault_e6), (pps_e6 as f64)/1_000_000.0);
        Ok(())
    }


    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
    let sys  = &ctx.accounts.system_program;

    require!(ctx.accounts.amm.status() == MarketStatus::Settled, ReaderError::WrongState);

    // read-only views
    let pos_ro = &ctx.accounts.pos;
    let amm_ro = &ctx.accounts.amm;

    let (win_sh_e6, _lose_sh_e6) = match amm_ro.winner {
        1 => (pos_ro.yes_shares_e6, pos_ro.no_shares_e6),
        2 => (pos_ro.no_shares_e6,  pos_ro.yes_shares_e6),
        _ => (0, 0),
    };

    if win_sh_e6 <= 0 {
        msg!("No winning shares to redeem");
        let pos_mut = &mut ctx.accounts.pos;
        pos_mut.yes_shares_e6 = 0;
        pos_mut.no_shares_e6  = 0;
        return Ok(());
    }

    // Theoretical payout from snapshot pps (still bounded by mirror and lamports below)
    let w_snap = amm_ro.w_total_e6.max(0);
    let win_clamped = if win_sh_e6 < 0 { 0 } else { win_sh_e6.min(w_snap) };
    let theoretical_e6: i64 =
        ((win_clamped as i128) * (amm_ro.pps_e6 as i128) / 1_000_000i128) as i64;

    // Mirror coverage bound (accounting units)
    let mirror_bound_e6 = theoretical_e6.min(amm_ro.vault_e6.max(0));

    // Lamports availability bound (keep >= 1 SOL)
    let vault_ai = &ctx.accounts.vault_sol.to_account_info();
    let vault_lamports_now = vault_ai.lamports();
    let available_lamports = vault_lamports_now.saturating_sub(MIN_VAULT_LAMPORTS);
    let mirror_bound_lamports = e6_to_lamports(mirror_bound_e6);
    let pay_lamports = mirror_bound_lamports.min(available_lamports);

    // Early exit if nothing available after reserving 1 SOL
    if pay_lamports == 0 {
        msg!("⚠️  Reserve active: vault has {} lamports, keeping {} reserved; pay=0",
            vault_lamports_now, MIN_VAULT_LAMPORTS);
        // zero out position anyway (already settled)
        let pos_mut = &mut ctx.accounts.pos;
        pos_mut.yes_shares_e6 = 0;
        pos_mut.no_shares_e6  = 0;
        return Ok(());
    }

    // Convert actual lamports paid back to e6 for mirror accounting
    let pay_e6_effective = lamports_to_e6(pay_lamports);

    // Pay user from vault_sol (PDA signed)
    let amm_key = ctx.accounts.amm.key();
    let seeds: &[&[u8]] = &[
        Amm::VAULT_SOL_SEED,
        amm_key.as_ref(),
        core::slice::from_ref(&ctx.accounts.amm.vault_sol_bump),
    ];
    transfer_sol_signed(
        sys,
        &ctx.accounts.vault_sol.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        pay_lamports,
        &[seeds],
    )?;

    // mutate state mirrors
    let amm_mut = &mut ctx.accounts.amm;
    amm_mut.vault_e6 = amm_mut.vault_e6.saturating_sub(pay_e6_effective);

    let pos_mut = &mut ctx.accounts.pos;
    pos_mut.yes_shares_e6 = 0;
    pos_mut.no_shares_e6  = 0;

    let kept = vault_ai.lamports(); // after transfer
    msg!(
        "💸 REDEEM pay={} lamports ({:.9} SOL), kept_reserve={} lamports (~1 SOL), pps={:.6}, winner={}",
        pay_lamports,
        (pay_lamports as f64)/1e9,
        kept.min(MIN_VAULT_LAMPORTS),
        (amm_mut.pps_e6 as f64)/1_000_000.0,
        amm_mut.winner
    );
    Ok(())
}



    // ---------- CLOSE AMM (new) ----------
    pub fn close_amm(ctx: Context<CloseAmm>) -> Result<()> {
        // optional: guard so you only close after settlement & zero vault
        // require!(ctx.accounts.amm.status() == MarketStatus::Settled, ReaderError::WrongState);
        // require!(ctx.accounts.amm.vault_e6 == 0, ReaderError::BadParam);
        msg!("🧹 AMM account closed to recipient {}", ctx.accounts.recipient.key());
        Ok(()) // Anchor will perform the actual close due to `close = recipient`
    }
}

// ============================== Helpers & LMSR math ==============================

#[inline] fn sh(x: i64) -> f64 { (x as f64) / 1_000_000.0 }
#[inline] fn usd(x: i64) -> f64 { (x as f64) / 1_000_000.0 }

#[inline]
fn lmsr_cost(amm: &Amm, qy: f64, qn: f64) -> f64 {
    let b = amm.b as f64 / 1_000_000.0;
    let a = qy / b;
    let c = qn / b;
    let m = a.max(c);
    let ea = (a - m).exp();
    let ec = (c - m).exp();
    b * (m + (ea + ec).ln())
}

#[inline]
fn lmsr_p_yes(amm: &Amm) -> f64 {
    let a = ((amm.q_yes as f64) / (amm.b as f64)).exp();
    let c = ((amm.q_no  as f64) / (amm.b as f64)).exp();
    a / (a + c)
}

// ---- logging helpers ----
fn emit_trade(amm: &Amm, side: u8, action: u8, net_e6: i64, dq_e6: i64, avg_h: f64) {
    let p_yes_e6 = (lmsr_p_yes(amm) * 1_000_000.0).round() as i64;
    emit!(TradeSnapshot {
        side, action,
        net_e6, dq_e6,
        avg_price_e6: (avg_h * 1_000_000.0).round() as i64,
        q_yes: amm.q_yes, q_no: amm.q_no,
        vault_e6: amm.vault_e6,
        p_yes_e6,
        fees_e6: amm.fees,
    });
}
fn log_trade_buy(tag: &str, spend_e6: i64, shares_e6: f64, avg_h: f64, p: f64, amm: &Amm) {
    msg!("{tag}: spend=${:.6} -> shares={:.6} @avg={:.6}  pYes={:.6}",
         usd(spend_e6), shares_e6/1_000_000.0, avg_h, p);
    msg!("          qY={:.6}sh qN={:.6}sh vault=${:.6} fees=${:.6}",
         sh(amm.q_yes), sh(amm.q_no), usd(amm.vault_e6), usd(amm.fees));
}
fn log_trade_sell(tag: &str, sold_e6: f64, proceeds_e6: i64, avg_h: f64, p: f64, amm: &Amm) {
    msg!("{tag}: shares={:.6} -> proceeds=${:.6} @avg={:.6}  pYes={:.6}",
         sold_e6/1_000_000.0, usd(proceeds_e6), avg_h, p);
    msg!("          qY={:.6}sh qN={:.6}sh vault=${:.6} fees=${:.6}",
         sh(amm.q_yes), sh(amm.q_no), usd(amm.vault_e6), usd(amm.fees));
}

// ---- BUY YES ----
fn lmsr_buy_yes(amm: &mut Amm, spend_e6: i64) -> Result<(f64, f64)> {
    let fee = (spend_e6 as f64) * (amm.fee_bps as f64) / 10_000.0;
    let net_e6 = (spend_e6 as f64) - fee;
    require!(net_e6 > 0.0, ReaderError::BadParam);
    amm.fees = amm.fees.saturating_add(fee.round() as i64);

    let base = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no));
    let p = lmsr_p_yes(amm).max(1e-9);
    let mut hi = (net_e6 / 1_000_000.0 / p).min((amm.b as f64 / 1_000_000.0) * 5.0);
    if hi < 1.0 { hi = 1.0; }
    let mut lo = 0.0;
    for _ in 0..32 {
        let mid = 0.5*(lo+hi);
        let val = lmsr_cost(amm, sh(amm.q_yes)+mid, sh(amm.q_no)) - base;
        let diff = val - (net_e6/1_000_000.0);
        if diff.abs() <= 1e-9 { lo=mid; hi=mid; break; }
        if diff < 0.0 { lo=mid; } else { hi=mid; }
    }
    let dq_h = 0.5*(lo+hi);
    let dq_e6_f = (dq_h * 1_000_000.0).max(0.0);
    let dq_i = dq_e6_f.round() as i64;

    require!(dq_i <= DQ_MAX_E6, ReaderError::BadParam);

    amm.q_yes = amm.q_yes.saturating_add(dq_i);
    amm.vault_e6 = amm.vault_e6.saturating_add(net_e6.round() as i64);

    let avg_h = (net_e6 / dq_e6_f).max(0.0);
    Ok((dq_e6_f, avg_h))
}

// ---- BUY NO ----
fn lmsr_buy_no(amm: &mut Amm, spend_e6: i64) -> Result<(f64, f64)> {
    let fee = (spend_e6 as f64) * (amm.fee_bps as f64) / 10_000.0;
    let net_e6 = (spend_e6 as f64) - fee;
    require!(net_e6 > 0.0, ReaderError::BadParam);
    amm.fees = amm.fees.saturating_add(fee.round() as i64);

    let base = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no));
    let p_no = (1.0 - lmsr_p_yes(amm)).max(1e-9);
    let mut hi = (net_e6 / 1_000_000.0 / p_no).min((amm.b as f64 / 1_000_000.0) * 5.0);
    if hi < 1.0 { hi = 1.0; }
    let mut lo = 0.0;
    for _ in 0..32 {
        let mid = 0.5*(lo+hi);
        let val = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no)+mid) - base;
        let diff = val - (net_e6/1_000_000.0);
        if diff.abs() <= 1e-9 { lo=mid; hi=mid; break; }
        if diff < 0.0 { lo=mid; } else { hi=mid; }
    }
    let dq_h = 0.5*(lo+hi);
    let dq_e6_f = (dq_h * 1_000_000.0).max(0.0);
    let dq_i = dq_e6_f.round() as i64;

    require!(dq_i <= DQ_MAX_E6, ReaderError::BadParam);

    amm.q_no = amm.q_no.saturating_add(dq_i);
    amm.vault_e6 = amm.vault_e6.saturating_add(net_e6.round() as i64);

    let avg_h = (net_e6 / dq_e6_f).max(0.0);
    Ok((dq_e6_f, avg_h))
}

// ---- SELL YES ----
fn lmsr_sell_yes(amm: &mut Amm, shares_e6: i64) -> Result<(i64, f64, f64)> {
    let req = shares_e6.max(0);
    let sell_e6 = req.min(amm.q_yes);
    if sell_e6 <= 0 { return Ok((0, 0.0, 0.0)); }

    let pre  = lmsr_cost(amm, sh(amm.q_yes),           sh(amm.q_no));
    let post = lmsr_cost(amm, sh(amm.q_yes - sell_e6), sh(amm.q_no));
    let mut gross_h = pre - post;
    if !gross_h.is_finite() || gross_h < 0.0 { gross_h = 0.0; }

    let gross_e6_f = gross_h * 1_000_000.0;
    let fee_e6_f   = (gross_e6_f * (amm.fee_bps as f64) / 10_000.0).max(0.0);
    let net_e6_f   = (gross_e6_f - fee_e6_f).max(0.0);

    let fee_e6 = fee_e6_f.round() as i64;
    let net_e6 = net_e6_f.round() as i64;

    amm.fees  = amm.fees.saturating_add(fee_e6);
    amm.q_yes = amm.q_yes.saturating_sub(sell_e6);
    amm.vault_e6 = amm.vault_e6.saturating_sub(net_e6);

    let avg_h = if sell_e6 > 0 { (net_e6_f / (sell_e6 as f64)) / 1_000_000.0 } else { 0.0 };
    Ok((net_e6, avg_h, sell_e6 as f64))
}

// ---- SELL NO ----
fn lmsr_sell_no(amm: &mut Amm, shares_e6: i64) -> Result<(i64, f64, f64)> {
    let req = shares_e6.max(0);
    let sell_e6 = req.min(amm.q_no);
    if sell_e6 <= 0 { return Ok((0, 0.0, 0.0)); }

    let pre  = lmsr_cost(amm, sh(amm.q_yes),           sh(amm.q_no));
    let post = lmsr_cost(amm, sh(amm.q_yes),           sh(amm.q_no - sell_e6));
    let mut gross_h = pre - post;
    if !gross_h.is_finite() || gross_h < 0.0 { gross_h = 0.0; }

    let gross_e6_f = gross_h * 1_000_000.0;
    let fee_e6_f   = (gross_e6_f * (amm.fee_bps as f64) / 10_000.0).max(0.0);
    let net_e6_f   = (gross_e6_f - fee_e6_f).max(0.0);

    let fee_e6 = fee_e6_f.round() as i64;
    let net_e6 = net_e6_f.round() as i64;

    amm.fees = amm.fees.saturating_add(fee_e6);
    amm.q_no = amm.q_no.saturating_sub(sell_e6);
    amm.vault_e6 = amm.vault_e6.saturating_sub(net_e6);

    let avg_h = if sell_e6 > 0 { (net_e6_f / (sell_e6 as f64)) / 1_000_000.0 } else { 0.0 };
    Ok((net_e6, avg_h, sell_e6 as f64))
}

// ============================== SOL helpers ==============================


/// Keep at least 1 SOL in the vault at all times.
const MIN_VAULT_LAMPORTS: u64 = 1_000_000_000; // 1 SOL

/// How many lamports we move per 1e6 "credits".
const LAMPORTS_PER_E6: u64 = 1;

#[inline]
fn e6_to_lamports(x_e6: i64) -> u64 {
    if x_e6 <= 0 { 0 } else {
        let xe = x_e6 as i128;
        (xe * (LAMPORTS_PER_E6 as i128)) as u64
    }
}

#[inline]
fn lamports_to_e6(l: u64) -> i64 {
    // integer floor conversion (mirror accounting is in e6 units)
    (l as i128 / LAMPORTS_PER_E6 as i128) as i64
}

fn transfer_sol<'info>(
    system_program: &Program<'info, System>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 { return Ok(()); }
    let ix = system_instruction::transfer(from.key, to.key, amount);
    invoke(&ix, &[from.clone(), to.clone(), system_program.to_account_info()])?;
    Ok(())
}

fn transfer_sol_signed<'info>(
    system_program: &Program<'info, System>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 { return Ok(()); }
    let ix = system_instruction::transfer(from.key, to.key, amount);
    invoke_signed(&ix, &[from.clone(), to.clone(), system_program.to_account_info()], seeds)?;
    Ok(())
}

// ============================== Errors ==============================
#[error_code]
pub enum ReaderError {
    #[msg("oracle_state owned by wrong program")] WrongOwner,
    #[msg("oracle_state data too small")]         DataTooSmall,
    #[msg("failed to deserialize oracle state")]  DeserializeFail,
    #[msg("bad parameter")]                       BadParam,
    #[msg("market is closed")]                    MarketClosed,
    #[msg("wrong market state for this action")]  WrongState,
    #[msg("not the owner of this position")]      NotOwner,
    #[msg("insufficient shares")]                 InsufficientShares,
    #[msg("insufficient coverage")]               NoCoverage,
}

