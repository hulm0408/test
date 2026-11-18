# 🟡 Gold Drop — Vercel (direct API, koi browser nahi)

drop.py method: `POST /api/users {}` → HMAC signed token → multipart register → verify-otp.
Security check aaye to NoCaptchaAI se auto-solve. State per warm instance memory me — same
instance reuse hota hai (Vercel default), warna "Session expire" message ke saath number dobara.

## Deploy
Vercel Dashboard → New Project → repo `hulm0408/workwr` → **Root Directory: `gold-drop-vercel`** → Deploy.

Env (optional): `NOCAP_API_KEY` — UI field override karti hai.

## Local test
```
node api/index.js   # http://localhost:3737
```
