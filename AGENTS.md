# Repository Guidelines

## Project Structure & Module Organization
- `programs/cpi_oracle/` holds the Anchor program; keep new instructions in `src/lib.rs` and update `Cargo.toml` if you add crates.
- `tests/` contains TypeScript integration specs that drive `anchor test`.
- `app/` bundles operational scripts for market bots and settlement utilities; treat them as reference clients when extending instruction flows.
- `web/` serves monitoring and migration tooling (`server.js` and `public/` assets) and ships its own `package.json`.
- `migrations/` and shell scripts at the repo root encapsulate deployment automation; adjust them alongside program changes.

## Build, Test, and Development Commands
- `anchor build` compiles the Rust program into `target/deploy/` using the settings in `Anchor.toml`.
- `anchor test` spins up a local validator, runs migrations, and executes the specs under `tests/`.
- `anchor deploy` publishes the build to the cluster configured in `Anchor.toml`—run only after verifying on devnet.
- `npm run lint` (and `npm run lint:fix`) applies Prettier to all JS/TS clients, including `web/` and `app/`.
- `cargo fmt` keeps Rust sources consistent before commit; pair with `cargo clippy --workspace` when touching program logic.

## Coding Style & Naming Conventions
Rust follows the standard Anchor patterns (`#[derive(Accounts)]`, `ctx.accounts`); prefer module-level helper functions over macros. Use snake_case for functions and PascalCase for accounts/events. JavaScript and TypeScript clients should remain Prettier-compliant (2-space indentation, double quotes per current files) and keep async workflows `async/await` based. Name scripts descriptively, e.g., `settlement_bot.js`, and place shared constants under `app/` or `web/` as context dictates.

## Testing Guidelines
Integration tests live in `tests/` and run with Mocha via Anchor. Mirror instruction names in `describe` blocks and use focused `it("...")` cases that assert both happy path and failure behaviour. When adding programs, seed fixtures with deterministic keypairs to keep signatures reproducible. Update expected logs or JSON fixtures under `web/` when price feeds or market states change. Aim for coverage across initialization, authority checks, and cross-program invocations before requesting review.

## Commit & Pull Request Guidelines
Write concise, imperative commit subjects (e.g., “Add withdrawal destination verification”) and stage related changes together. Every pull request should include: purpose summary, testing notes (`anchor test`, lint, or scripts run), and links to relevant monitoring dashboards or issues. Attach screenshots or log excerpts when modifying operational scripts or the web monitor. Confirm migrations and bots still run with the new build before marking the PR ready for review.
