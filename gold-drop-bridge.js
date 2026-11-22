// ===== 🔗 GOLD DROP BRIDGE — @rajafuckbot ko OTP bot se jorna =====
//
// Owner ka flow (screenshots se, 2026-11-20):
//   /start → menu → MANUAL CLAIM (3x) → 10-digit number →
//   STARTING CLAIM 1 OF 3 (MOBILE/NAME/EMAIL/PINCODE/BATCH CODE) →
//   SOLVING TURNSTILE CAPTCHA & REQUESTING SMS OTP →
//   OTP SENT SUCCESSFULLY! [1/3] → 6-digit OTP → CLAIM #1 COMPLETED!
//   → INITIATING CLAIM #2/3 → OTP SENT FOR CLAIM #2/3! → OTP →
//   CLAIM #2 COMPLETED! → INITIATING CLAIM #3/3 → OTP SENT FOR CLAIM #3/3!
//   → OTP → VERIFYING OTP FOR CLAIM #3/3 → MANUAL CLAIMS SUMMARY
//   (CLAIMS COMPLETED: 3/3 · REWARDS WON: n · PRIZES: {...})
//
// Pehle owner khud OTP bot (Hathi/Hermes) se code copy karke type karte the
// (dono chat ek saath khole hua dikhe the). Ab wahi Swiggy World Bot wala
// system — SWIGGY WORLD BOT + OTP BOT — is bot par lagta hai:
//   • ek hi spare Telegram user session (otp bots ke liye configured)
//     se @rajafuckbot ke buttons click + text bheja jata hai
//   • jab bot OTP maangta hai, OTP bot ke chat me REFRESH/VIEW MESSAGES
//     dabate hue code khud nikal kar wahi type ho jata hai
//   • har claim ke liye alag watermark — purana OTP kabhi dobara nahi jata
//   • CANCEL CLAIM / FINISH / STOP CLAIMS buttons ka saaf rakh-rakh
//
// Pure helpers (button role, screen kind, summary parse) network ke bina
// test kiye ja sakte hain — test_gold-drop-bridge.mjs me cover hote hain.

import { withTelegramUserClient } from './telegram-otp-source.js';

export const GOLD_DROP_BRIDGE_USERNAME_DEFAULT = 'rajafuckbot';

// Har step ka default budget. Bot slow ho to Settings/env se badhaya ja
// sakta hai (GOLD_DROP_BRIDGE_STEP_TIMEOUT_MS) — caller isi ke andar
// recover karta hai.
export const GOLD_DROP_BRIDGE_DEFAULTS = {
  // Fixed input (number/OTP) ka koi chhota time limit nahi — bot ka output
  // aane do, fir agla input. Sirf OTP inbox ka apna budget alag hai.
  stepTimeoutMs: 120_000,
  // Menu / number prompt ka budget (start se alag).
  startTimeoutMs: 60_000,
  pollMs: 1_500,
  readLimit: 12,
  // OTP Sent confirm hone ka budget (claim shuru hone se lekar prompt aane
  // tak). Bot Turnstile solve + OTP request me time le sakta hai.
  otpRequestTimeoutMs: 60_000,
  // OTP type karne ke baad claim complete/next prompt ka budget.
  otpVerifyWaitMs: 90_000,
  // OTP inbox (OTP bot chat) me code aane ka intezaar — number ki jaan
  // nahi, isliye alag budget (env se 30s–180s).
  otpInboxTimeoutMs: 90_000,
  // Kitne claims chalne hain (screenshots ke hisaab se 3).
  maxClaims: 3,
  // Button trigger: 'auto' = pehle click; screen na badle to button ka TEXT
  // type karke action trigger (world-bot jaisa). 'type' = click bilkul nahi.
  trigger: 'auto',
  clickGraceMs: 8_000,
  // Flood wait ke baad ka aakhri dheemi scan (0 = band).
  lateReplyGraceMs: 45_000,
};

const normHandle = (value = '') => String(value || '').trim().replace(/^@+/, '');

export const state = {
  phase: 'idle',
  lastAction: '',
  lastError: '',
  lastScreenText: '',
  lastScreenButtons: [],
  recentScreens: [],
  lastChatAt: 0,
  lastOkAt: 0,
  step: 0,
  username: '',
  phone: '',
};

export function getGoldDropBridgeState() {
  return state;
}

export function getGoldDropBridgeStatus() {
  return {
    ...state,
    username: state.username || goldDropBridgeUsername(),
    lastScreenButtons: [...(state.lastScreenButtons || [])],
    recentScreens: [...(state.recentScreens || [])],
  };
}

export function goldDropBridgeUsername(env = process.env) {
  return normHandle(
    env?.GOLD_DROP_BRIDGE_BOT_USERNAME
    || env?.GOLD_DROP_BOT_USERNAME
    || env?.GOLD_DROP_BRIDGE_BOT
    || GOLD_DROP_BRIDGE_USERNAME_DEFAULT
  ) || GOLD_DROP_BRIDGE_USERNAME_DEFAULT;
}

