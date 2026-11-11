#!/bin/sh
# Proves that classic (non-advanced) matches are bit-identical to the reference recorded before advanced mode.
# Usage: sh tools/classic-check.sh      (prints CLASSIC OK or a diff)
cd "$(dirname "$0")/.." || exit 1
npx tsx tools/headless.ts 2500 proc 3 2>&1 | grep -v "avg=" > /tmp/capture-classic-now.txt
if diff tools/classic-baseline.txt /tmp/capture-classic-now.txt > /tmp/capture-classic-diff.txt; then echo "CLASSIC OK"; else echo "CLASSIC CHANGED:"; head -20 /tmp/capture-classic-diff.txt; exit 1; fi
