#!/bin/bash
# Run JavaScript inside a running debug build and print the result.
#
#   INKSTONE_DEBUG=/tmp/inkdbg build/Inkstone.app/Contents/MacOS/Inkstone &
#   scripts/debug-eval.sh 'return document.title'
#
# The script is the body of an async function. A snapshot of the web view is
# written next to the result as shot.png.
set -euo pipefail
DIR="${INKSTONE_DEBUG:-/tmp/inkdbg}"
rm -f "$DIR/result.json"
printf '%s' "$1" > "$DIR/cmd.tmp"
mv "$DIR/cmd.tmp" "$DIR/cmd.js"
for _ in $(seq 1 240); do
    if [ -f "$DIR/result.json" ]; then
        cat "$DIR/result.json"
        echo
        exit 0
    fi
    sleep 0.25
done
echo "timed out waiting for the app" >&2
exit 1
