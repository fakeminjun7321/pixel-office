#!/bin/bash
# Deterministic assembly: concatenate src modules into a single self-contained index.html.
# Load order is fixed (config first, main last). Run: bash build.sh
set -e
cd "$(dirname "$0")"
OUT=index.html
{
  echo '<!DOCTYPE html>'
  echo '<html lang="ko">'
  echo '<head>'
  echo '<meta charset="utf-8">'
  echo '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">'
  echo '<title>PIXEL AI COMPANY — NEON//WORKS</title>'
  echo '<style>'
  cat src/styles.css
  echo '</style>'
  echo '</head>'
  echo '<body>'
  cat src/shell.html
  for f in config i18n markdown tools pixelart world api store agents orchestrator graph palette onboarding ui main; do
    [ -f "src/$f.js" ] || continue   # optional feature modules (added across waves)
    echo "<script>"
    cat "src/$f.js"
    echo "</script>"
  done
  echo '</body>'
  echo '</html>'
} > "$OUT"
echo "built $OUT ($(wc -l < "$OUT") lines, $(wc -c < "$OUT") bytes)"
