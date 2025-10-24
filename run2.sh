#!/usr/bin/env bash

# Path shortcuts
JS="app/trade.js"
ADMIN="./userA.json"
WALLETS="./userA.json,./userB.json,./userC.json,./userD.json,./userE.json"

reopen() {
  # Close if exists, then init fresh market with b=500 and fee 25 bps
  ANCHOR_WALLET="$ADMIN" node "$JS" close || true
  ANCHOR_WALLET="$ADMIN" node "$JS" init 500 25
  # Create (or no-op) positions for all users
  ANCHOR_WALLET=./userA.json node "$JS" init-pos
  ANCHOR_WALLET=./userB.json node "$JS" init-pos
  ANCHOR_WALLET=./userC.json node "$JS" init-pos
  ANCHOR_WALLET=./userD.json node "$JS" init-pos
  ANCHOR_WALLET=./userE.json node "$JS" init-pos
}

echo "# --- reopen + run (mixed / auto) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode mixed \
  --sell-prob 0.25 --sell-frac 0.30 --winner auto \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

echo "# --- reopen + run (trend / auto) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode trend \
  --sell-prob 0.25 --sell-frac 0.30 --winner auto \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

echo "# --- reopen + run (meanrevert / auto) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode meanrevert \
  --sell-prob 0.40 --sell-frac 0.25 --winner auto \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

echo "# --- reopen + run (random / auto) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode random \
  --sell-prob 0.20 --sell-frac 0.50 --winner auto \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

echo "# --- reopen + run (mixed / force YES) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode mixed \
  --sell-prob 0.30 --sell-frac 0.33 --winner yes \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

echo "# --- reopen + run (mixed / force NO) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode mixed \
  --sell-prob 0.30 --sell-frac 0.33 --winner no \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

echo "# --- reopen + run (mixed / auto, higher sell prob) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode mixed \
  --sell-prob 0.35 --sell-frac 0.40 --winner auto \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

echo "# --- reopen + run (trend / auto, lighter sells) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode trend \
  --sell-prob 0.15 --sell-frac 0.20 --winner auto \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

echo "# --- reopen + run (mixed / auto, heavy sells) ---"
reopen
node "$JS" run --wallets "$WALLETS" --steps 10 --mode mixed \
  --sell-prob 0.50 --sell-frac 0.50 --winner auto \
  --on-closed reinit --reinit-fee-bps 25 --pretty --simple

