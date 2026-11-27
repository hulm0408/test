# 🌐 Toing Pro — 50-Slot Parallel Railway Engine

Lightweight standalone Railway deployment built purely for **high-throughput, consistent Toing Pro Web (`storelex.store/toing_web`) account creation & `.json` delivery** (target: **20+ accounts/minute consistently**, scales up to **50 parallel independent Telegram OTP accounts**).

- **Zero bloat:** No Blinkit, Zepto, Fresh, GoldDrop, Swiggy Bridge, World Bot, Chrome, Python, or `@its_shop_bot`.
- **Tiny Docker build:** `node:22-bookworm-slim` + 3 npm deps (`telegraf`, `teleproto`, `dotenv`) + built-in `node:sqlite` (WAL). Builds in ~15 seconds.
- **100% isolated from `hulm0408/workwr`:** Lives strictly inside `hulm0408/test/toing-railway/`.

---

## 🔥 Why Throughput Is Consistent (Fixes Over Old Single-Slot Flow)

1. **50 Independent Per-Slot MTProto Clients:** No global `TelegramClient` singleton or shared lock. Every slot has its own client, mutex, OTP bot entity, health state, and retry loop.
2. **Pre-`send_otp` Watermark Fix:** Old `toing-pro-engine.js` captured the OTP watermark *after* `send_otp`, causing fast 1–2s OTPs to be ignored as "old". Now `check_mobile` + `captureOtpWatermark` run **in parallel BEFORE `send_otp`**.
3. **Fast-Fail Dead Numbers:** Default `OTP_TIMEOUT_MS=20000` (20s instead of 35s) drops dead numbers quickly and immediately grabs a fresh number.
4. **Atomic Cross-Slot Phone Lock (SQLite WAL):** Two slots can never process the same mobile number simultaneously; duplicates fast-skip in 0ms.
5. **Stuck-Slot Watchdog:** Automatically detects any slot hung > 55s, aborts the stuck socket, reconnects cleanly, and keeps churning.
6. **Toing HTTP Semaphore + Multi-Key Rotation:** Caps concurrent HTTP requests to `storelex.store` (`TOING_HTTP_CONCURRENCY=20`), supports comma-separated `TOING_ACCESS_KEY`s, and retries `/export` up to 3x so verified accounts are never lost.
7. **Guaranteed `.json` Delivery Queue:** Exported `.json` files are saved in SQLite + `/data/sessions/` and delivered one-by-one to your Telegram bot chat (~55 files/min pacing, automatic Telegram `429 retry_after` backoff, 0% loss across restarts).

---

## 🚀 Railway Deploy (5-Minute Setup)

