# ----- ENV / VARS -----
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"   # or your RPC
export NO_COLOR=        # leave empty to enable colors

JS="app/trade.js"
ADMIN="./userA.json"
WALLETS="./userA.json,./userB.json,./userC.json,./userD.json,./userE.json"

# ORACLE *STATE* ACCOUNT (NOT the program id!)
ORACLE="4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq"

# Optional: send fees to a specific System account
# export FEE_DEST="YourFeeDestPubkey"

# ----- helpers -----
reopen() {
  # close any existing market (ignore error if not present)
  ANCHOR_WALLET="$ADMIN" node "$JS" close || true

  # init fresh market: b=500 (shares, 1e6 scale) and 25 bps fee
  ANCHOR_WALLET="$ADMIN" node "$JS" init 500 25

  # ensure all trader positions exist
  ANCHOR_WALLET=./userA.json node "$JS" init-pos
  ANCHOR_WALLET=./userB.json node "$JS" init-pos
  ANCHOR_WALLET=./userC.json node "$JS" init-pos
  ANCHOR_WALLET=./userD.json node "$JS" init-pos
  ANCHOR_WALLET=./userE.json node "$JS" init-pos

  # (optional) take the start snapshot immediately via oracle;
  # run will also auto-snapshot at start if missing.
  ANCHOR_WALLET="$ADMIN" node "$JS" snapshot-start --oracle "$ORACLE" -S || true
}

echo "# --- reopen + run (mixed / oracle-driven) ---"
reopen

# YES wins on >= (default). Prints BTC + human clock in simple mode.
node "$JS" run \
  --wallets "$WALLETS" \
  --steps 10 \
  --mode mixed \
  --sell-prob 0.25 \
  --sell-frac 0.30 \
  --winner auto \
  --on-closed reinit \
  --reinit-fee-bps 25 \
  --oracle "$ORACLE" \
  --pretty --simple -v

# # If you want strict 'YES only if > start', use this variant:
# node "$JS" run \
#   --wallets "$WALLETS" \
#   --steps 10 \
#   --mode mixed \
#   --sell-prob 0.25 \
#   --sell-frac 0.30 \
#   --winner auto \
#   --on-closed reinit \
#   --reinit-fee-bps 25 \
#   --oracle "$ORACLE" \
#   --gt-wins-yes \
#   --pretty --simple -v

