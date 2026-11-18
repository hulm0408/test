🟡 GOLD DROP LOCAL — poora system tumhare PC par
================================================

KYA HAI YE:
  START dabate hi tumhara apna Chrome khulta hai (LIVE — tum dekh sakte ho),
  form khud bharta hai (naam/email/PIN/batch code/photo), SECURITY CHECK
  (Cloudflare Turnstile) ko peak.fo API se khud solve karta hai, OTP step par
  tumse OTP maangta hai, aur verify karta hai. Sab kuch tumhare PC par — koi
  server nahi, koi Render nahi. Ghar ka IP + asli desktop Chrome + peak.fo
  solver = "Security check — 1 min wait, retry" wala phase khatam.

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
  2. "Peak.fo API key" — tumhari key pehle se bhari hai. Page khulte hi
     neeche balance/solves count dikhega (matlab key kaam kar rahi hai).
     Sirf successful solves ka charge lagta hai (~$0.0012 per solve).
  3. "Kitne numbers process karne hain" set karo → ▶ START dabao.
  4. App mobile number maangega → apne OTP bot (Hermes/Hathi jo bhi) se
     NEW NUMBER lo aur yahan daalo → browser me registration + OTP bheja jayega.
     Agar beech me security check aaya to app khud peak.fo se solve kar dega
     (log me "Security check SOLVED (peak.fo)" dikhega).
  5. OTP tumhare OTP bot me aayega → yahan type karo → verify ho jayega.
  6. Har number ka result neeche list me aata jayega. Target poora hone
     tak repeat.
  7. Reward SMS tumhare OTP bot ke number par aata hai (jaisa pehle tha) —
     wo Telegram me hi dikhega.

IMPORTANT:
  - Browser window ko band mat karo jab tak run chal raha hai.
  - Security check (Turnstile) peak.fo se auto-solve hota hai — key galat ho
    ya balance khatam ho to log me saaf warning aayegi, aur agar interactive
    checkbox aa jaye to use khud click kar sakte ho (app ruk nahi jata).
  - Peak.fo key change karni ho to form me edit karo, ya PEAK_API_KEY env
    var set karo.
  - Chrome na mile to: GOLD_DROP_CHROME env var me chrome.exe ka full path do.
  - Port badalna ho: GOLD_DROP_LOCAL_PORT=8080 npm start

FILES:
  gold-drop-local.js   — poora app (server + browser driver)
  package.json         — dependencies (puppeteer-real-browser)
  start-windows.bat    — Windows double-click starter
  start-mac-linux.sh   — Mac/Linux starter
  assets/              — default pack photo
