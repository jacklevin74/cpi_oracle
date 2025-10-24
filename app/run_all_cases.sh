#!/usr/bin/env bash
# app/run_all_cases.sh
# Run the full suite of trade.js cases with steps=12 (for run-style cases),
# capture logs per case, and print a summary at the end.

set -euo pipefail

# ----------- Inputs -----------
ADMIN="${1:-./userA.json}"
A="${2:-./userA.json}"
B="${3:-./userB.json}"

TRADE="node app/trade.js"
STEPS=12
LOGDIR="logs"

mkdir -p "$LOGDIR"

# ----------- Helpers -----------
banner () { printf "\n============== %s ==============\n" "$*"; }

reset_market () {
  ANCHOR_WALLET="$ADMIN" $TRADE close || true
  ANCHOR_WALLET="$ADMIN" $TRADE init 500000 25
  ANCHOR_WALLET="$A"     $TRADE init-pos
  ANCHOR_WALLET="$B"     $TRADE init-pos
}

# Put market into a CLOSED state intentionally (to test on-closed handlers)
close_market_hard () {
  ANCHOR_WALLET="$ADMIN" $TRADE stop             || true
  ANCHOR_WALLET="$ADMIN" $TRADE settle yes       || true
  ANCHOR_WALLET="$A"     $TRADE redeem           || true
  ANCHOR_WALLET="$B"     $TRADE redeem           || true
  ANCHOR_WALLET="$ADMIN" $TRADE close            || true
}

# Run a command, write log, and classify PASS/FAIL by parsing the output
# PASS criteria:
#   - exit code 0
#   - contains "FINAL TALLY"
#   - contains "[PASS] vault drop equals on-chain sum payouts"
run_case () {
  local label="$1"; shift
  local logfile="$LOGDIR/$label.log"

  banner "$label"
  # shellcheck disable=SC2068
  if ! "$@" 2>&1 | tee "$logfile"; then
    echo ">>> ❌ FAILED: $label (non-zero exit)"
    echo "FAIL" > "$logfile.status"
    return
  fi

  if ! grep -q "FINAL TALLY" "$logfile"; then
    echo ">>> ❌ FAILED: $label (no FINAL TALLY)"
    echo "FAIL" > "$logfile.status"
    return
  fi

  if ! grep -q "\[PASS\] vault drop equals on-chain sum payouts" "$logfile"; then
    echo ">>> ❌ FAILED: $label (vault drop reconcile check failed)"
    echo "FAIL" > "$logfile.status"
    return
  fi

  echo ">>> ✅ PASSED: $label"
  echo "PASS" > "$logfile.status"
}

# ----------- Suite -----------
declare -a CASES
declare -A CMD

# 01 mixed (auto)
CASES+=("01_mixed_auto")
CMD["01_mixed_auto"]="$TRADE run --wallets $A,$B --steps $STEPS --mode mixed --sell-prob 0.30 --sell-frac 0.35 --winner auto --pretty -v"

# 02 trend (auto)
CASES+=("02_trend_auto")
CMD["02_trend_auto"]="$TRADE run --wallets $A,$B --steps $STEPS --mode trend --sell-prob 0.25 --sell-frac 0.30 --winner auto --pretty -v"

# 03 meanrevert (auto)
CASES+=("03_meanrevert_auto")
CMD["03_meanrevert_auto"]="$TRADE run --wallets $A,$B --steps $STEPS --mode meanrevert --sell-prob 0.40 --sell-frac 0.25 --winner auto --pretty -v"

# 04 random (auto)
CASES+=("04_random_auto")
CMD["04_random_auto"]="$TRADE run --wallets $A,$B --steps $STEPS --mode random --sell-prob 0.20 --sell-frac 0.50 --winner auto --pretty -v"

# 05 forced YES
CASES+=("05_forced_yes")
CMD["05_forced_yes"]="$TRADE run --wallets $A,$B --steps $STEPS --mode mixed --sell-prob 0.30 --sell-frac 0.33 --winner yes --pretty -v"

# 06 forced NO
CASES+=("06_forced_no")
CMD["06_forced_no"]="$TRADE run --wallets $A,$B --steps $STEPS --mode mixed --sell-prob 0P1+r[24~\P0+r\P0+r\P1+r\P0+r\P1+r[3~\P1+rOH\P1+rOF\P1+r[5~\.30 --sell-frac 0.33 --winner no --pretty -v"

# 07 closed → reinit (start closed)
CASES+=("07_closed_reinit")
CMD["07_closed_reinit"]="$TRADE run --wallets $A,$B --steps $STEPS --mode mixed --sell-prob 0.35 --sell-frac 0.40 --winner auto --on-closed reinit --reinit-fee-bps 25 --pretty -v"

# 08 closed → skip (start closed)
CASES+=("08_closed_skip")
CMD["08_closed_skip"]="$TRADE run --wallets $A,$B --steps $STEPS --mode mixed --sell-prob 0.35 --sell-frac 0.40 --winner auto --on-closed skip --pretty -v"

# 09 test-pps-yes1 (uses iters, not steps) — shorten to a quick run
CASES+=("09_test_pps_yes1")
CMD["09_test_pps_yes1"]="$TRADE test-pps-yes1 --wallets $A,$B --yes-usd 10 --no-usd 180 --iters 60 --pretty -v"

# 10 random-duel (legacy path) — use smaller N anaP1+r[6~\logous to ~steps
CASES+=("10_random_duel")
CMD["10_random_duel"]="$TRADE test-random-duel --wallets $A,$B --n 120 --a-yes-prob 0.65 --b-no-prob 0.65 --min-usd 5 --max-usd 150 --force-winner auto --pretty -v"

# 11 unit: single wallet
CASES+=("11_unit_single")
CMD["11_unit_single"]="ANCHOR_WALLET=$ADMIN $TRADE test --pretty -v"

# 12 unit: two wallets
CASES+=("12_unit_two")
CMD["12_unit_two"]="$TRADE test2 --wallets $A,$B --pretty -v"

# ----------- Execute -----------
PASS=0
FAIL=0

for case in "${CASES[@]}"; do
  # Fresh vs closed starts
  if [[ "$case" == "07_closed_reinit" || "$case" == "08_closed_skip" ]]; then
    banner "PREP (start closed): $case"
    close_market_hard
  else
    banner "PREP (fresh): $case"
    reset_market
  fi

  # Run the case
  # shellcheck disable=SC2086
  run_case "$case" bash -lc "${CMD[$case]}"

  if [[ -f "$LOGDIR/$case.log.status" ]]; then
    status="$(cat "$LOGDIR/$case.log.status")"
  else
    status="$(cat "$LOGDIR/$case.log.status" 2>/dev/null || echo FAIL)"
  fi

  if [[ "$status" == "PASS" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
  fi
done

# ----------- Summary -----------
banner "SUMMARY"
printf "Total: %d  |  PASS: %d  |  FAIL: %d\n" "$((PASS+FAIL))" "$PASS" "$FAIL"
printf "\n%-22s  %s\n" "Case" "Status"
printf -- "----------------------------------------\n"
for case in "${CASES[@]}"; do
  status="$(cat "$LOGDIR/$case.log.status" 2>/dev/null || echo FAIL)"
  label_display="${case//_/ }"
  printf "%-22s  %s\n" "$label_display" "$status"
done

# Exit non-zero if any failed
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi

