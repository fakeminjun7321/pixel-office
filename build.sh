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
  for f in config i18n markdown tools workspace pixelart world api store agents orchestrator graph palette onboarding audio share ui main; do
    [ -f "src/$f.js" ] || continue   # optional feature modules (added across waves)
    echo "<script>"
    cat "src/$f.js"
    echo "</script>"
  done
  echo '</body>'
  echo '</html>'
} > "$OUT"
echo "built $OUT ($(wc -l < "$OUT") lines, $(wc -c < "$OUT") bytes)"
# Hazard check: literal </script /<script /<!-- in a module breaks single-file inlining
# (the HTML parser closes/double-escapes the inlined <script>). Modules must split these.
haz=$(grep -lE '</script|<!--' src/*.js 2>/dev/null || true)
if [ -n "$haz" ]; then echo "WARN: HTML-tokenizer literal (</script or <!--) in: $haz — split it (e.g. '</scr'+'ipt')"; fi
true
