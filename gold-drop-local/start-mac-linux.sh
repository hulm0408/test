#!/bin/sh
cd "$(dirname "$0")"
echo "Gold Drop Local shuru ho raha hai..."
if [ ! -d node_modules ]; then
  echo "Pehli baar: dependencies install ho rahi hain (1-2 min)..."
  npm install
fi
exec node gold-drop-local.js