export function goldDropBridgeConfig(env = process.env) {
  const num = (key, dflt, min = 250) => {
    const n = Number(env?.[key]);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  return {
    username: goldDropBridgeUsername(env),
    stepTimeoutMs: num('GOLD_DROP_BRIDGE_STEP_TIMEOUT_MS', GOLD_DROP_BRIDGE_DEFAULTS.stepTimeoutMs),
    startTimeoutMs: num('GOLD_DROP_BRIDGE_START_TIMEOUT_MS', GOLD_DROP_BRIDGE_DEFAULTS.startTimeoutMs, 5_000),
    pollMs: num('GOLD_DROP_BRIDGE_POLL_MS', GOLD_DROP_BRIDGE_DEFAULTS.pollMs, 300),
    otpRequestTimeoutMs: num('GOLD_DROP_BRIDGE_OTP_REQUEST_TIMEOUT_MS', GOLD_DROP_BRIDGE_DEFAULTS.otpRequestTimeoutMs, 10_000),
    otpVerifyWaitMs: Math.max(30_000, Math.min(600_000,
      num('GOLD_DROP_BRIDGE_OTP_VERIFY_WAIT_MS', GOLD_DROP_BRIDGE_DEFAULTS.otpVerifyWaitMs, 30_000))),
    otpInboxTimeoutMs: Math.max(30_000, Math.min(180_000,
      num('GOLD_DROP_BRIDGE_OTP_INBOX_TIMEOUT_MS', GOLD_DROP_BRIDGE_DEFAULTS.otpInboxTimeoutMs, 30_000))),
    maxClaims: Math.max(1, Math.min(5, Math.trunc(num('GOLD_DROP_BRIDGE_MAX_CLAIMS', GOLD_DROP_BRIDGE_DEFAULTS.maxClaims, 1)))),
    trigger: ['click', 'type', 'auto'].includes(String(env?.GOLD_DROP_BRIDGE_TRIGGER || '').trim().toLowerCase())
      ? String(env.GOLD_DROP_BRIDGE_TRIGGER).trim().toLowerCase()
      : GOLD_DROP_BRIDGE_DEFAULTS.trigger,
    clickGraceMs: num('GOLD_DROP_BRIDGE_CLICK_GRACE_MS', GOLD_DROP_BRIDGE_DEFAULTS.clickGraceMs, 1_000),
    lateReplyGraceMs: Math.max(0, Math.min(180_000,
      num('GOLD_DROP_BRIDGE_LATE_REPLY_GRACE_MS', GOLD_DROP_BRIDGE_DEFAULTS.lateReplyGraceMs, 0))),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — network ke bina (tests inhe direct call karte hain)
// ---------------------------------------------------------------------------
const plain = (value = '') => String(value ?? '')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\u00a0/g, ' ');

// Fancy/small-caps text normalize (OTP bots wale rule ke tarah — bot ka
// button text kabhi 𝗠𝗮𝗻𝘂𝗮𝗹 𝗖𝗹𝗮𝗶𝗺 wala fancy font me bhi aa sakta hai).
const SMALL_CAPS_MAP = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G',
  'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N',
  'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V',
  'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};

const norm = (value = '') => {
  const decomposed = plain(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const mapped = [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
  return mapped
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

// Screen text ke liye — punctuation (- / # [ ] : ! ?) bachao, sirf
// whitespace collapse + small-caps map. Screen grammar ("OTP SENT FOR
// CLAIM #2/3!", "[1/3]", "10-DIGIT", "claim#1completed") inhe milna lazmi
// hai; button roles me `norm` (punctuation → space) chal sakta hai.
const lightNorm = (value = '') => {
  const decomposed = plain(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const mapped = [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
  return mapped
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

// Button ka role — @rajafuckbot ke screens ke hisaab se.
//   manualClaim | cancelClaim | finishStop | cancel | claimAnother |
//   mainMenu | backToMenu | ''
export function goldDropBridgeButtonRole(text = '') {
  const n = norm(text);
  if (!n) return '';
  // "CANCEL CLAIM" se PEHLE "cancel" nahi — order matters.
  if (/\bcancel\b.*\bclaim\b|\bclaim\b.*\bcancel\b/.test(n)) return 'cancelClaim';
  if (/\bmanual\b.*\bclaim\b/.test(n)) return 'manualClaim';
  if (/\bfinish\b|\bstop\b.*\bclaims?\b/.test(n)) return 'finishStop';
  if (/^\s*cancel\s*$/.test(n)) return 'cancel';
  if (/\bclaim\b.*\banother\b.*\bnumber\b/.test(n)) return 'claimAnother';
  if (/\bmain\b.*\bmenu\b/.test(n)) return 'mainMenu';
  if (/\bback\b.*\bto\b.*\bmenu\b/.test(n)) return 'backToMenu';
  return '';
}

// Latest screen par diya gaya role dhoondo (puri historical screens me nahi —
// purane menu ke buttons stale ho sakte hain, jaise world-bot par).
// Button kabhi raw teleproto button hota hai, kabhi screen-parse ka mapped
// object ({ button, text, role }) — dono se asli button nikalo.
export function pickGoldDropBridgeButton(buttons = [], role = '') {
  const list = Array.isArray(buttons) ? buttons : [];
  for (const item of list) {
    const raw = item?.button || item;
    const text = String(item?.text ?? (item?.button?.text ?? (raw?.text || raw || '')));
    if (goldDropBridgeButtonRole(text) === role) {
      return { button: raw, text };
    }
  }
  return null;
}

// Button role sirf LATEST 1-3 incoming messages me dhoondho.
export function findGoldDropButtonOnScreens(messages = [], role = '') {
  const list = Array.isArray(messages) ? messages : [];
  const inbound = list.filter((m) => !m?.out);
  const pool = (inbound.length ? inbound : list).slice(0, 3);
  for (const message of [...pool, ...list.slice(0, 2)]) {
    const hit = pickGoldDropBridgeButton(message?.buttons, role);
    if (hit) return { message, ...hit };
  }
  return null;
}

// Screen ka kind — @rajafuckbot ke asli screens ke hisaab se:
//   'menu' | 'numberPrompt' | 'claimStarting' | 'otpRequesting' |
//   'otpRequested' | 'otpPrompt' | 'claimCompleted' | 'claimInitiating' |
//   'verifying' | 'summary' | ''
export function goldDropBridgeScreenKind(text = '') {
  const n = lightNorm(text);
  if (!n) return '';
  if (/manual\s*claims?\s*summary/.test(n) || /claims?\s*completed/.test(n)) return 'summary';
  if (/claim\s*#?\d+\s*completed/.test(n) || /claim \d+ completed/.test(n)) return 'claimCompleted';
  if (/initiating claim|starting claim/.test(n)) return 'claimInitiating';
  if (/otp sent (successfully|for claim)/.test(n)) return 'otpRequested';
  if (/please enter (the )?(next )?6[- ]digit otp code below/.test(n)) return 'otpPrompt';
  if (/verifying otp for claim/.test(n)) return 'verifying';
  if (/solving (turnstile )?captcha.*requesting (sms )?otp/.test(n)) return 'otpRequesting';
  if (/please type and send the 10[- ]digit mobile number|send the 10[- ]digit mobile number/.test(n)) return 'numberPrompt';
  return '';
}

export function goldDropBridgeHasPromptKind(messages = [], kind = '') {
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => goldDropBridgeScreenKind(String(m?.text || '')) === kind);
}

// Screen text se claim index nikalna — "[1/3]", "CLAIM #2/3",
// "CLAIM #1 COMPLETED", "STARTING CLAIM 1 OF 3" sab se.
export function parseGoldDropClaimIndex(text = '') {
  const n = lightNorm(text);
  if (!n) return 0;
  let m = /claim\s*#?(\d+)\s*\/\s*(\d+)/.exec(n);
  if (m) return Math.max(0, Math.min(9, Number(m[1]) || 0));
  m = /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/.exec(n);
  if (m) return Math.max(0, Math.min(9, Number(m[1]) || 0));
  m = /claim\s*#?(\d+)\s*completed/.exec(n);
  if (m) return Math.max(0, Math.min(9, Number(m[1]) || 0));
  m = /starting claim (\d+)\s*of/.exec(n);
  if (m) return Math.max(0, Math.min(9, Number(m[1]) || 0));
  return 0;
}

// Screen se mobile number nikalna — "MOBILE: +91 6287974582".
export function parseGoldDropMobileFromText(text = '') {
  const n = plain(text);
  const m = /mobile\s*:?\s*(?:\+?91[-\s]?)?(\d{10})/i.exec(n);
  return m ? m[1] : '';
}

export function normalizeGoldDropPhone(value = '') {
  return String(value || '').replace(/[^\d]/g, '').slice(-10);
}

export function isGoldDropPhoneValid(value = '') {
  return /^[6789]\d{9}$/.test(normalizeGoldDropPhone(value));
}

// OTP code — sirf 6 digit. "395388" / "395 388" dono chalein.
export function normalizeGoldDropOtp(value = '') {
  return String(value || '').replace(/\D/g, '').slice(0, 6);
}

export function isGoldDropOtpValid(value = '') {
  return /^\d{6}$/.test(normalizeGoldDropOtp(value));
}

// MANUAL CLAIMS SUMMARY ka parse:
//   CLAIMS COMPLETED: 3/3
//   REWARDS WON: 1
//   PRIZES: {'name': 'Cashback, 'face_value': 116}
export function parseGoldDropSummary(text = '') {
  const n = plain(text);
  const out = { claimsCompleted: 0, claimsTotal: 0, rewardsWon: 0, prizes: null };
  const claims = /claims completed\s*:\s*(\d+)\s*\/\s*(\d+)/i.exec(n);
  if (claims) {
    out.claimsCompleted = Number(claims[1]) || 0;
    out.claimsTotal = Number(claims[2]) || 0;
  }
  const rewards = /rewards won\s*:\s*(\d+)/i.exec(n);
  if (rewards) out.rewardsWon = Number(rewards[1]) || 0;
  // PRIZES line aasaani se JSON nahi hoti (comma/quotes chhut jaate hain) —
  // sirf {...} block ko honestly parse karo, fail ho to raw rakh lo.
  const prizes = /prizes\s*:\s*(\{[\s\S]*\})\s*$/i.exec(n.trim());
  if (prizes) {
    try { out.prizes = JSON.parse(prizes[1]); } catch { out.prizes = prizes[1]; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 🔌 CLIENT PLUMBING — wahi spare Telegram user session (OTP bots wala)
// ---------------------------------------------------------------------------
let goldDropBridgeTestClient = null;

export function _setGoldDropBridgeClientOverrideForTests(client = null) {
  goldDropBridgeTestClient = client || null;
  return true;
}

export async function withGoldDropBridgeClient(fn) {
  if (goldDropBridgeTestClient) return fn({ client: goldDropBridgeTestClient, config: {} });
  return withTelegramUserClient(fn);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

let entityCache = { client: null, username: '', entity: null };

export async function getGoldDropEntity(client, username) {
  const key = String(username || '').toLowerCase();
  if (entityCache.client === client && entityCache.username === key && entityCache.entity) {
    return entityCache.entity;
  }
  const entity = await client.getEntity(`@${username}`);
  entityCache = { client, username: key, entity };
  return entity;
}

function buttonTextOf(button) {
  try { return String(button?.text || button?.button?.text || ''); } catch { return ''; }
}

async function messageButtons(message) {
  let rows;
  try { rows = message?.buttons; } catch {}
  if (!rows) {
    try { rows = typeof message?.getButtons === 'function' ? await message.getButtons() : null; } catch {}
  }
  if (!rows) rows = message?._buttons || (message?._buttonsFlat ? [message._buttonsFlat] : []);
  if (!Array.isArray(rows)) return [];
  return rows
    .flatMap((row) => (Array.isArray(row) ? row : [row]))
    .filter((button) => button && buttonTextOf(button));
}

function messageIdOf(message) {
  const raw = message?.id;
  if (typeof raw === 'bigint') return Number(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function messageDateMs(message) {
  const raw = message?.date;
  if (raw instanceof Date) return raw.getTime() || 0;
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

function messageEditMs(message) {
  const raw = message?.editDate;
  if (raw instanceof Date) return raw.getTime() || 0;
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  return Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : 0;
}

function messageTextOf(message) {
  const raw = message?.raw;
  const candidates = [
    () => message?.text,
    () => message?.message,
    () => message?.rawText,
    () => raw?.message,
    () => message?.caption,
    () => message?.media?.caption,
    () => raw?.media?.caption,
  ];
  for (const get of candidates) {
    let value = '';
    try { value = get(); } catch { continue; }
    const text = plain(value || '');
    if (text) return text;
  }
  return '';
}

function messageHasMedia(message) {
  try {
    if (message?.photo || message?.media?.photo) return true;
    if (message?.sticker || message?.media?.sticker) return true;
    const cls = String(message?.media?.className || '');
    if (/photo|sticker|animation|video|webpage/i.test(cls)) return true;
    if (message?.media && typeof message.media === 'object') return true;
  } catch {}
  return false;
}

// 🧠 READ CACHE — world-bot waisi hi single-flight + adaptive TTL. Telegram
// throttle (flood wait) se bachne ke liye read dheema karna, aur khali read
// par purana screen wapas karna ("blank screen" se button dhoondhna band).
const readCache = {
  at: 0,
  limit: 0,
  messages: [],
  inflight: null,
  ttlMs: 400,
  lastReadMs: 0,
  lastFloodMs: 0,
};

export function goldDropBridgeBlockedMs() {
  return Math.max(0, Number(readCache.lastFloodMs) || 0);
}

function isDisconnectError(error) {
  return /cannot send requests while disconnected|telegram client disconnect|client (is )?not connected|not connected to telegram|connection closed/i
    .test(String(error?.message ?? error ?? ''));
}

async function ensureGoldDropOnline(client, { reason = '', force = false } = {}) {
  if (!client) return false;
  try {
    if (typeof client.connected === 'boolean') {
      if (client.connected && !force) return true;
    } else if (typeof client.isConnected === 'function' && client.isConnected() && !force) {
      return true;
    } else if (!force) {
      return true; // pata na chale to maan lo theek hai
    }
  } catch {}
  try {
    if (typeof client.connect === 'function') {
      await Promise.race([
        client.connect(),
        sleep(15_000).then(() => { throw new Error('connect 15s me nahi hua'); }),
      ]);
    }
  } catch (e) {
    console.warn(`[GoldDropBridge] 🔌 reconnect fail: ${String(e?.message || e).slice(0, 90)}`);
  }
  return true;
}

async function readGoldDropMessages(client, entity, limit = GOLD_DROP_BRIDGE_DEFAULTS.readLimit, { fresh = false } = {}) {
  const take = Math.max(1, Number(limit) || 10);
  if (!fresh && readCache.messages.length && Date.now() - readCache.at < readCache.ttlMs) {
    return readCache.limit === take
      ? readCache.messages
      : readCache.messages.slice(0, take);
  }
  if (readCache.inflight) {
    try { return await readCache.inflight; } catch {}
    return readCache.messages;
  }
  readCache.inflight = (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (isDisconnectError(lastError) || attempt === 1) {
        await ensureGoldDropOnline(client, { reason: `read (try ${attempt})` });
      }
      const startedAt = Date.now();
      try {
        const messages = await client.getMessages(entity, { limit: take });
        const readMs = Date.now() - startedAt;
        readCache.lastReadMs = readMs;
        const list = Array.isArray(messages) ? messages : [...(messages || [])];
        if (readMs > 800) {
          readCache.lastFloodMs = readMs;
          readCache.ttlMs = Math.min(8_000, Math.max(600, readMs * 2));
          console.warn(`[GoldDropBridge] 🐢 chat read ${readMs}ms (Telegram flood wait) — agla read ${Math.round(readCache.ttlMs)}ms cache se`);
        } else {
          readCache.lastFloodMs = 0;
          readCache.ttlMs = Math.min(1_500, Math.max(400, readMs * 3));
        }
        if (list.length) {
          readCache.at = Date.now();
          readCache.limit = take;
          readCache.messages = list;
          return list;
        }
        lastError = new Error('Bot ki chat khali aayi (Telegram flood wait / read fail)');
      } catch (error) {
        readCache.lastReadMs = Date.now() - startedAt;
        lastError = error;
        if (isDisconnectError(error)) {
          console.warn('[GoldDropBridge] 🔌 read fail — Telegram client disconnect');
        }
      }
      if (attempt < 2) {
        console.warn(`[GoldDropBridge] ⏳ chat read khali/fail (try ${attempt}/2) — ${String(lastError?.message || lastError).slice(0, 80)}`);
        await sleep(1_200);
      }
    }
    if (readCache.messages.length) return readCache.messages;
    return [];
  })();
  try {
    return await readCache.inflight;
  } finally {
    readCache.inflight = null;
  }
}

function readBlockMs() {
  return Math.max(0, Number(readCache.lastFloodMs) || 0);
}

export async function parseGoldDropScreens(client, entity, limit, readOpts = {}) {
  const messages = await readGoldDropMessages(client, entity, limit, readOpts);
  const parsed = [];
  for (const message of messages) {
    const buttons = await messageButtons(message);
    parsed.push({
      id: messageIdOf(message),
      text: messageTextOf(message),
      dateMs: messageDateMs(message),
      editMs: messageEditMs(message),
      out: Boolean(message?.out),
      hasMedia: messageHasMedia(message),
      buttons: buttons.map((button) => ({
        button,
        text: buttonTextOf(button),
        role: goldDropBridgeButtonRole(buttonTextOf(button)),
      })),
      raw: message,
    });
  }
  state.lastChatAt = Date.now();
  // Latest = bot ka message (apna bheja number/OTP nahi). Blank/service
  // messages "(no text)" screen nahi banate — asli screen dikhna chahiye.
  const inbound = parsed.filter((m) => !m.out);
  const hasContent = (m) => Boolean(m.text || m.buttons.length || m.hasMedia);
  const latest = inbound.find(hasContent)
    || inbound[0]
    || parsed.find(hasContent)
    || parsed[0]
    || null;
  if (latest) {
    state.lastScreenText = String(latest.text || '').slice(0, 400);
    state.lastScreenButtons = latest.buttons.map((b) => b.text);
    const entry = {
      at: Date.now(),
      phase: state.phase,
      text: String(latest.text || '').replace(/\s+/g, ' ').slice(0, 240),
      media: Boolean(latest.hasMedia),
      out: Boolean(latest.out),
      buttons: latest.buttons.map((b) => b.text).slice(0, 10),
    };
    const last = state.recentScreens[0];
    if (!last || last.text !== entry.text || last.buttons.join('|') !== entry.buttons.join('|')
      || Boolean(last.media) !== entry.media) {
      state.recentScreens = [entry, ...state.recentScreens].slice(0, 8);
      const shown = entry.text || (entry.media ? '(media, no text)' : '(no text)');
      console.log(`[GoldDropBridge] 📺 ${state.phase}: ${shown} · [${entry.buttons.join(' | ') || 'no buttons'}]`);
    }
  }
  return parsed;
}

export function screenSignature(messages = []) {
  const map = new Map();
  for (const m of messages) {
    map.set(m.id, `${m.text}|${m.buttons.map((b) => b.text).join('|')}|${m.hasMedia ? 'media' : ''}${m.out ? 'out' : ''}`);
  }
  return map;
}

export function freshMessages(messages, baseline) {
  return messages.filter((m) => !(baseline && baseline.has(m.id)));
}

export async function sendGoldDropText(client, entity, text) {
  const payload = String(text);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await ensureGoldDropOnline(client, { reason: 'send' });
      await client.sendMessage(entity, { message: payload });
      state.lastAction = `send:${payload.slice(0, 24)}`;
      state.lastChatAt = Date.now();
      return true;
    } catch (error) {
      if (isDisconnectError(error) && attempt === 1) {
        await ensureGoldDropOnline(client, { reason: 'send retry' });
        continue;
      }
      const flood = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/i.exec(String(error?.message || error));
      if (flood && attempt === 1) {
        const waitMs = Math.min(45_000, (Number(flood[1]) + 2) * 1_000);
        console.warn(`[GoldDropBridge] ⏳ Telegram flood wait ${Math.round(waitMs / 1000)}s — phir dobara bhejunga`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
  return false;
}

export async function clickGoldDropButton(entry) {
  const button = entry?.button || (typeof entry?.click === 'function' ? entry : null);
  if (!button) throw new Error('Button nahi mila');
  state.lastAction = `click:${entry?.text || button?.text || ''}`;
  setPhase(`click-${entry?.role || 'button'}`);
  const answer = await button.click({});
  const callback = String(answer?.message || '').trim().slice(0, 180);
  const label = String(entry?.text || button?.text || 'button');
  console.log(`[GoldDropBridge] click: ${label}${callback ? ` — callback: ${callback}` : ''}`);
  state.lastChatAt = Date.now();
  return callback;
}

export function setPhase(phase, extra = {}) {
  state.phase = phase;
  if (extra.lastError !== undefined) state.lastError = extra.lastError;
}

async function scanForLateReply({ client, entity, predicate, baseline, graceMs, shouldAbort, what }) {
  const deadline = Date.now() + Math.max(0, Number(graceMs) || 0);
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw new Error('aborted');
    }
    const all = await parseGoldDropScreens(client, entity, 8, { fresh: true }).catch(() => []);
    const fresh = baseline ? freshMessages(all, baseline) : all;
    const hit = predicate(fresh, all);
    if (hit) return hit;
    await sleep(1_500);
  }
  return null;
}

export async function waitForGoldDropReply({
  client, entity, predicate, baseline, timeoutMs, shouldAbort, what = 'reply', pollMs, graceMs,
}) {
  const budget = Math.max(1_000, Number(timeoutMs) || GOLD_DROP_BRIDGE_DEFAULTS.stepTimeoutMs);
  let deadline = Date.now() + budget;
  let extraMs = 0;
  const maxExtra = Math.max(30_000, Math.min(180_000, budget * 3));
  const every = Math.max(300, Number(pollMs) || GOLD_DROP_BRIDGE_DEFAULTS.pollMs);
  let lastAll = [];
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw new Error('aborted');
    }
    const readStartedAt = Date.now();
    const all = await parseGoldDropScreens(client, entity, undefined, { fresh: true });
    const readMs = Date.now() - readStartedAt;
    const add = readBlockMs();
    if (add > 0 && extraMs + add <= maxExtra) {
      extraMs += add;
      deadline += add;
    }
    lastAll = all;
    const fresh = baseline ? freshMessages(all, baseline) : all;
    const hit = predicate(fresh, all);
    if (hit) return hit;
    await sleep(every);
  }
  // Deadline khatam — flood ke baad jawab late aata hai, isliye ek aakhri
  // dheemi scan (graceMs = 0 to band).
  const grace = Math.max(0, Number(graceMs) || 0);
  if (grace) {
    const late = await scanForLateReply({
      client, entity, predicate, baseline, graceMs: grace, shouldAbort, what,
    }).catch(() => null);
    if (late) return late;
  }
  const flat = (m) => String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const inboundTail = lastAll.filter((m) => !m.out).map(flat).filter(Boolean).slice(0, 3).join(' || ');
  const ownTail = lastAll.filter((m) => m.out).map(flat).filter(Boolean).slice(0, 1).map((t) => `apna bheja: ${t}`).join('');
  const buttonsTail = (lastAll.find((m) => m.buttons && m.buttons.length)?.buttons || [])
    .map((b) => b.text).filter(Boolean).slice(0, 6).join(' | ');
  const tail = [inboundTail || '(bot ka text nahi aaya)', ownTail, buttonsTail ? `buttons: ${buttonsTail}` : 'buttons: none']
    .filter(Boolean).join(' · ');
  throw new Error(`${what} ka jawab ${Math.round(budget / 1000)}s (+${Math.round(extraMs / 1000)}s flood) me nahi aaya — ${tail}`);
}

// Bot ka jawab poora aane ka intezaar: jab tak latest message ka id na
// badle, agla command mat bhejo.
export async function settledScreen(client, entity, cfg = {}, { quietMs = 1_500, maxMs = 10_000 } = {}) {
  const every = Math.max(250, Number(cfg?.pollMs) || 1_200);
  const quiet = Math.max(400, Number(quietMs) || 1_500);
  let deadline = Date.now() + Math.max(quiet, Number(maxMs) || 9_000);
  let lastId = -1;
  let lastChange = Date.now();
  for (;;) {
    const readStartedAt = Date.now();
    const all = await parseGoldDropScreens(client, entity, 6, { fresh: true });
    const add = readBlockMs();
    if (add > 0) deadline += Math.min(30_000, add);
    const id = Number(all[0]?.id) || 0;
    if (id !== lastId) {
      lastId = id;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quiet) {
      return all;
    }
    if (Date.now() >= deadline) return all;
    await sleep(every);
  }
}

// Button trigger (world-bot waisa): pehle click; screen na badle to button
// ka TEXT type karke action trigger.
export async function triggerGoldDropButton({
  client, entity, entry, cfg, shouldAbort, what, predicate, baseline = null, timeoutMs = null,
}) {
  const total = Math.max(5_000, Number(timeoutMs) || Number(cfg?.stepTimeoutMs) || GOLD_DROP_BRIDGE_DEFAULTS.stepTimeoutMs);
  const grace = Math.min(total, Math.max(3_000, Number(cfg?.clickGraceMs) || 4_000));
  const before = baseline || screenSignature(await settledScreen(client, entity, cfg));
  const label = String(entry?.text || '').trim();
  let clickCallback = '';

  if (cfg?.trigger !== 'type') {
    try {
      clickCallback = (await clickGoldDropButton(entry)) || '';
      const hit = await waitForGoldDropReply({
        client, entity, baseline: before, timeoutMs: grace, shouldAbort,
        what: `${what} (click)`, predicate, pollMs: cfg?.pollMs,
        graceMs: 20_000,
      });
      return hit;
    } catch (e) {
      if (/aborted/i.test(String(e?.message || ''))) throw e;
      try {
        const afterClick = await parseGoldDropScreens(client, entity);
        if (screenSignature(afterClick) !== before) {
          console.log(`[GoldDropBridge] click ne screen badal di ("${label || what}") — text trigger skip`);
          const late = predicate ? predicate(freshMessages(afterClick, before), afterClick) : null;
          if (late) return late;
          return { clicked: true, screen: afterClick };
        }
      } catch {}
      if (clickCallback) {
        console.log(`[GoldDropBridge] ✅ click ka callback aaya ("${clickCallback.slice(0, 60)}") — text trigger skip`);
        return { clicked: true, callback: clickCallback };
      }
      console.warn(`[GoldDropBridge] click se "${label || what}" trigger nahi hua — text se try karunga`);
    }
  }

  // Click se trigger nahi hua (button na mile / callback na aaye) — button
  // ka text type kar do (owner ka world-bot rule).
  await sendGoldDropText(client, entity, label);
  return waitForGoldDropReply({
    client, entity, baseline: before, timeoutMs: total, shouldAbort,
    what: `${what} (text)`, predicate, pollMs: cfg?.pollMs,
    graceMs: cfg?.lateReplyGraceMs,
  });
}

// ---------------------------------------------------------------------------
// 🔍 PROBE — connection + latest screen check (Settings / diagnostics)
// ---------------------------------------------------------------------------
export async function probeGoldDropBridge({ limit = 5, config = goldDropBridgeConfig() } = {}) {
  const cfg = { ...goldDropBridgeConfig(), ...(config || {}) };
  try {
    return await withGoldDropBridgeClient(async ({ client }) => {
      const entity = await getGoldDropEntity(client, cfg.username);
      const messages = await parseGoldDropScreens(client, entity, Math.max(1, Number(limit) || 5));
      const screens = messages.map((m) => ({
        id: m.id,
        text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 300),
        buttons: m.buttons.map((b) => b.text),
        hasMedia: m.hasMedia,
        at: m.dateMs ? new Date(m.dateMs).toISOString() : '',
      }));
      const latestWithButtons = screens.find((s) => s.buttons.length) || screens[0] || null;
      return {
        ok: true,
        username: cfg.username,
        screen: latestWithButtons,
        screens,
        client: true,
      };
    });
  } catch (error) {
    state.lastError = String(error?.message || error);
    return { ok: false, username: cfg.username, reason: String(error?.message || error).slice(0, 220) };
  }
}

// ---------------------------------------------------------------------------
// 🎯 MAIN FLOW — MANUAL CLAIM (3x FLOW) @rajafuckbot par, OTP bot se join
// ---------------------------------------------------------------------------

function reportCard(report, html) {
  if (typeof report !== 'function') return Promise.resolve();
  try { return Promise.resolve(report(html)).catch(() => {}); } catch { return Promise.resolve(); }
}

// OTP miss / abort par current claim ko safe terminate karna: claim 1 par
// "CANCEL CLAIM", claims 2-3 par "FINISH / STOP CLAIMS" (na mile to "CANCEL").
async function safeTerminateClaim(client, entity, cfg, { claim = 1, shouldAbort = null } = {}) {
  const wanted = claim <= 1 ? ['cancelClaim'] : ['finishStop', 'cancelClaim', 'cancel'];
  for (const role of wanted) {
    try {
      const screens = await parseGoldDropScreens(client, entity, 6, { fresh: true });
      const hit = findGoldDropButtonOnScreens(screens, role);
      if (hit) {
        await clickGoldDropButton(hit).catch(() => {});
        console.log(`[GoldDropBridge] 🛑 claim ${claim} terminate: "${hit.text}" dabaya`);
        await sleep(1_500);
        return true;
      }
    } catch {}
    if (typeof shouldAbort === 'function' && shouldAbort()) break;
    await sleep(800);
  }
  return false;
}

export async function runGoldDropManualClaim({
  phone,
  otpProvider,
  otpWatermark,
  report,
  shouldAbort,
  config = {},
} = {}) {
  const cfg = { ...goldDropBridgeConfig(), ...(config || {}) };
  const cleanPhone = normalizeGoldDropPhone(phone);
  state.username = cfg.username;
  state.phone = cleanPhone;
  state.phase = 'start';
  state.lastError = '';
  state.recentScreens = [];
  state.step = 0;

  if (!isGoldDropPhoneValid(cleanPhone)) {
    return { ok: false, kind: 'failed_invalid_phone', phone: cleanPhone, reason: '10-digit valid mobile number chahiye (6/7/8/9 se shuru)' };
  }
  if (typeof otpProvider !== 'function') {
    return { ok: false, kind: 'no-otp-provider', phone: cleanPhone, reason: 'OTP provider missing — OTP bot se code lane ke liye' };
  }

  try {
    return await withGoldDropBridgeClient(async ({ client }) => {
      const entity = await getGoldDropEntity(client, cfg.username);

      // ---- 1) /start → main menu → MANUAL CLAIM (3x) ----
      setPhase('start');
      const startBefore = screenSignature(await parseGoldDropScreens(client, entity));
      await sendGoldDropText(client, entity, '/start');
      await waitForGoldDropReply({
        client, entity, cfg, baseline: startBefore,
        what: '/start ka menu', timeoutMs: cfg.startTimeoutMs, shouldAbort,
        predicate: (fresh, all) => findGoldDropButtonOnScreens([...fresh, ...all], 'manualClaim'),
      });
      state.step = 1;

      setPhase('open-manual-claim');
      await reportCard(report, [
        '🔗 <b>Gold Drop Bridge — @' + cfg.username + '</b>',
        `📱 <b>Number:</b> <code>${cleanPhone}</code>`,
        '→ MANUAL CLAIM (3x) khol raha hoon, number bhejne ka intezaar hai…',
      ].join('\n'));

      const claimHit = findGoldDropButtonOnScreens(
        await parseGoldDropScreens(client, entity, 8, { fresh: true }), 'manualClaim');
      if (!claimHit) throw new Error('MANUAL CLAIM (3x) button nahi mila');
      await triggerGoldDropButton({
        client, entity, cfg, shouldAbort, entry: claimHit, what: 'MANUAL CLAIM (3x)',
        predicate: (fresh, all) => goldDropBridgeHasPromptKind([...fresh, ...all], 'numberPrompt')
          || findGoldDropButtonOnScreens([...fresh, ...all], 'manualClaim'),
      });

      // ---- 2) number prompt → watermark (OTP bot) → number bhejo ----
      setPhase('number-prompt');
      await waitForGoldDropReply({
        client, entity, cfg, shouldAbort,
        what: 'number prompt', timeoutMs: cfg.stepTimeoutMs,
        predicate: (fresh, all) => goldDropBridgeHasPromptKind([...fresh, ...all], 'numberPrompt'),
      });

      // 🔖 OTP bot ka watermark number bhejne se THIK PEHLE — iske baad
      // aaya/edited code hi is claim ka naya OTP hai.
      let watermark = null;
      if (typeof otpWatermark === 'function') {
        try {
          watermark = await otpWatermark();
          console.log(`[GoldDropBridge] 🔖 OTP watermark set (${cleanPhone}) — ab iske baad ka code hi naya`);
        } catch (error) {
          console.warn(`[GoldDropBridge] ⚠️ OTP watermark fail: ${String(error?.message || error).slice(0, 90)}`);
        }
      }

      state.step = 2;
      setPhase('send-number');
      await reportCard(report, [
        '🔗 <b>Gold Drop Bridge — @' + cfg.username + '</b>',
        `📱 <b>Number:</b> <code>${cleanPhone}</code>`,
        '→ MANUAL CLAIM (3x) khol gaya, number bhej raha hoon…',
      ].join('\n'));
      await sendGoldDropText(client, entity, cleanPhone);

      // ---- 3) OTP rounds (claim 1..maxClaims) ----
      let claimsCompleted = 0;
      let summary = null;
      for (let claim = 1; claim <= cfg.maxClaims; claim += 1) {
        state.step = claim;
        // (a) OTP request screen — "OTP SENT SUCCESSFULLY! [1/3]" /
        //     "OTP SENT FOR CLAIM #n/3!" (+ kabhi sidha otpPrompt).
        setPhase(`otp-request-${claim}`);
        const otpRequested = await waitForGoldDropReply({
          client, entity, cfg, shouldAbort,
          what: `claim ${claim} ka OTP request`, timeoutMs: cfg.otpRequestTimeoutMs,
          predicate: (fresh, all) => {
            const pool = [...fresh, ...all.slice(0, 3)];
            const kind = pool.find((m) => {
              const k = goldDropBridgeScreenKind(String(m?.text || ''));
              return k === 'otpRequested' || k === 'otpPrompt';
            });
            if (!kind) return null;
            const idx = parseGoldDropClaimIndex(String(kind.text || '')) || claim;
            return idx === claim ? true : null;
          },
        }).catch(async (error) => {
          // Screen par claim fail / block ho to number dobara nahi jalta —
          // saaf report karo.
          const text = String(error?.message || '');
          if (/aborted/i.test(text)) throw error;
          // Kabhi bot sidha claimCompleted/summary de de (jaldi complete) —
          // us case dobara check karo.
          const now = await parseGoldDropScreens(client, entity, 8, { fresh: true }).catch(() => []);
          const kinds = now.map((m) => goldDropBridgeScreenKind(String(m.text || '')));
          if (kinds.includes('summary')) return { summary: true };
          if (kinds.includes('claimCompleted')) return { completed: true };
          throw error;
        });
        if (otpRequested?.summary) { summary = parseGoldDropSummary(state.lastScreenText); break; }
        if (otpRequested?.completed) { claimsCompleted = claim; continue; }

        // (b) OTP lao (OTP bot chat se) aur bhejo — watchdog ke saath, kabhi
        //     lock hang na rahe.
        setPhase(`otp-wait-${claim}`);
        await reportCard(report, [
          '🔗 <b>Gold Drop Bridge — Claim ' + claim + '/' + cfg.maxClaims + '</b>',
          `📱 <code>${cleanPhone}</code> · OTP bot me code ka intezaar (${Math.round(cfg.otpInboxTimeoutMs / 1000)}s)…`,
        ].join('\n'));
        const inboxMs = Math.max(20_000, Number(cfg.otpInboxTimeoutMs) || 90_000);
        const fetchStartedAt = Date.now();
        console.log(`[GoldDropBridge] 🔎 OTP fetch shuru — claim ${claim} · ${cleanPhone} · budget ${Math.round(inboxMs / 1000)}s`);
        const otp = await Promise.race([
          otpProvider({ watermark, phone: cleanPhone, claim }),
          new Promise((resolve) => setTimeout(() => resolve({
            code: '',
            code2: 'OTP_FETCH_HANG',
            error: `OTP fetch ${Math.round((Date.now() - fetchStartedAt) / 1000)}s me wapas nahi aaya (Telegram lock/hang) — claim terminate`,
          }), inboxMs + 15_000).unref?.()),
        ]);
        console.log(`[GoldDropBridge] 🔎 OTP fetch khatam (${Date.now() - fetchStartedAt}ms) — ${otp?.code ? 'code mila' : 'code nahi mila'}`);
        if (!otp?.code) {
          // 🛑 OTP nahi mila — current claim terminate kar do (CANCEL CLAIM /
          // FINISH), number dobara nahi jalta.
          await safeTerminateClaim(client, entity, cfg, { claim, shouldAbort }).catch(() => {});
          return {
            ok: false,
            kind: 'failed_otp_miss',
            phone: cleanPhone,
            claim,
            claimsCompleted,
            reason: otp?.error || 'OTP bot chat me is claim ka code nahi mila — claim terminate kar diya',
          };
        }
        const otpCode = normalizeGoldDropOtp(otp.code);
        if (!isGoldDropOtpValid(otpCode)) {
          await safeTerminateClaim(client, entity, cfg, { claim, shouldAbort }).catch(() => {});
          return {
            ok: false,
            kind: 'failed_otp_miss',
            phone: cleanPhone,
            claim,
            claimsCompleted,
            reason: `OTP galat shakl me aaya: "${String(otp.code).slice(0, 12)}" — claim terminate`,
          };
        }

        setPhase(`otp-verify-${claim}`);
        state.lastAction = `otp:${otpCode}`;
        await sendGoldDropText(client, entity, otpCode);

        // (c) claim complete / agla claim / summary ka intezaar
        setPhase(`claim-wait-${claim}`);
        const done = await waitForGoldDropReply({
          client, entity, cfg, shouldAbort,
          what: `claim ${claim} ka result`, timeoutMs: cfg.otpVerifyWaitMs,
          predicate: (fresh, all) => {
            const pool = [...fresh, ...all.slice(0, 3)];
            if (goldDropBridgeHasPromptKind(pool, 'summary')) return { summary: true };
            const completed = pool.find((m) => goldDropBridgeScreenKind(String(m?.text || '')) === 'claimCompleted');
            if (completed) {
              const idx = parseGoldDropClaimIndex(String(completed.text || '')) || claim;
              return { completed: idx };
            }
            // Agla claim ka OTP request aa gaya = current claim ho gaya.
            const next = pool.find((m) => {
              const k = goldDropBridgeScreenKind(String(m?.text || ''));
              return (k === 'otpRequested' || k === 'otpPrompt' || k === 'claimInitiating')
                && parseGoldDropClaimIndex(String(m.text || '')) === claim + 1;
            });
            if (next) return { nextClaim: true };
            return null;
          },
        }).catch(async (error) => {
          if (/aborted/i.test(String(error?.message || ''))) throw error;
          const now = await parseGoldDropScreens(client, entity, 8, { fresh: true }).catch(() => []);
          const kinds = now.map((m) => goldDropBridgeScreenKind(String(m.text || '')));
          if (kinds.includes('summary')) return { summary: true };
          throw error;
        });
        if (done?.summary) { summary = parseGoldDropSummary(state.lastScreenText); break; }
        if (done?.completed) {
          claimsCompleted = Math.max(claimsCompleted, done.completed);
        } else {
          claimsCompleted = claim; // next claim ki REQUEST aa gayi = current claim ho gaya
        }
        state.lastOkAt = Date.now();
        console.log(`[GoldDropBridge] ✅ claim ${claim} complete — claimsCompleted ${claimsCompleted}`);
        await reportCard(report, [
          '🔗 <b>Gold Drop Bridge — Claim ' + claim + '/' + cfg.maxClaims + '</b>',
          `📱 <code>${cleanPhone}</code> · ✅ claim ${claim} ho gaya · claims ${claimsCompleted}/${cfg.maxClaims}`,
          claim < cfg.maxClaims ? '→ agla claim chal raha hai…' : '→ summary ka intezaar…',
        ].join('\n'));

        // 🔖 Har round ka apna watermark — purana OTP dobara na jaye.
        if (claim < cfg.maxClaims) {
          watermark = null;
          if (typeof otpWatermark === 'function') {
            try { watermark = await otpWatermark(); } catch {}
          }
        }
      }

      // ---- 4) summary (claim 3 complete ke baad) ----
      if (!summary) {
        setPhase('summary-wait');
        const summaryHit = await waitForGoldDropReply({
          client, entity, cfg, shouldAbort,
          what: 'MANUAL CLAIMS SUMMARY', timeoutMs: cfg.otpVerifyWaitMs,
          predicate: (fresh, all) => goldDropBridgeHasPromptKind([...fresh, ...all], 'summary'),
        }).catch(() => null);
        if (summaryHit) summary = parseGoldDropSummary(state.lastScreenText);
      }
      if (!summary) {
        const final = await parseGoldDropScreens(client, entity, 6, { fresh: true }).catch(() => []);
        const summaryScreen = final.find((m) => goldDropBridgeScreenKind(String(m.text || '')) === 'summary');
        if (summaryScreen) summary = parseGoldDropSummary(String(summaryScreen.text || ''));
      }

      state.lastOkAt = Date.now();
      setPhase('done');
      const finalSummary = summary || { claimsCompleted, claimsTotal: cfg.maxClaims, rewardsWon: 0, prizes: null };
      console.log(`[GoldDropBridge] ✅ MANUAL CLAIM khatam — ${cleanPhone} · claims ${finalSummary.claimsCompleted}/${finalSummary.claimsTotal || cfg.maxClaims} · rewards ${finalSummary.rewardsWon}`);
      await reportCard(report, [
        '🔗 <b>Gold Drop Bridge — Summary</b>',
        `📱 <code>${cleanPhone}</code> · @${cfg.username}`,
        `✅ Claims completed: <b>${finalSummary.claimsCompleted}/${finalSummary.claimsTotal || cfg.maxClaims}</b>`,
        `🎁 Rewards won: <b>${finalSummary.rewardsWon}</b>`,
        finalSummary.prizes ? `Prizes: ${JSON.stringify(finalSummary.prizes)}` : '',
      ].filter(Boolean).join('\n'));
      return {
        ok: true,
        kind: 'manual_claim_done',
        phone: cleanPhone,
        username: cfg.username,
        ...finalSummary,
        screenButtons: [...(state.lastScreenButtons || [])],
      };
    });
  } catch (error) {
    state.lastError = String(error?.message || error);
    const aborted = /aborted|owner ne stop/i.test(String(error?.message || ''));
    if (aborted) {
      return { ok: false, kind: 'aborted', phone: cleanPhone, reason: 'Owner ne STOP kiya' };
    }
    return {
      ok: false,
      kind: 'failed_claim',
      phone: cleanPhone,
      reason: String(error?.message || error).slice(0, 240),
    };
  }
}

// ---------------------------------------------------------------------------
// 🤖 AUTO BATCH — Swiggy wala fully-auto loop: number OTP bot se khud leh,
// @rajafuckbot pe khud bhej, 3x claims khud chale, ek number khatam to agla.
//
//   getNextNumber({ excludePhones, shouldAbort }) → { phone }   (OTP bot se)
//   runClaim(phone, { report, shouldAbort }) → runGoldDropManualClaim ka result
//
// Ek number ka claim fail ho (OTP miss etc.) to wahi number dobara nahi
// aata (one-shot) — agla number turant. Target poora hone ya STOP par rukna.
// ---------------------------------------------------------------------------
export async function runGoldDropAutoClaims({
  target,
  getNextNumber,
  runClaim,
  report,
  shouldAbort,
  config = {},
} = {}) {
  const cfg = { ...goldDropBridgeConfig(), ...(config || {}) };
  const want = Math.max(1, Math.min(200, Math.trunc(Number(target) || 1)));
  const usedPhones = new Set();
  const results = [];
  let processed = 0;
  let claimsTotal = 0;
  let rewardsTotal = 0;
  let stopped = false;
  let lastError = '';

  const progressHtml = (phone, note) => [
    '🤖 <b>Gold Drop Bridge — Auto Batch</b>',
    `📨 OTP bot se number auto-fetch · @${cfg.username}`,
    `📊 Processed: <b>${processed}/${want}</b> · Claims: <b>${claimsTotal}</b> · Rewards: <b>${rewardsTotal}</b>`,
    phone ? `📱 Current: <code>${phone}</code>` : '',
    note,
  ].filter(Boolean).join('\n');

  try {
    while (processed < want) {
      if (typeof shouldAbort === 'function' && shouldAbort()) {
        stopped = true;
        break;
      }
      // 1) 🔢 Number auto-fetch — OTP bot se (Swiggy pipeline waisa hi).
      setPhase(`auto-number-${processed + 1}`);
      await reportCard(report, progressHtml('', 'OTP bot se number le raha hoon…'));
      const entry = await getNextNumber({
        excludePhones: [...usedPhones],
        shouldAbort: typeof shouldAbort === 'function' ? shouldAbort : null,
      });
      const phone = normalizeGoldDropPhone(entry?.phone);
      if (!isGoldDropPhoneValid(phone)) {
        throw new Error(`OTP bot se valid mobile number nahi mila: "${String(entry?.phone || '').slice(0, 24)}" — batch ruka`);
      }
      if (usedPhones.has(phone)) {
        throw new Error(`OTP bot ne wahi number dobara diya: ${phone} — batch ruka`);
      }
      // Number constraint ho gayi hai (OTP bot se claim ho chuki) — pehle
      // record kar do, phir claim chalo. STOP is number ke claim ko apne
      // andar rok lega — number kaam nahi jayega.
      usedPhones.add(phone);
      processed += 1;
      state.phone = phone;
      console.log(`[GoldDropBridge] 🔢 auto number ${processed}/${want}: ${phone}`);

      // 2) 🔗 3x claims — @rajafuckbot pe khud bhej kar chalo.
      setPhase(`auto-claim-${processed}`);
      const result = await runClaim(phone, {
        report: html => reportCard(report, progressHtml(phone, '')).then(() => reportCard(report, html)),
        shouldAbort,
      });
      const one = {
        phone,
        ok: Boolean(result?.ok),
        claimsCompleted: Number(result?.claimsCompleted) || 0,
        rewardsWon: Number(result?.rewardsWon) || 0,
        reason: String(result?.reason || ''),
      };
      results.push(one);
      if (one.ok) {
        claimsTotal += one.claimsCompleted;
        rewardsTotal += one.rewardsWon;
      } else {
        // ⚠️ Ek number ka claim fail = wahi number khatam (one-shot) — agla
        // number turant, batch nahi rukti.
        lastError = one.reason || 'claim fail';
        console.warn(`[GoldDropBridge] ⚠️ ${phone} claim fail — ${lastError.slice(0, 90)} · agla number`);
      }
      await reportCard(report, progressHtml(phone, one.ok
        ? `✅ claims ${one.claimsCompleted} · rewards ${one.rewardsWon} — agla number…`
        : `⚠️ claim terminate — agla number…`));
      if (typeof shouldAbort === 'function' && shouldAbort()) {
        stopped = true;
        break;
      }
    }
  } catch (error) {
    const text = String(error?.message || error);
    if (/aborted|owner ne stop/i.test(text)) {
      stopped = true;
    } else {
      lastError = text;
      state.lastError = text;
    }
  }

  setPhase(stopped ? 'auto-stopped' : 'auto-done');
  console.log(`[GoldDropBridge] 🤖 auto batch khatam — processed ${processed}/${want} · claims ${claimsTotal} · rewards ${rewardsTotal}${stopped ? ' · STOP' : ''}`);
  return {
    ok: !lastError || processed >= want,
    processed,
    target: want,
    claimsTotal,
    rewardsTotal,
    stopped,
    lastError,
    phones: [...usedPhones],
    results,
    username: cfg.username,
  };
}