1. Open **[Railway](https://railway.app/new)** → **Deploy from GitHub repo** → select **`hulm0408/test`**.
2. Open the service **Settings**:
   - **Root Directory:** `toing-railway`
   - Railway auto-detects `Dockerfile` and `railway.toml` (`/health` healthcheck).
3. Add a **Persistent Volume**:
   - Service → **Volumes** → **Add Volume** → Mount Path: **`/data`** (1 GB is plenty).
4. Add **Variables** (minimum required):
   | Variable | Value |
   |---|---|
   | `BOT_TOKEN` | **NEW** `@BotFather` token (never reuse `workwr` live token!) |
   | `OWNER_IDS` | Your Telegram User ID (e.g. `6484999726`) |
   | `VAULT_ENCRYPTION_KEY` | Any strong random secret string (encrypts TG sessions in SQLite) |
   | `TELEGRAM_API_ID` | Your `my.telegram.org` API ID |
   | `TELEGRAM_API_HASH` | Your `my.telegram.org` API Hash |
   | `TOING_ACCESS_KEY` | Your Toing key (single or comma-separated multiple keys) |
   | `DATA_DIR` | `/data` |
   | `DEFAULT_OTP_BOT` | `hathi` (or `hermes` / `chauhan`) |
5. Deploy! Once `/health` turns green, open your new Telegram bot and send **`/start`**.

---

## 🔥 Firebase Fresh-Only mode

Firebase mode is **OFF by default**. Toggle it on from the dashboard or use `/firebase` (`/fb`) to manage sources and start the engine. When running, it checks each number first and skips already-registered numbers without sending an OTP; only confirmed fresh numbers proceed to Firebase inbox polling, verification, export and the usual delivery queue. When switched off, the existing Telegram-slot mode remains in use and sends OTPs to both fresh and registered numbers by default.

The Firebase panel supports source verification, bulk addition (`URL|auth` per line or a `.txt` file), primary selection, health reset, deletion, lane count and OTP timeout. Firebase auth values are encrypted in SQLite with `VAULT_ENCRYPTION_KEY`. Use only Firebase pools and inboxes you are authorized to access. Built-in source URLs are seeded at startup; individual removals and Delete All are remembered across restarts. The service does not need Telegram MTProto spare accounts in Firebase mode, but still needs its Telegram control bot and a delivery chat.

Optional environment defaults are documented in `.env.example`: `FIREBASE_MODE`, `FIREBASE_CONCURRENCY`, `FIREBASE_OTP_TIMEOUT_MS`, `FIREBASE_ACTIVE_WINDOW_MS`, `FIREBASE_DB_URL`, `FIREBASE_DB_AUTH`, and `FIREBASE_DB_URLS`. Settings changed in the Telegram UI persist in SQLite and take precedence over environment defaults.

### Active-number report (read-only)

`Saved Firebase databases` counts database configurations, **not phones**. The dashboard and `/firebase` show **Active numbers (file report)** separately. This is an uploaded inventory snapshot, not a live scan; it reads `Unknown` until there is a valid report.

A configured owner can send a UTF-8 document named **`firebase-status.txt`** (max 128 KiB) in a private chat with the bot. Use an export from your own inventory with one status per **distinct** number across your projects; remove the identifiers before uploading. For example:

```text
status
active
inactive
unknown
active
```

This reports **2 active / 4 reported**. A `status` header alone explicitly reports an empty inventory. The bot saves only the three counts and the upload time; it cannot deduplicate rows without identifiers. An invalid row rejects the whole update and leaves the previous report intact. This filename is reserved for reporting even when an import prompt is open: it never adds a source, starts a job, reads an inbox or sends an OTP. Other unsolicited TXT files are acknowledged but not downloaded.

---

## 👥 Adding 20–50 Spare Telegram Accounts

Inside your Telegram bot:
- **Fastest (Bulk Import):** Tap **📥 Bulk Import** (or `/import`) → paste 1–50 lines (or upload a `.txt` / `.json` file). Your message is **auto-deleted immediately** for security:
  ```text
  1BVtsOHw...
  acc2|1BVtsOHw...
  acc3|hermes|1BVtsOHw...
  ```
- **Interactive Phone Login:** Tap **📱 Add via Phone** (or `/addaccount`) → Phone → OTP → 2FA (never pauses running slots).

Then tap **🚀 START ALL**.

---

## 🎯 Tuning for Consistent 20+ Accounts / Minute

| Active Healthy Slots | Expected Rate (50% OTP hit) | Expected Rate (35% OTP hit) |
|---|---|---|
| 15 slots | ~22–26 acc/min | ~14–18 acc/min |
| **25 slots** | **~36–42 acc/min** | **~24–28 acc/min** |
| **35–50 slots** | **~50–70+ acc/min** | **~33–48 acc/min** |

**Pro tips for consistency:**
- Keep **25–35+ healthy spare accounts** loaded so even if 3–5 hit `FLOOD_WAIT`, you stay safely above 20 acc/min.
- Mix OTP bots if one gets slow (e.g. half on `hathi`, half on `hermes`), or toggle **🔁 Failover: ON** in ⚙️ Settings.
- Keep `DELIVERY_CHAT_ID` as a **private DM chat** with the bot (allows ~55 `.json`/min vs Telegram's 20/min group limit).
- If `storelex.store` shows 429s in `/status`, add a 2nd key via `/setkey KEY1,KEY2` or lower HTTP gate to `15`.

---

## 🧪 Local Verification

```bash
cd toing-railway
npm install
npm test
```
