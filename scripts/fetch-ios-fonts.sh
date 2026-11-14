#!/bin/bash
# iOS ships no Chinese serif or kai typeface (only PingFang), so the iPhone /
# iPad app bundles two open ones. They are ~50 MB together and therefore not
# kept in the repository — run this once before building the iOS app.
#
#   Noto Serif SC   (SIL Open Font License 1.1)  https://github.com/google/fonts
#   LXGW WenKai     (SIL Open Font License 1.1)  https://github.com/lxgw/LxgwWenKai
set -euo pipefail
cd "$(dirname "$0")/../ios"
mkdir -p Fonts

fetch() {
    local file="$1" url="$2"
    if [ -s "Fonts/$file" ]; then echo "have $file"; return; fi
    echo "fetching $file…"
    curl -fL --retry 3 -o "Fonts/$file.part" "$url"
    mv "Fonts/$file.part" "Fonts/$file"
}

fetch NotoSerifSC.ttf "https://github.com/google/fonts/raw/2e61f4355afd22b801791b0df176065082423b87/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf"
fetch LXGWWenKai-Regular.ttf "https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf"
ls -lh Fonts
