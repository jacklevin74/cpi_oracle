#!/usr/bin/env bash

# -------- Config (edit as needed) --------
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
# Optional: send fees here (System account pubkey)
# export FEE_DEST=""

JS="app/trade.js"
ADMIN="./userA.json"
WALLETS="./userA.json,./userB.json,./userC.json,./userD.json,./userE.json"

# ORACLE **STATE** ACCOUNT (NOT the program id)
ORACLE="${ORACLE:-4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq}"

reopen() {
  echo "# close (ignore errors if AMM can't deserialize/doesn't exist)"
  ANCHOR_WALLET="$ADMIN" node "$JS" close || true

  echo "# init fresh market: b=500, fee=25 bps"
  ANCHOR_WALLET="$ADMIN" node "$JS" init 500 25

  echo "# ensure trader positions exist"
  ANCHOR_WALLET=./userA.json node "$JS" init-pos
  ANCHOR_WALLET=./userB.json node "$JS" init-pos
  ANCHOR_WALLET=./userC.json node "$JS" init-pos
  ANCHOR_WALLET=./userD.json node "$JS" init-pos
  ANCHOR_WALLET=./userE.json node "$JS" init-pos

  echo "# (optional) take start snapshot now; run also snapshots if missing"
  ANCHOR_WALLET="$ADMIN" node "$JS" snapshot-start --oracle "$ORACLE" -S || true
}

echo "# --- reopen + run (mixed / oracle-driven one test) ---"
reopen

# Run a single short test:
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
  --pretty --simple

