🟡 GOLD DROP LOCAL — poora system tumhare PC par
================================================

KYA HAI YE:
  START dabate hi tumhara apna Chrome khulta hai (LIVE — tum dekh sakte ho),
  form khud bharta hai (naam/email/PIN/batch code/photo), OTP step par tumse
  OTP maangta hai, aur verify karta hai. Sab kuch tumhare PC par — koi server
  nahi, koi Render nahi. Ghar ka IP + asli desktop Chrome = security check
  sabse aasaani se paas hota hai.

SETUP (sirf pehli baar, 2 minute):
  1. Node.js 20+ install karo: https://nodejs.org (LTS version)
  2. Google Chrome installed hona chahiye (PC par already hoga)
  3. Is folder me terminal/command prompt kholo aur chalao:
       npm install
       npm start
     (Windows par seedha start-windows.bat double-click bhi kar sakte ho)
  4. Browser me kholo:  http://localhost:3737

USE KAISE KARNA HAI:
  1. Form me details check karo (naam, email, PIN, batch code) — bot wali
     values pehle se bhari hain, badal sakte ho. Pack photo optional hai.
  2. "Kitne numbers process karne hain" set karo → ▶ START dabao.
  3. App mobile number maangega → apne OTP bot (Hermes/Hathi jo bhi) se
     NEW NUMBER lo aur yahan daalo → browser me registration + OTP bheja jayega.
  4. OTP tumhare OTP bot me aayega → yahan type karo → verify ho jayega.
  5. Har number ka result neeche list me aata jayega. Target poora hone
     tak repeat.
  6. Reward SMS tumhare OTP bot ke number par aata hai (jaisa pehle tha) —
     wo Telegram me hi dikhega.

IMPORTANT:
  - Browser window ko band mat karo jab tak run chal raha hai.
  - Agar site captcha dikhaye: asli Chrome + ghar ke IP par wo aam taur par
    khud pass ho jata hai. Kabhi interactive checkbox aa jaye to use khud
    click karna padega (app jaan-boojh kar captcha solve nahi karta).
  - Chrome na mile to: GOLD_DROP_CHROME env var me chrome.exe ka full path do.
  - Port badalna ho: GOLD_DROP_LOCAL_PORT=8080 npm start

FILES:
  gold-drop-local.js   — poora app (server + browser driver)
  package.json         — dependencies (puppeteer-real-browser)
  start-windows.bat    — Windows double-click starter
  start-mac-linux.sh   — Mac/Linux starter
  assets/              — default pack photo
