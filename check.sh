#!/usr/bin/env bash
# check.sh — validate PosePro the way the BROWSER will, not the way Node guesses.
#
# ⛔ WHY THIS EXISTS (2026-10-27, the v1.8.8 outage):
# I ran `node --check app.js` before every deploy for weeks and it reported
# "SYNTAX OK" on a file that did not parse. app.js contains an `import`
# statement and is loaded by <script type="module">, but Node treats a bare
# .js file as CommonJS — it hit the import, bailed, and exited 0 BEFORE
# reaching the real error.
#
#   broken app.js, node --check app.js          -> exit 0   FALSE PASS
#   broken app.js, node --check /tmp/x.mjs      -> exit 1   correct
#
# So every "SYNTAX OK" printed in this project before that date came from a
# check that could not see the bug it was there to catch. Two shipped outages
# came from patches that ate a newline or glued a character onto a brace.
#
# THE RULE: a file with an `import` is a MODULE. Check it as one.
#
# Run this BEFORE every commit that touches app.js. Exit non-zero = do not ship.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

fail=0

echo "── ESM syntax check (app.js is type=module) ─────────────────────"
tmp="$(mktemp -d)"
cp app.js "$tmp/app.mjs"
if node --check "$tmp/app.mjs" 2>"$tmp/err"; then
  echo "  app.js           OK"
else
  echo "  app.js           FAIL"
  sed -n '1,12p' "$tmp/err" | sed 's/^/    /'
  fail=1
fi

echo "── classic-script syntax check ─────────────────────────────────"
for f in version.js zip.js pose-gates.js sw.js; do
  [ -f "$f" ] || continue
  cp "$f" "$tmp/x.js"
  if node --check "$tmp/x.js" >/dev/null 2>&1; then
    echo "  $f           OK"
  else
    echo "  $f           FAIL"
    fail=1
  fi
done

echo "── glued-line scan (the actual outage) ─────────────────────────"
# The 2026-10-27 outage was `}` followed immediately by a box-drawing comment
# rule on line 292 — a patch ate the newline. Two tests:
#   1. any `}` or `]` followed by a box-drawing char (U+2500–257F)
#   2. a line STARTING with `}` then a non-separator, keyword included
# ⚠️ Do NOT test a bare `}` + letter anywhere: `${x}s` inside a template literal
# is legitimate and produced four false positives on 2026-10-27.
hits=$(grep -nP '[}\]](\x{2500}-\x{257F})' app.js pose-gates.js zip.js 2>/dev/null || true)
hits2=$(grep -nP '^}[^\s;),]' app.js pose-gates.js zip.js 2>/dev/null || true)
hits=$(printf '%s\n%s\n' "$hits" "$hits2" | grep -v '^$' || true)
if [ -n "$hits" ]; then
  echo "  ⛔ FOUND:"
  echo "$hits" | sed 's/^/    /'
  fail=1
else
  echo "  none"
fi

echo "── non-ASCII outside comments/strings (warning only) ───────────"
nonascii=$(grep -nP '^[^/\n]*[^\x00-\x7F]' app.js 2>/dev/null | grep -vP ':\s*//' | head -5 || true)
[ -n "$nonascii" ] && echo "$nonascii" | sed 's/^/    /' || echo "  none"

rm -rf "$tmp"
echo
if [ "$fail" -ne 0 ]; then
  echo "⛔ DO NOT SHIP."
  exit 1
fi
echo "✅ All checks pass — safe to commit."
