@echo off
cd /d %~dp0
echo Gold Drop Local shuru ho raha hai...
if not exist node_modules (
  echo Pehli baar: dependencies install ho rahi hain (1-2 min)...
  call npm install
)
node gold-drop-local.js
pause
