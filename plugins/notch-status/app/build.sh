#!/bin/zsh
# Compile ClaudeNotch.app dans app/build/. Avec --run, relance l'app.
set -euo pipefail

here=${0:A:h}
app=$here/build/ClaudeNotch.app

rm -rf $app
mkdir -p $app/Contents/MacOS
swiftc -O -swift-version 5 -target arm64-apple-macos14.0 \
  $here/Sources/main.swift -o $app/Contents/MacOS/ClaudeNotch
cp $here/Info.plist $app/Contents/Info.plist
codesign --force --sign - $app >/dev/null 2>&1
echo "Compilé : $app"

if [[ ${1:-} == --run ]]; then
  pkill -x ClaudeNotch 2>/dev/null || true
  sleep 0.5
  open -g $app
  echo "Lancé."
fi
