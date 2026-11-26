import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
// ===== 📨 TELEGRAM OTP BOT NUMBER + OTP SOURCE =====
//
// Hamara normal Telegraf/Bot API bot kisi doosre Telegram bot ko message
// ya callback-click nahi bhej sakta. Isliye OTP bots (@HermeshuOTPROBOT,
// @Hathi_otp_bot, @HardXotp_Bot — profiles: otp-bot-profiles.js) ko
// automate karne ke liye ek SPARE Telegram user account ko MTProto
// (Teleproto) se connect karna padta hai:
//
//   Find Number → number parse → Swiggy OTP send (pipeline) →
//   Refresh (default 20s) → OTP mile to wahi purana verify/register flow →
//   OTP na mile to agla claim New Number click karke doosra number lega.
//
// Session string poore Telegram account ka access hoti hai. Ye sirf
// Render env (TELEGRAM_SESSION) ya ignored local data/telegram.session me
// rakho — GitHub/chat me kabhi mat bhejo.

import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { findFreshGoldDropReward } from './gold-drop-rewards.js';
import { parseForwarderDateTime, _extractSixDigitCode } from './firebase-numbers.js';
import * as roster from './telegram-account-roster.js';
import { classifyTelegramError, accountStateLine } from './telegram-account-health.js';
import {
  DEFAULT_OTP_BOT_PROFILE_ID,
  OTP_BOT_PROFILES,
  getOtpBotProfile,
  normalizeOtpBotProfileId,
  otpBotButtonRole,
  otpBotProfileForUsername,
  selectOtpBotScreenAction,
} from './otp-bot-profiles.js';

export const DEFAULT_TELEGRAM_OTP_BOT_USERNAME = OTP_BOT_PROFILES[DEFAULT_OTP_BOT_PROFILE_ID].username;

// Telegram API ID/hash aur login phone jaan-boojhkar source me default nahi
// rakhe jaate. Owner apni API app values private setup flow me deta hai.
// Empty phone default se login hamesha user-entered number maangta hai.
// TELEGRAM_LOGIN_PHONE env set ho to us number ko pre-select karke login
// turant shuru ho jayega — spare account add ka flow fast hoga.
export const DEFAULT_TELEGRAM_LOGIN_PHONE =
  String(process.env.TELEGRAM_LOGIN_PHONE || '').trim();

// ---------------------------------------------------------------------------
// Kaunsa OTP bot — Hermes (@HermeshuOTPROBOT) ya HardXotp (@HardXotp_Bot).
// START par owner source chunta hai; us waqt yahan explicit profile set hoti
// hai. Boot par default Hermes rehta hai (ya env ka custom bot).
// ---------------------------------------------------------------------------
let activeOtpBotProfileId = '';
let activeOtpBotExplicit = false;

export function setActiveOtpBotProfile(profileOrId = '') {
  const raw = String(profileOrId || '').trim();
  if (!raw) {
    activeOtpBotProfileId = '';
    activeOtpBotExplicit = false;
    return getOtpBotProfile('');
  }
  activeOtpBotProfileId = normalizeOtpBotProfileId(raw);
  activeOtpBotExplicit = true;
  entityRef = null;
  entityCacheKey = '';
  return getOtpBotProfile(activeOtpBotProfileId);
}

export function getActiveOtpBotProfile() {
  if (activeOtpBotProfileId) return getOtpBotProfile(activeOtpBotProfileId);
  const envBot = firstEnv(process.env, ['TELEGRAM_OTP_BOT_USERNAME', 'TELEGRAM_OTP_BOT', 'HERMES_BOT_USERNAME']);
  const known = otpBotProfileForUsername(envBot);
  if (known) return known;
  return getOtpBotProfile(DEFAULT_OTP_BOT_PROFILE_ID);
}

export function resetActiveOtpBotProfile() {
  activeOtpBotProfileId = '';
  activeOtpBotExplicit = false;
}

function firstEnv(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

export function getTelegramSessionFilePath(env = process.env) {
  const explicit = firstEnv(env, ['TELEGRAM_SESSION_FILE', 'TG_SESSION_FILE']);
  if (explicit) return explicit;
  const dataDir = String(env?.DATA_DIR || 'data').trim() || 'data';
  return `${dataDir.replace(/\/+$/, '')}/telegram.session`;
}

// Session ka chhota fingerprint (kabhi poora session nahi). Multi-instance me
// isi se pata chalta hai ki do bots ek hi spare account par chal rahe hain —
// wahi cheez OTP races, FLOOD_WAIT aur session revoke ki wajah banti hai.
export function telegramSessionTag(env = process.env) {
  try {
    const cfg = getTelegramOtpConfig(env);
    const material = String(cfg?.session || '').trim();
    if (!material) return '';
    return createHash('sha1').update(material).digest('hex').slice(0, 10);
  } catch {
    return '';
  }
}

export function getTelegramApiCredentialsFilePath(env = process.env) {
  const explicit = firstEnv(env, ['TELEGRAM_API_CREDENTIALS_FILE', 'TG_API_CREDENTIALS_FILE']);
  if (explicit) return explicit;
  const dataDir = String(env?.DATA_DIR || 'data').trim() || 'data';
  return `${dataDir.replace(/\/+$/, '')}/telegram-api.json`;
}

function readStoredTelegramApiCredentials(filePath) {
  if (!filePath) return { apiId: 0, apiHash: '' };
  try {
    if (!existsSync(filePath)) return { apiId: 0, apiHash: '' };
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const rawId = String(parsed?.apiId ?? parsed?.api_id ?? '').trim();
    return {
      apiId: /^\d+$/.test(rawId) ? Number(rawId) : 0,
      apiHash: String(parsed?.apiHash ?? parsed?.api_hash ?? '').trim(),
    };
  } catch {
    return { apiId: 0, apiHash: '' };
  }
}

function persistPrivateFile(filePath, content) {
  if (!filePath) return false;
  const dir = dirname(filePath);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch {}
  return true;
}

export function saveTelegramApiCredentials(
  { apiId, apiHash } = {},
  { env = process.env, updateProcessEnv = true } = {}
) {
  const cleanId = /^\d+$/.test(String(apiId || '').trim()) ? Number(String(apiId).trim()) : 0;
  const cleanHash = String(apiHash || '').trim();
  if (!cleanId || !cleanHash) throw new Error('Valid Telegram API ID aur API hash chahiye.');
  const filePath = getTelegramApiCredentialsFilePath(env);
  persistPrivateFile(filePath, `${JSON.stringify({ apiId: cleanId, apiHash: cleanHash }, null, 2)}\n`);
  if (updateProcessEnv) {
    process.env.TELEGRAM_API_ID = String(cleanId);
    process.env.TELEGRAM_API_HASH = cleanHash;
  }
  return { ok: true, apiId: cleanId, apiHashPresent: true, apiCredentialsFile: filePath, apiCredentialsSource: 'file' };
}

export function saveTelegramSessionString(
  session,
  { env = process.env, persist = true, updateProcessEnv = true } = {}
) {
  const clean = String(session || '').trim();
  if (!clean) throw new Error('Telegram session string khali hai — login save nahi ho paya.');
  const filePath = getTelegramSessionFilePath(env);
  const persisted = persist ? persistPrivateFile(filePath, `${clean}\n`) : false;
  if (updateProcessEnv) process.env.TELEGRAM_SESSION = clean;
  return { ok: true, sessionFile: filePath, sessionSource: persisted ? 'file' : 'memory', persisted };
}

export function getTelegramOtpConfig(env = process.env) {
  const apiIdRaw = firstEnv(env, ['TELEGRAM_API_ID', 'TG_API_ID', 'TELEGRAM_APP_ID']);
  const envApiId = /^\d+$/.test(apiIdRaw) ? Number(apiIdRaw) : 0;
  const envApiHash = firstEnv(env, ['TELEGRAM_API_HASH', 'TG_API_HASH', 'TELEGRAM_APP_HASH']);
  const apiCredentialsFile = firstEnv(env, ['TELEGRAM_API_CREDENTIALS_FILE', 'TG_API_CREDENTIALS_FILE'])
    || (env === process.env ? getTelegramApiCredentialsFilePath(env) : '');
  const storedApi = readStoredTelegramApiCredentials(apiCredentialsFile);
  const apiId = envApiId || storedApi.apiId || 0;
  const apiHash = envApiHash || storedApi.apiHash || '';
  const apiCredentialsSource = (envApiId || envApiHash)
    ? ((storedApi.apiId || storedApi.apiHash) ? 'env+file' : 'env')
    : ((storedApi.apiId || storedApi.apiHash) ? 'file' : '');

  let session = firstEnv(env, ['TELEGRAM_SESSION', 'TELEGRAM_STRING_SESSION', 'TG_SESSION']);
  let sessionSource = session ? 'env' : '';
  const sessionFile = firstEnv(env, ['TELEGRAM_SESSION_FILE', 'TG_SESSION_FILE'])
    || (env === process.env ? getTelegramSessionFilePath(env) : '');
  if (!session && sessionFile) {
    try {
      if (existsSync(sessionFile)) {
        session = readFileSync(sessionFile, 'utf8').trim();
        if (session) sessionSource = 'file';
      }
    } catch {}
  }

  // Bot ka faisla: owner ka START selection > env ka custom bot > Hermes.
  // `activeOtpBotExplicit` sirf START/UI selection par true hota hai, isliye
  // operator ka env override tab tak chalta hai jab tak owner khud koi
  // source na chune (uske baad UI ka choice hi final hai).
  const envBotUsername = firstEnv(env, [
    'TELEGRAM_OTP_BOT_USERNAME',
    'TELEGRAM_OTP_BOT',
    'HERMES_BOT_USERNAME',
    'Hermeshu_BOT_USERNAME',
  ]).replace(/^@+/, '').trim();
  const live = env === process.env;
  const knownEnvProfile = otpBotProfileForUsername(envBotUsername);
  // Owner ne UI se koi bot chuna (explicit) → wahi final. Warna env ka bot:
  // agar woh Hermes/HardXotp hai to uski profile, warna custom-bot mode me
  // selected profile ke buttons + env ka username.
  const profile = (activeOtpBotExplicit && live)
    ? getOtpBotProfile(activeOtpBotProfileId)
    : (knownEnvProfile || getActiveOtpBotProfile());
  const botUsername = ((activeOtpBotExplicit && live) || !envBotUsername
    ? profile.username
    : envBotUsername).replace(/^@+/, '').trim();

  // Multi-account: TELEGRAM_SESSION_2.._8 ho to healthy account chuno.
  // Ek hi session ho to roster single-slot hai — behaviour bilkul purana.
  const accounts = roster.buildRoster(env, {
    fallbackSession: session,
    fallbackApiId: apiId,
    fallbackApiHash: apiHash,
  });
  let accountSlot = 0;
  let accountTag = accounts[0]?.tag || '';
  let accountCount = accounts.length;
  if (accounts.length > 1) {
    const picked = roster.pinnedAccountSlot() >= 0 && roster.isHealthy(roster.pinnedAccountSlot())
      ? roster.pinnedAccountSlot()
      : roster.nextHealthySlot(accounts);
    accountSlot = picked >= 0 ? picked : accounts[0].slot;
    const chosen = accounts.find((a) => a.slot === accountSlot) || accounts[0];
    if (chosen?.session) {
      session = chosen.session;
      sessionSource = 'roster';
      accountTag = chosen.tag;
    }
  }

  const missing = [];
  if (!apiId) missing.push('TELEGRAM_API_ID');
  if (!apiHash) missing.push('TELEGRAM_API_HASH');
  if (!session) missing.push('TELEGRAM_SESSION');

  return {
    apiId,
    apiHash,
    apiCredentialsFile,
    apiCredentialsSource,
    apiIdPresent: apiId > 0,
    apiHashPresent: Boolean(apiHash),
    sessionPresent: Boolean(session),
    session,
    sessionFile,
    sessionSource,
    botUsername: botUsername || DEFAULT_TELEGRAM_OTP_BOT_USERNAME,
    otpBotProfile: profile.id,
    otpBotProfileLabel: profile.label,
    otpBotTitle: profile.uiLabel,
    otpBotHint: profile.hint,
    otpBotExplicit: activeOtpBotExplicit && env === process.env,
    findButtonText: firstEnv(env, ['TELEGRAM_FIND_BUTTON_TEXT', 'Hermeshu_FIND_BUTTON_TEXT']),
    refreshButtonText: firstEnv(env, ['TELEGRAM_REFRESH_BUTTON_TEXT', 'Hermeshu_REFRESH_BUTTON_TEXT']),
    newButtonText: firstEnv(env, ['TELEGRAM_NEW_BUTTON_TEXT', 'Hermeshu_NEW_BUTTON_TEXT']),
    configured: missing.length === 0,
    missing,
    accountSlot,
    accountTag,
    accountCount,
    accounts,
  };
}

export function isTelegramOtpConfigured(env = process.env) {
  return getTelegramOtpConfig(env).configured;
}

export function resolveNumberSourceMode({ env = process.env, telegramSetting = false } = {}) {
  // Bot ke andar Hermes ON hai to wahi final hai. Render par purana
  // NUMBER_SOURCE=firebase bacha reh jaye tab bhi Hermes wale run me
  // Firebase pool/OTP galti se try nahi hona chahiye.
  if (telegramSetting) return 'telegram';
  const raw = firstEnv(env, ['NUMBER_SOURCE', 'PREMIUM_NUMBER_SOURCE', 'OTP_SOURCE']).toLowerCase();
  if (['telegram', 'hermes', 'hermeshu', 'hermeshu-bot', 'Hermeshu'].includes(raw)) return 'telegram';
  if (['firebase', 'firebase-pool', 'pool'].includes(raw)) return 'firebase';
  return isTelegramOtpConfigured(env) ? 'telegram' : 'firebase';
}

export function telegramOtpSetupHintLines(configOrEnv) {
  const config = configOrEnv && Array.isArray(configOrEnv.missing)
    ? configOrEnv
    : getTelegramOtpConfig(configOrEnv || process.env);
  const bot = config.botUsername || DEFAULT_TELEGRAM_OTP_BOT_USERNAME;
  return [
    `! <b>Telegram Hermes setup pending hai.</b>`,
    config.missing.length ? `› Missing: ${config.missing.map((k) => `<code>${k}</code>`).join(' · ')}` : '',
    ``,
    `› <b>Recommended:</b> is bot me <b>⚙️ Settings → Add Telegram Account</b> dabao aur spare/faltu account yahin login karo (bot default <code>@${bot}</code> hai).`,
    `› <b>1)</b> Agar Render env me API ID/hash nahi hai, <code>my.telegram.org</code> se spare-account API app ready rakho — bot private chat me sirf wohi maangega.`,
    `› <b>2)</b> Phir spare-account phone, Telegram login code aur agar 2FA ho to password lagega. Input messages delete karne ki koshish hogi; session chat me kabhi nahi dikhegi.`,
    `› <b>Safer fallback:</b> local PC par <code>npm run telegram:login</code>, phir session ko Render <code>TELEGRAM_SESSION</code> env me daalo.`,
    `› Render free disk restart/redeploy par mit sakti hai — long-term ke liye env session zyada durable hai.`,
    ``,
    `⚠️ Session string = poora Telegram account access. GitHub/chat me mat bhejo; spare account hi use karo, main account nahi.`,
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Hermeshu fancy/small-caps text + number-card parsing
// ---------------------------------------------------------------------------
const SMALL_CAPS_MAP = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G',
  'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N',
  'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V',
  'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};

export function normalizeTelegramFancyText(text = '') {
  const decomposed = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  return [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
}

function searchText(text = '') {
  return normalizeTelegramFancyText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function telegramButtonRole(text = '', profileOrId = null) {
  const profile = profileOrId || getActiveOtpBotProfile();
  return otpBotButtonRole(text, profile);
}

// Custom trained bots ke liye message helpers (custom-bot-runner.js).
export function telegramMessageText(message) {
  try { return String(message?.text || message?.message || message?.rawText || ''); } catch { return ''; }
}

export function telegramMessageId(message) {
  const raw = message?.id;
  if (typeof raw === 'bigint') return Number(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function extractPhoneFromSegment(segment = '') {
  const normalized = normalizeTelegramFancyText(segment);
  const match = normalized.match(/(?:\+?91[\s-]*)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/);
  return match ? normalizeIndianMobileNumber(match[0]) : null;
}

function extractPhone(text = '') {
  const normalized = normalizeTelegramFancyText(text);
  const lines = normalized.split(/\r?\n/);
  for (const line of lines) {
    if (!/\bnumber\b/i.test(searchText(line))) continue;
    const afterLabel = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
    const phone = extractPhoneFromSegment(afterLabel) || extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  for (const line of lines) {
    const s = searchText(line);
    if (/\bid\b/.test(s)) continue; // welcome card ki Telegram ID mobile jaisi lag sakti hai
    const phone = extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  // Poori text wale fallback me bhi ID wali lines hata do. Screenshot wale
  // welcome card par `ID: 7458637854` khud valid 10-digit mobile jaisa hai;
  // use Hermes number samajhna claim ko galat phone par le ja sakta tha.
  const withoutIdLines = lines
    .filter((line) => !/^\s*(?:telegram\s*)?id\b/i.test(searchText(line)))
    .join('\n');
  return extractPhoneFromSegment(withoutIdLines);
}

function extractTelegramCardPhone(text = '') {
  const lines = normalizeTelegramFancyText(text).split(/\r?\n/);
  for (const line of lines) {
    const normalizedLine = searchText(line);
    if (!/\b(number|mobile|phone)\b/.test(normalizedLine)) continue;
    if (/\b(find|search|active numbers|live indian numbers)\b/.test(normalizedLine)) continue;
    const afterLabel = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
    const phone = extractPhoneFromSegment(afterLabel) || extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  return null;
}

function labelledValue(text, label) {
  const lines = normalizeTelegramFancyText(text).split(/\r?\n/);
  for (const line of lines) {
    if (!searchText(line).includes(label)) continue;
    if (!line.includes(':')) continue;
    return line.slice(line.indexOf(':') + 1).trim();
  }
  return '';
}

function parseHermesText(text = '') {
  const normalized = normalizeTelegramFancyText(text);
  const phone = extractPhone(normalized);

  const statusRaw = labelledValue(normalized, 'status');
  const status = (statusRaw.match(/[A-Za-z]+/) || [''])[0].toUpperCase();
  const deviceRaw = labelledValue(normalized, 'device');
  const device = (deviceRaw.match(/[A-Za-z0-9._-]+/) || [''])[0];

  const cleanSenderValue = (value = '') => String(value || '')
    .split(/\s*(?:\||→|=>|-{2,}|OTP\b)/i)[0]
    .trim()
    .replace(/^[{([<>\s]+|[\]})<>\s,;:]+$/g, '')
    .slice(0, 80);
  const senderMatch = normalized.match(/LAST\s+SMS\s*(?:[:\-]\s*)?[\[({\u003e]\s*([^\]\)}\n\u003c]+)\s*[\])}]/i)
    || normalized.match(/LAST\s+SMS\s*(?:FROM\s*)?[:\-]\s*([A-Za-z0-9][A-Za-z0-9 ._-]{1,79})/i)
    || normalized.match(/(?:^|\n)\s*(?:SENDER|FROM)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 ._-]{1,79})/i)
    || normalized.match(/[\[({\u003e]\s*([A-Z0-9._-]*(?:SWIGGY|SWI-GY|SWGTNS)[A-Z0-9._-]*)\s*[\])}]/i);
  const sender = senderMatch ? cleanSenderValue(senderMatch[1]) : '';

  let code = '';
  for (const line of normalized.split(/\r?\n/)) {
    const m = line.match(/\bOTP\b\s*[:\-]?\s*(\d{6})(?!\d)/i);
    if (m) { code = m[1]; break; }
  }
  if (!code) code = _extractSixDigitCode(normalized);

  const rawTime = (normalized.match(/(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}\s*\|\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)/i) || [])[1] || '';
  const smsTimeMs = rawTime ? (parseForwarderDateTime(rawTime) || 0) : 0;
  const signature = code ? [sender, code, smsTimeMs || rawTime, phone || ''].join('|') : '';

  return {
    phone,
    status,
    device,
    sender,
    code,
    rawTime,
    smsTimeMs,
    signature,
    lastSms: code ? { sender, code, rawTime, smsTimeMs, signature } : null,
    normalizedText: normalized,
  };
}

export function parseTelegramNumberCard(text = '') {
  const parsed = parseHermesText(text);
  // Number card ke liye sirf explicit NUMBER/MOBILE/PHONE label wala phone
  // chalega. Welcome card ki Telegram ID ya koi aur 10-digit number ko
  // Hermes ka current number nahi mana jayega.
  const phone = extractTelegramCardPhone(text);
  if (!phone) return null;
  const signature = parsed.code
    ? [parsed.sender, parsed.code, parsed.smsTimeMs || parsed.rawTime, phone].join('|')
    : '';
  return {
    ...parsed,
    phone,
    signature,
    lastSms: parsed.lastSms ? { ...parsed.lastSms, signature } : null,
  };
}

export function parseTelegramOtpText(text = '') {
  const parsed = parseHermesText(text);
  return parsed.code ? parsed : null;
}

export function extractTelegramOtpFromText(text = '') {
  return parseHermesText(text).code || '';
}

// Hermes ki sirf SABSE LATEST button-screen hi asal current screen hai.
// Purani number-card par chipka NEW NUMBER ya purani welcome par chipka
// FIND NUMBER stale hai — use click karna hi 4-minute wale claim-stuck ki
// ek asal wajah thi. Is selector ka rule bilkul owner ke instruction jaisa
// hai: latest screen par NEW ho to NEW, warna FIND. Latest screen par koi
// claim button na ho to purani screens me bilkul nahi ghusenge.
export function _selectHermesLatestScreenAction(screens = [], {
  mode = 'claim',
  phone = '',
  profileId = null,
} = {}) {
  // Dono OTP bots (Hermes / HardXotp) ke liye ek hi strict rule: sirf
  // sabse latest button-screen dekho — NEW ho to NEW, warna FIND
  // (HardXotp me GET NUMBERS). Purani screens ke stale buttons kabhi
  // click nahi hote.
  return selectOtpBotScreenAction(screens, {
    mode,
    phone,
    profileId: profileId || getActiveOtpBotProfile().id,
    cardPhoneOf: (text) => parseTelegramNumberCard(text)?.phone || '',
  });
}

// ---------------------------------------------------------------------------
// Teleproto user-client singleton
// ---------------------------------------------------------------------------
let teleprotoPromise = null;
let clientPromise = null;
let clientRef = null;
let entityRef = null;
let entityCacheKey = '';
let lockTail = Promise.resolve();

const providerState = {
  connected: false,
  authorized: false,
  loginInProgress: false,
  meLabel: '',
  currentPhone: '',
  currentEntry: null,
  currentConsumed: false,
  currentMessageId: 0,
  lastError: '',
  lastActionAt: 0,
  lastCheckedAt: 0,
  lastScreenButtons: [],
  lastClickedButton: '',
  lastClickedRole: '',
  lastCallbackMessage: '',
  claimPhase: '',
  trackedOtpMessageIds: [],
  lastOtpText: '',
  lastOtpScan: null,
};

// ---------------------------------------------------------------------------
// Per-slot parallel context — 5 (or more) spare accounts ko ek saath chalane
// ke liye. Har slot ke apne client, entity cache, providerState aur lock hai.
// Global singleton sirf fallback hai (slot 0 / legacy single-account flow).
// ---------------------------------------------------------------------------
const slotContexts = new Map(); // slot -> SlotContext

function createSlotContext(slot, config) {
  return {
    slot,
    config,
    clientRef: null,
    clientPromise: null,
    entityRef: null,
    entityCacheKey: '',
    lockTail: Promise.resolve(),
    providerState: {
      connected: false,
      authorized: false,
      loginInProgress: false,
      meLabel: '',
      currentPhone: '',
      currentEntry: null,
      currentConsumed: false,
      currentMessageId: 0,
      lastError: '',
      lastActionAt: 0,
      lastCheckedAt: 0,
      lastScreenButtons: [],
      lastClickedButton: '',
      lastClickedRole: '',
      lastCallbackMessage: '',
      claimPhase: '',
      trackedOtpMessageIds: [],
      lastOtpText: '',
      lastOtpScan: null,
    },
  };
}

export function getSlotContext(slot, config) {
  const s = Number(slot) || 0;
  let ctx = slotContexts.get(s);
  if (!ctx) {
    ctx = createSlotContext(s, config);
    slotContexts.set(s, ctx);
  }
  return ctx;
}

// Helper: resolve a context reference — null means "use global singleton"
function resolveCtx(ctx) {
  return ctx || null;
}

function getClientRef(ctx) {
  return ctx ? ctx.clientRef : clientRef;
}

function getProviderState(ctx) {
  return ctx ? ctx.providerState : providerState;
}

function getEntityRef(ctx) {
  return ctx ? ctx.entityRef : entityRef;
}

function getEntityCacheKey(ctx) {
  return ctx ? ctx.entityCacheKey : entityCacheKey;
}

function setClientRef(client, ctx) {
  if (ctx) ctx.clientRef = client; else clientRef = client;
}

function setEntityRef(entity, key, ctx) {
  if (ctx) { ctx.entityRef = entity; ctx.entityCacheKey = key; }
  else { entityRef = entity; entityCacheKey = key; }
}

function resetClientForContext(reason, ctx) {
  if (ctx) {
    try { ctx.clientRef?.disconnect?.(); } catch {}
    ctx.clientRef = null;
    ctx.clientPromise = null;
    ctx.entityRef = null;
    ctx.entityCacheKey = '';
    ctx.providerState.connected = false;
    ctx.providerState.authorized = false;
    ctx.providerState.lastActionAt = Date.now();
    ctx.providerState.lastScreenButtons = [];
    ctx.providerState.claimPhase = reason;
  } else {
    try { clientRef?.disconnect?.(); } catch {}
    clientRef = null;
    clientPromise = null;
    entityRef = null;
    entityCacheKey = '';
    providerState.connected = false;
    providerState.authorized = false;
    providerState.lastActionAt = Date.now();
    providerState.lastScreenButtons = [];
    providerState.claimPhase = reason;
  }
}

// Per-slot lock — har slot ka apna lockTail, alag accounts ek saath chal sakte hain.
async function withSlotLock(slot, fn) {
  const ctx = getSlotContext(slot, null);
  if (telegramLockCtx.getStore() === TELEGRAM_LOCK_TOKEN) {
    return fn();
  }
  const previous = ctx.lockTail.catch(() => {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  ctx.lockTail = previous.then(() => gate);
  try {
    await previous;
  } finally {}
  try {
    return await telegramLockCtx.run(TELEGRAM_LOCK_TOKEN, fn);
  } finally {
    release();
  }
}

// Parallel claim — N slots par ek saath number claim.
// Har slot apne client se claim karta hai, alag lock per slot.
export async function claimNumbersParallel(slots, opts = {}) {
  const slotList = (Array.isArray(slots) ? slots : [slots])
    .map((s) => Number(s) || 0)
    .filter((s) => s >= 0);
  const maxParallel = Math.max(1, Number(opts.maxParallel) || slotList.length || 1);
  const results = await Promise.allSettled(
    slotList.slice(0, maxParallel).map(async (slot) => {
      const config = getTelegramOtpConfigForSlot(slot);
      const ctx = getSlotContext(slot, config);
      const entry = await withSlotLock(slot, () => claimNumberWithActiveAccount(opts, ctx));
      return { slot, entry };
    })
  );
  const claimed = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      claimed.push(results[i].value);
    } else {
      errors.push({ slot: slotList[i], error: results[i].reason });
    }
  }
  return { claimed, errors };
}

function getTelegramOtpConfigForSlot(slot) {
  const env = process.env;
  const baseConfig = getTelegramOtpConfig(env);
  if (slot === 0 || Number(baseConfig.accountCount || 1) <= 1) return baseConfig;
  const sessionEnvKey = `TELEGRAM_SESSION_${slot}`;
  const session = String(env[sessionEnvKey] || env[`TELEGRAM_SESSION_${slot}`] || '');
  return {
    ...baseConfig,
    session: session || baseConfig.session,
    accountSlot: slot,
    accountTag: baseConfig.accountTag ? `${baseConfig.accountTag}-${slot}` : `slot-${slot}`,
  };
}

// Get list of configured spare account slots from env.
export function getParallelSlots(min = 1) {
  const baseConfig = getTelegramOtpConfig(process.env);
  const slots = [];
  if (baseConfig.configured) slots.push(0);
  for (let s = 1; s <= 8; s++) {
    const sessionEnvKey = `TELEGRAM_SESSION_${s}`;
    if (String(process.env[sessionEnvKey] || '').trim()) slots.push(s);
  }
  // At least `min` slots — agar kam hain to slot 0 hi repeat kar do
  while (slots.length < min) slots.push(0);
  return slots.slice(0, Math.max(min, slots.length));
}

// Parallel OTP wait — N slots par ek saath OTP wait.
// Har slot apne client se OTP poll karta hai, alag lock per slot.
export async function waitForOtpCodesParallel(entries, opts = {}) {
  const items = (Array.isArray(entries) ? entries : [entries])
    .filter((e) => e && e.phone);
  const maxParallel = Math.max(1, Number(opts.maxParallel) || items.length || 1);
  const results = await Promise.allSettled(
    items.slice(0, maxParallel).map(async (item) => {
      const slot = Number(item.slot) || 0;
      const config = getTelegramOtpConfigForSlot(slot);
      const ctx = getSlotContext(slot, config);
      const code = await withSlotLock(slot, () =>
        waitForTelegramOtpCode(item.phone, opts, ctx)
      );
      return { slot, phone: item.phone, ...code };
    })
  );
  const codes = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      codes.push(results[i].value);
    } else {
      errors.push({ slot: Number(items[i].slot) || 0, phone: items[i].phone, error: results[i].reason });
    }
  }
  return { codes, errors };
}

// Parallel discard — N slots ka current number discard karo.
export function discardCurrentNumbersParallel(items, ctx) {
  for (const item of (Array.isArray(items) ? items : [items])) {
    if (!item) continue;
    discardCurrentTelegramNumber(item.phone || item.reason || '', ctx || (item.slot ? getSlotContext(item.slot, null) : null));
  }
}

export function isTelegramLoginInProgress(ctx) {
  return Boolean(getProviderState(ctx).loginInProgress);
}

export function normalizeTelegramLoginPhone(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const hadPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (hadPlus) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : '';
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  // Country code ke saath diye gaye non-Indian numbers bhi E.164 me rehne do.
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return '';
}

function setLastError(error, ctx) {
  const ps = getProviderState(ctx);
  const classified = classifyTelegramError(error);
  const raw = String(error?.message || error || '').slice(0, 190);
  ps.lastErrorCode = classified.code;
  ps.lastErrorHint = classified.hint;
  ps.lastErrorLabel = classified.label;
  ps.lastError = classified.code && classified.code !== 'UNKNOWN'
    ? `${classified.label} — ${raw}`
    : raw.slice(0, 220);
}

// ---------------------------------------------------------------------------
// Generic spare-account session hook — OTP bot ke ilawa doosre Telegram bots
// (jaise @SwiggyByWorldBot) ko bhi ISI client/lock par chalane ke liye.
// Ek hi session par do client = FLOOD_WAIT/session revoke, isliye lock shared.
// ---------------------------------------------------------------------------
export function withTelegramUserClient(fn, ctx) {
  return withTelegramLock(async () => {
    const { client, config } = await ensureClientUnlocked(ctx);
    return fn({ client, config });
  });
}

export async function telegramUserClientStatus(ctx) {
  try {
    const config = getTelegramOtpConfig();
    return {
      configured: Boolean(config.configured),
      missing: [...(config.missing || [])],
      connected: Boolean(getProviderState(ctx).connected),
      authorized: Boolean(getProviderState(ctx).authorized),
      me: getProviderState(ctx).meLabel || '',
      loginInProgress: Boolean(getProviderState(ctx).loginInProgress),
      lastError: getProviderState(ctx).lastError || '',
    };
  } catch (e) {
    return { configured: false, missing: [], connected: false, authorized: false, me: '', loginInProgress: false, lastError: String(e?.message || e) };
  }
}

// 🔒 Ek hi Telegram session par do kaam nahi (warna FLOOD_WAIT/session revoke).
// Par lock RE-ENTRANT hona chahiye: world-bot login poora `withTelegramUserClient`
// ke andar chalta hai aur usi ke andar OTP fetch (`snapshotTelegramOtpState` /
// `waitForTelegramOtpCode`) bhi wahi lock maangta hai. Pehle wo apne hi lock ka
// intezaar karta reh jata tha = DEADLOCK → OTP kabhi aata hi nahi tha, world bot
// me type bhi nahi hota tha. Ab usi async context me dubara lock maangne par
// seedha andar chala jata hai.
const telegramLockCtx = new AsyncLocalStorage();
const TELEGRAM_LOCK_TOKEN = Symbol('telegram-lock-owner');
let telegramLockWaiters = 0;

export function telegramLockState() {
  return {
    inside: telegramLockCtx.getStore() === TELEGRAM_LOCK_TOKEN,
    waiters: telegramLockWaiters,
  };
}

async function withTelegramLock(fn) {
  if (telegramLockCtx.getStore() === TELEGRAM_LOCK_TOKEN) {
    // Same async context — pehle se humare paas lock hai.
    console.log('[TelegramLock] ↪︎ re-entrant call (deadlock se bachaav)');
    return fn();
  }
  const previous = lockTail.catch(() => {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  lockTail = previous.then(() => gate);
  telegramLockWaiters += 1;
  try {
    await previous;
  } finally {
    telegramLockWaiters = Math.max(0, telegramLockWaiters - 1);
  }
  try {
    return await telegramLockCtx.run(TELEGRAM_LOCK_TOKEN, fn);
  } finally {
    release();
  }
}

// Tests: nested lock deadlock na ho (world-bot OTP fetch).
export async function _withTelegramLockForTests(fn) {
  return withTelegramLock(fn);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

async function sleepInterruptibly(ms, shouldAbort) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return;
    await sleep(Math.min(250, end - Date.now()));
  }
}

async function loadTeleproto() {
  if (!teleprotoPromise) {
    teleprotoPromise = Promise.all([
      import('teleproto'),
      import('teleproto/sessions'),
      import('teleproto/tl/generated/api.js'),
    ]).then(([main, sessions, apiMod]) => {
      // ⚡ CodeSettings patch — Telegram login code SMS par aana zaroori hai.
      // teleproto ke requestCode() me `new Api.CodeSettings({})` hardcoded hai,
      // jisse server khud delivery type (app/call/SMS) decide karta hai.
      // forceSMS sirf tab kaam karta hai jab server pehle se SMS offer karta hai.
      //
      // ⚠️ DHAYAN RAHE: TL serializer (`fieldCodec.js` → `isAbsent()`) ke karan
      // `false` bhi "absent" maanta hai boolean flag fields ke liye. Isliye
      // `allowAppHash = false` etc. set karne ka koi asar nahi — serializer
      // unhe skip karta hai. Patch sirf `appSandbox` (Bool type) par kaam karta
      // hai, jo SMS delivery se related nahi hai.
      //
      // Sahi fix: `client.invoke` ko wrap karke `SendCode` response intercept
      // karta hai. Agar code SMS nahi aaya (app/call/firebase), to forced
      // `ResendCode` se dobara SMS request karta hai. Yeh `forceSMS` se bhi
      // zyada reliable hai kyunki yeh server ki `nextType` limitation se
      // baahar nikal kar directly ResendCode bhejta hai.
      try {
        const CodeSettings = apiMod.Api?.CodeSettings;
        if (CodeSettings && !CodeSettings.__smsPatched) {
          const origCtor = CodeSettings;
          CodeSettings.__smsPatched = true;
          const patched = function CodeSettingsSmsOnly(...args) {
            const inst = new origCtor(...args);
            // TL serializer `false` ko absent maanta hai boolean flags ke liye,
            // isliye inhe explicitly set karne ka asar nahi. Par `appSandbox`
            // Bool type hai — yahan `false` serialized hota hai.
            inst.appSandbox = false;
            return inst;
          };
          patched.prototype = origCtor.prototype;
          Object.assign(patched, origCtor);
          apiMod.Api.CodeSettings = patched;
        }
      } catch {
        // Patch fail to normal flow chale — invoke wrapper forceSMS try karega
      }
      return {
        TelegramClient: main.TelegramClient,
        StringSession: sessions.StringSession,
        apiMod,
      };
    });
  }
  return teleprotoPromise;
}

export async function createTelegramUserClient(sessionString = '', config = getTelegramOtpConfig()) {
  const cfg = config && (config.apiHash !== undefined || config.apiId !== undefined)
    ? config
    : getTelegramOtpConfig(config || process.env);
  if (!cfg.apiId || !cfg.apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing hai (my.telegram.org se spare account ki API app banao)');
  }
  const { TelegramClient, StringSession, apiMod } = await loadTeleproto();
  const client = new TelegramClient(new StringSession(String(sessionString || '')), cfg.apiId, cfg.apiHash, {
    connectionRetries: 3,
    requestRetries: 2,
    autoReconnect: true,
    reconnectRetries: 3,
    floodSleepThreshold: 20,
    deviceModel: 'Swiggy Fresh Hermes Client',
    systemVersion: process.version,
    appVersion: '1.0.0',
    langCode: 'en',
    systemLangCode: 'en',
  });

  // ⚡ Invoke wrapper — SendCode response intercept karke SMS-only enforce karta hai.
  // teleproto ke preferSms() sirf tab kaam karta hai jab server ki `nextType`
  // SMS ho. Agar server app/call/firebase bhejta hai aur nextType SMS nahi hai,
  // to forceSMS bekaar ho jata hai. Is wrapper se hum direct ResendCode bhejte
  // hain agar SendCode ka response SMS nahi hai — server ko dobara SMS ke liye
  // force karta hai.
  const originalInvoke = client.invoke.bind(client);
  let smsForceAttempted = false;
  client.invoke = async (request) => {
    try {
      const result = await originalInvoke(request);
      // Agar yeh auth.SendCode request tha aur result SentCode hai
      if (request?.className === 'SendCode' && result) {
        const Api = apiMod?.Api;
        if (Api && result instanceof Api.auth?.SentCode) {
          const isSms = result.type instanceof Api.auth?.SentCodeTypeSms;
          if (!isSms && !smsForceAttempted) {
            smsForceAttempted = true;
            console.log('[TelegramLogin] ⚡ SendCode response SMS nahi — ResendCode se SMS enforce kar raha');
            try {
              const resendResult = await originalInvoke(new Api.auth.ResendCode({
                phoneNumber: request.phoneNumber,
                phoneCodeHash: result.phoneCodeHash,
              }));
              // ResendCode bhi SMS nahi laya to wapas original result de do
              if (resendResult instanceof Api.auth?.SentCode
                && resendResult.type instanceof Api.auth?.SentCodeTypeSms) {
                return resendResult;
              }
              console.warn('[TelegramLogin] ⚠️ ResendCode se bhi SMS nahi aaya — original result use kar raha');
            } catch (resendErr) {
              console.warn('[TelegramLogin] ⚠️ ResendCode fail:', String(resendErr?.message || resendErr).slice(0, 120));
            }
          }
        }
      }
      return result;
    } finally {
      // Next SendCode attempt pe reset karo
      if (request?.className === 'SendCode') {
        smsForceAttempted = false;
      }
    }
  };

  return client;
}

export function _isTelegramClientConnectionError(error) {
  const msg = String(error?.message || error || '');
  return /(AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|not connected|disconnected|Connection closed|ECONNRESET|EPIPE|socket|timed?\s*out|timeout|network)/i.test(msg);
}

function invalidateClient(error, ctx) {
  if (!_isTelegramClientConnectionError(error)) return;
  resetClientForContext('invalidate', ctx);
}

function telegramClientLooksConnected(client) {
  if (!client) return false;
  try {
    if (typeof client.connected === 'boolean') return client.connected;
    if (typeof client._connected === 'boolean') return client._connected;
    if (typeof client.isConnected === 'function') return Boolean(client.isConnected());
  } catch {}
  return true;
}

export { telegramClientLooksConnected as _telegramClientLooksConnected };

async function ensureClientUnlocked(ctx) {
  const ps = getProviderState(ctx);
  if (ps.loginInProgress) {
    throw new Error('Telegram account login chal raha hai — pehle Add Telegram Account complete ya cancel karo.');
  }
  // ctx null hai to global singletons use ho — koi globalContext object ki
  // zaroorat nahi, helpers (getClientRef, getEntityRef etc.) khud fallback
  // karte hain ctx=null ke liye.
  const config = (ctx?.config) || getTelegramOtpConfig();
  if (ctx) ctx.config = config;
  if (!config.configured) {
    throw new Error(`Telegram Hermes setup missing hai: ${config.missing.join(', ')}`);
  }
  const curClient = getClientRef(ctx);
  if (curClient && ps.connected && telegramClientLooksConnected(curClient)) return { client: curClient, config };
  if (curClient && !telegramClientLooksConnected(curClient)) {
    // Render/network jhatke ke baad Teleproto socket mar sakta hai lekin
    // providerState purana connected=true dikhata rehta tha — phir har
    // claim wahi murda client use karke batch ko exhausted bana deta tha.
    resetClientForContext('stale-client', ctx);
  }
  const curPromise = ctx ? ctx.clientPromise : clientPromise;
  if (curPromise) return curPromise;

  const newPromise = (async () => {
    const client = await createTelegramUserClient(config.session, config);
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (!authorized) {
      // Auth fail = ye account (session) mara hua hai — roster me mark karo
      // taaki agli claim doosra spare account uthaye, batch na ruke.
      roster.markAccountFailure(config.accountSlot, new Error('AUTH_KEY_UNREGISTERED session authorized nahi'));
      throw new Error('Telegram session authorized nahi hai — Settings → Add Telegram Account se spare account dobara login karo (ya local fallback: npm run telegram:login)');
    }
    let meLabel = '';
    try {
      const me = await client.getMe();
      meLabel = me?.username ? `@${me.username}` : [me?.firstName, me?.lastName].filter(Boolean).join(' ');
    } catch {}
    setClientRef(client, ctx);
    roster.markAccountHealthy(config.accountSlot, { me: meLabel });
    Object.assign(ps, {
      connected: true,
      authorized: true,
      meLabel,
      accountSlot: config.accountSlot,
      accountTag: config.accountTag,
      lastError: '',
      lastCheckedAt: Date.now(),
    });
    return { client, config };
  })().catch((error) => {
    if (ctx) { ctx.clientPromise = null; ctx.clientRef = null; ctx.entityRef = null; ctx.entityCacheKey = ''; }
    else { clientPromise = null; clientRef = null; entityRef = null; entityCacheKey = ''; }
    ps.connected = false;
    ps.authorized = false;
    setLastError(error, ctx);
    throw error;
  });
  if (ctx) ctx.clientPromise = newPromise; else clientPromise = newPromise;
  return newPromise;
}

async function ensureEntityUnlocked(client, config, ctx) {
  const key = String(config.botUsername || '').toLowerCase();
  if (getEntityRef(ctx) && getEntityCacheKey(ctx) === key) return getEntityRef(ctx);
  const entity = await client.getEntity(`@${config.botUsername}`);
  setEntityRef(entity, key, ctx);
  return entity;
}

function isIncomingMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (typeof message.out === 'boolean') return !message.out;
  return true;
}

function messageText(message) {
  try { return String(message?.text || message?.message || message?.rawText || ''); } catch { return ''; }
}

function messageId(message) {
  const raw = message?.id;
  if (typeof raw === 'bigint') return Number(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function telegramTsToMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime() || 0;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

const messageDateMs = (message) => telegramTsToMs(message?.date);
const messageEditMs = (message) => telegramTsToMs(message?.editDate) || messageDateMs(message);

function messageSignature(message) {
  return `${messageId(message)}|${messageEditMs(message)}|${messageText(message)}`;
}

// FIND / NEW ke baad sirf SABSE LATEST number-card hi try hogi.
// Purana wait saari history scan karke pehla aisa card utha sakta tha jo
// baseline (sirf 6 messages) me nahi tha — yani click se PEHLA wala number
// galti se "naya" ban jata tha. Ab pehli parseable latest card par hi
// faisla hoga: woh baseline/click se pehle ki hai to wait chalega, excluded
// hai to wahi latest excluded mani jayegi; usse peeche wale purane cards
// kabhi fallback ke roop me try nahi honge.
export function _selectLatestFreshHermesNumberCard(messages = [], {
  baselineSignatures = new Set(),
  excludePhones = new Set(),
  afterMessageId = 0,
  afterSignature = '',
  afterPhone = '',
} = {}) {
  const excluded = new Set(
    [...(excludePhones || [])]
      .map((phone) => String(phone || '').replace(/\D/g, '').slice(-10))
      .filter(Boolean)
  );
  const cursorId = Number(afterMessageId) || 0;
  const cursorPhone = String(afterPhone || '').replace(/\D/g, '').slice(-10);

  for (const message of Array.isArray(messages) ? messages : []) {
    const card = parseTelegramNumberCard(messageText(message));
    if (!card?.phone) continue;

    const signature = messageSignature(message);
    const result = { message, card, signature };
    if (baselineSignatures?.has?.(signature)) {
      return { status: 'baseline-latest', result };
    }

    const currentId = messageId(message);
    if (cursorId > 0 && currentId > 0) {
      if (currentId < cursorId) {
        return { status: 'before-click-latest', result };
      }
      if (currentId === cursorId) {
        // Clicked screen khud edit hokar naya card ban sakti hai. Wahi
        // purana phone/signature ho to ye click ka naya jawab nahi hai.
        if (!afterSignature || signature === afterSignature) {
          return { status: 'baseline-latest', result };
        }
        if (cursorPhone && card.phone === cursorPhone) {
          return { status: 'baseline-latest', result };
        }
      }
    }

    if (excluded.has(card.phone)) {
      return { status: 'excluded-latest', result };
    }
    return { status: 'fresh', result };
  }

  return { status: 'none', result: null };
}

async function fetchIncomingUnlocked(limit = 10, ctx) {
  try {
    const { client, config } = await ensureClientUnlocked(ctx);
    const entity = await ensureEntityUnlocked(client, config, ctx);
    const messages = await client.getMessages(entity, { limit: Math.max(1, Number(limit) || 10) });
    const arr = Array.isArray(messages) ? messages : [...(messages || [])];
    getProviderState(ctx).lastCheckedAt = Date.now();
    return arr.filter(isIncomingMessage);
  } catch (error) {
    invalidateClient(error, ctx);
    setLastError(error, ctx);
    throw error;
  }
}

function buttonText(button) {
  try { return String(button?.text || button?.button?.text || ''); } catch { return ''; }
}

async function getMessageButtons(message) {
  let rows;
  // Teleproto ke sync `buttons` getter se pehle dekho. Har purani message
  // par async getButtons()/reload ghumana claim ko bekaar slow karta tha;
  // asal action bhi sirf latest screen par hi lena hai.
  try { rows = message?.buttons; } catch {}
  if (!rows) {
    try {
      rows = typeof message?.getButtons === 'function'
        ? await message.getButtons()
        : null;
    } catch {}
  }
  if (!rows) rows = message?._buttons || (message?._buttonsFlat ? [message._buttonsFlat] : []);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (Array.isArray(row) ? row : [row])).filter(Boolean);
}

function buttonMatchesRole(button, role, config) {
  const text = buttonText(button);
  const custom = role === 'find'
    ? config.findButtonText
    : role === 'refresh'
      ? config.refreshButtonText
      : role === 'new'
        ? config.newButtonText
        : '';
  if (custom) {
    const a = searchText(text);
    const b = searchText(custom);
    if (a && b && (a.includes(b) || b.includes(a))) return true;
  }
  const profileId = config?.otpBotProfile || null;
  // 'view' HardXotp ka messages button hai; Hermes profile me ye role kabhi
  // nahi milta, isliye purana behaviour safe rehta hai.
  return telegramButtonRole(text, profileId) === role;
}

function roleForHermesButton(button, config) {
  // Kisi bhi profile me claim/find/new/refresh/view ho sakta hai (HardXotp
  // me "VIEW MESSAGES" hi refresh ka kaam karta hai).
  for (const role of ['refresh', 'view', 'new', 'find']) {
    if (buttonMatchesRole(button, role, config)) return role;
  }
  return '';
}

async function latestHermesScreenUnlocked(limit = 6, ctx) {
  const { config } = await ensureClientUnlocked(ctx);
  const messages = await fetchIncomingUnlocked(limit, ctx);
  for (const message of messages) {
    const buttons = await getMessageButtons(message);
    const entries = buttons
      .map((button) => ({
        button,
        text: buttonText(button),
        role: roleForHermesButton(button, config),
      }))
      .filter((entry) => entry.text);
    if (!entries.length) continue;

    const text = messageText(message);
    const screen = {
      message,
      text,
      entries,
      buttons: entries.map((entry) => entry.text),
      buttonRoles: entries.map((entry) => entry.role),
      card: parseTelegramNumberCard(text),
    };
    getProviderState(ctx).lastScreenButtons = [...screen.buttons];
    return screen;
  }
  getProviderState(ctx).lastScreenButtons = [];
  return null;
}

async function clickLatestHermesButtonUnlocked({ mode = 'claim', phone = '' } = {}, ctx) {
  const screen = await latestHermesScreenUnlocked(6, ctx);
  const ps = getProviderState(ctx);
  if (!screen) {
    ps.claimPhase = 'no-latest-screen';
    return { ok: false, reason: 'no-latest-screen', screenButtons: [] };
  }

  const action = _selectHermesLatestScreenAction([screen], { mode, phone });
  ps.claimPhase = action?.role
    ? `click-${action.role}`
    : (action?.reason || 'no-button-on-latest-screen');
  if (!action?.role || action.buttonIndex < 0) {
    console.log(`[Hermes] Latest screen par ${mode} button nahi mila. Buttons: ${screen.buttons.join(' | ') || 'none'}`);
    return {
      ok: false,
      reason: action?.reason || 'no-button-on-latest-screen',
      messageId: messageId(screen.message),
      screenButtons: [...screen.buttons],
      cardPhone: screen.card?.phone || '',
    };
  }

  const entry = screen.entries[action.buttonIndex];
  const answer = await entry.button.click({});
  const callbackMessage = String(answer?.message || '').trim().slice(0, 180);
  ps.lastActionAt = Date.now();
  ps.lastError = '';
  ps.lastClickedButton = entry.text;
  ps.lastClickedRole = action.role;
  ps.lastCallbackMessage = callbackMessage;
  ps.claimPhase = `clicked-${action.role}`;
  console.log(
    `[Hermes] Latest screen button click: ${entry.text} (${action.role})` +
    `${callbackMessage ? ` — callback: ${callbackMessage}` : ''}`
  );
  return {
    ok: true,
    role: action.role,
    messageId: messageId(screen.message),
    screenSignature: messageSignature(screen.message),
    buttonText: entry.text,
    screenButtons: [...screen.buttons],
    cardPhone: screen.card?.phone || '',
    callbackMessage,
    callbackAlert: Boolean(answer?.alert),
  };
}

async function clickButtonUnlocked(role, { phone = '' } = {}) {
  return clickLatestHermesButtonUnlocked({
    mode: role === 'refresh' ? 'refresh' : 'claim',
    phone,
  });
}

// 🔄 OTP ke liye REFRESH — owner ka rule: OTP Sent ke baad OTP bot me **har
// second** refresh dabao, 20s me OTP aa jaye to copy karke world bot me do.
//  1) Latest button-screens me (12 tak) refresh button dhundo aur click karo
//     (sirf usi screen ka jiska card number match kare).
//  2) Button na mile / click phate to button ka TEXT likh kar bhejo.
// Pehle sirf "latest" screen dekhi jati thi — agar latest screen kisi aur
// number ki card hoti to refresh hi nahi hota tha aur bot Cancel kar deta tha.
async function refreshHermesChatUnlocked({ phone = '', attempt = 0 } = {}, ctx) {
  const { client, config } = await ensureClientUnlocked(ctx);
  const wanted = String(phone || '').replace(/\D/g, '').slice(-10);
  const profile = getActiveOtpBotProfile();
  // 🎓 Custom trained bot — owner ki refresh training hi chalti hai.
  if (profile?.custom && customBotRefreshRunner) {
    try {
      const r = await customBotRefreshRunner({
        client,
        config,
        botId: profile.botId || profile.id,
        phone: wanted,
        attempt,
        timeoutMs: 12_000,
      });
      if (r?.ok) {
        getProviderState(ctx).claimPhase = `refresh-training-${attempt || 1}`;
        getProviderState(ctx).lastActionAt = Date.now();
        getProviderState(ctx).lastError = '';
        getProviderState(ctx).lastClickedButton = String(r.steps?.[r.steps.length - 1]?.detail || 'training').slice(0, 90);
        console.log(`[CustomBot] 🔄 REFRESH #${attempt || 1} (training) — ${getProviderState(ctx).lastClickedButton}`);
        return { ok: true, via: 'training', buttonText: getProviderState(ctx).lastClickedButton || 'training' };
      }
      getProviderState(ctx).claimPhase = 'refresh-training-failed';
      getProviderState(ctx).lastError = String(r?.error || 'refresh training failed').slice(0, 180);
      console.warn(`[CustomBot] REFRESH training fail: ${String(r?.error || 'unknown').slice(0, 140)}`);
      return { ok: false, reason: `training: ${String(r?.error || 'refresh training failed').slice(0, 90)}` };
    } catch (error) {
      getProviderState(ctx).claimPhase = 'refresh-training-error';
      getProviderState(ctx).lastError = String(error?.message || error).slice(0, 180);
      return { ok: false, reason: `training-error: ${String(error?.message || error).slice(0, 80)}` };
    }
  }
  const allowed = profile.refreshRoles || ['refresh'];
  let lastReason = 'no-refresh-button';
  // 🟡 Card kisi aur number ka ho (world bot ka pichla number) tab pehle usko
  // chhodte the — aur agar chat me sirf wahi card pada ho to 20-21 refresh
  // attempts ke baad bhi "Refresh" kabhi click hi nahi hota tha (`latest-screen-
  // different-number`), isliye naye number ka card kabhi banta hi nahi.
  // Ab 2 attempt ke baad us nayi card par Refresh dabaya jata hai (Refresh
  // number-specific nahi hota — bot apna inbox dobara padhta hai).
  let fallbackRefresh = null;

  try {
    const recent = await fetchIncomingUnlocked(12, ctx);
    // Window se bahar gaya number-card bhi dekho — usi par asli REFRESH button
    // hota hai. Sirf text fallback par depend karna bot ke hisaab se fail tha.
    const tracked = await fetchTrackedMessagesUnlocked(recent);
    for (const message of [...recent, ...tracked]) {
      const buttons = await getMessageButtons(message);
      const entries = buttons
        .map((button) => ({
          button,
          text: buttonText(button),
          role: roleForHermesButton(button, config),
        }))
        .filter((entry) => entry.text);
      if (!entries.length) continue;
      const text = messageText(message);
      const cardPhone = parseTelegramNumberCard(text)?.phone || '';
      if (wanted && cardPhone && cardPhone !== wanted) {
        lastReason = 'latest-screen-different-number';
        const alt = entries.find((e) => allowed.includes(e.role));
        if (alt && !fallbackRefresh) fallbackRefresh = { entry: alt, phone: cardPhone };
        continue;
      }
      const index = entries.findIndex((entry) => allowed.includes(entry.role));
      if (index < 0) continue;
      const entry = entries[index];
      try {
        const answer = await entry.button.click({});
        getProviderState(ctx).lastActionAt = Date.now();
        getProviderState(ctx).lastClickedButton = entry.text;
        getProviderState(ctx).lastClickedRole = entry.role;
        getProviderState(ctx).lastCallbackMessage = String(answer?.message || '').trim().slice(0, 180);
        getProviderState(ctx).claimPhase = `refresh-${attempt || 1}`;
        console.log(`[Hermes] 🔄 REFRESH #${attempt || 1} (click: ${entry.text})`);
        return { ok: true, via: 'click', buttonText: entry.text };
      } catch (error) {
        lastReason = `click-fail: ${String(error?.message || error).slice(0, 60)}`;
      }
    }
  } catch (error) {
    lastReason = `read-fail: ${String(error?.message || error).slice(0, 60)}`;
  }

  // 1b) Sirf doosre number ki card mili — 2nd attempt se usi par Refresh.
  if (fallbackRefresh && Number(attempt) >= 2) {
    try {
      const answer = await fallbackRefresh.entry.button.click({});
      getProviderState(ctx).lastActionAt = Date.now();
      getProviderState(ctx).lastClickedButton = fallbackRefresh.entry.text;
      getProviderState(ctx).lastClickedRole = fallbackRefresh.entry.role;
      getProviderState(ctx).lastCallbackMessage = String(answer?.message || '').trim().slice(0, 180);
      getProviderState(ctx).claimPhase = `refresh-${attempt || 1}`;
      console.log(`[Hermes] 🔄 REFRESH #${attempt || 1} (click: ${fallbackRefresh.entry.text} — card +${fallbackRefresh.phone}, wanted +${wanted || '?'}: naye card ke liye) `);
      return { ok: true, via: 'click-fallback', buttonText: fallbackRefresh.entry.text, reason: 'different-number-card' };
    } catch (error) {
      lastReason = `fallback-click-fail: ${String(error?.message || error).slice(0, 60)}`;
    }
  }

  // 2) Text fallback — bot ke button ka naam type karke bhi refresh hota hai.
  const text = String(profile.refreshText || 'Refresh');
  try {
    const entity = await ensureEntityUnlocked(client, config);
    await client.sendMessage(entity, { message: text });
    getProviderState(ctx).lastActionAt = Date.now();
    getProviderState(ctx).lastClickedButton = `${text} (text)`;
    getProviderState(ctx).lastClickedRole = 'refresh';
    getProviderState(ctx).claimPhase = `refresh-text-${attempt || 1}`;
    console.log(`[Hermes] 🔄 REFRESH #${attempt || 1} (text: "${text}") — button nahi mila (${lastReason})`);
    return { ok: true, via: 'text', buttonText: text, reason: lastReason };
  } catch (error) {
    getProviderState(ctx).claimPhase = 'refresh-failed';
    console.warn(`[Hermes] REFRESH fail: ${String(error?.message || error).slice(0, 90)}`);
    return { ok: false, reason: lastReason };
  }
}

async function sendStartUnlocked(ctx) {
  const { client, config } = await ensureClientUnlocked(ctx);
  const entity = await ensureEntityUnlocked(client, config);
  await client.sendMessage(entity, { message: '/start' });
  getProviderState(ctx).lastActionAt = Date.now();
}

async function latestNumberCardUnlocked(excludePhones = new Set(), ctx) {
  const messages = await fetchIncomingUnlocked(20, ctx);
  // "Latest" ka matlab sach-much sabse nayi card hai. Woh excluded ho to
  // usse peeche wali purani card ko chup-chaap try nahi karenge.
  const selection = _selectLatestFreshHermesNumberCard(messages, { excludePhones });
  return selection.status === 'fresh' ? selection.result : null;
}

async function waitForNumberCardUnlocked({
  baselineSignatures = new Set(),
  excludePhones = new Set(),
  timeoutMs = 20_000,
  shouldAbort = null,
  afterMessageId = 0,
  afterSignature = '',
  afterPhone = '',
} = {}, ctx) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 20_000);
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return null;
    const messages = await fetchIncomingUnlocked(20, ctx);
    const selection = _selectLatestFreshHermesNumberCard(messages, {
      baselineSignatures,
      excludePhones,
      afterMessageId,
      afterSignature,
      afterPhone,
    });
    if (selection.status === 'fresh') return selection.result;
    // Note: agar selection.status === 'excluded-latest' ho, to turant return null
    // mat karo kyunki Hermes button click hone ke baad screen edit karne me
    // 1-3 second lagata hai. Wait karo jab tak naya card screen par render na ho jaye.
    await sleepInterruptibly(Math.min(900, Math.max(0, deadline - Date.now())), shouldAbort);
  }
  return null;
}

// Custom trained bots (custom-bot-runner.js) in hooks se inject hote hain —
// direct import se cycle banta, isliye set*Runner injection. fresh-bot.js boot
// par inhe wire karta hai.
let customBotClaimRunner = null;
let customBotRefreshRunner = null;
export function setCustomBotClaimRunner(fn) { customBotClaimRunner = typeof fn === 'function' ? fn : null; }
export function setCustomBotRefreshRunner(fn) { customBotRefreshRunner = typeof fn === 'function' ? fn : null; }

async function obtainCardUnlocked({
  forceNew = false,
  excludePhones = new Set(),
  timeoutMs = 20_000,
  shouldAbort = null,
} = {}, ctx) {
  const totalMs = Math.max(3_000, Number(timeoutMs) || 20_000);
  const deadline = Date.now() + totalMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const currentSignatures = async () => new Set(
    (await fetchIncomingUnlocked(20, ctx)).map(messageSignature)
  );

  // 🎓 Custom trained bot — coding wala claim flow nahi, owner ki training chalegi.
  if (customBotClaimRunner) {
    const activeProfile = getActiveOtpBotProfile();
    if (activeProfile?.custom) {
      try {
        const { client, config } = await ensureClientUnlocked();
        const r = await customBotClaimRunner({
          client,
          config,
          botId: activeProfile.botId || activeProfile.id,
          timeoutMs: remainingMs(),
          excludePhones: new Set([...excludePhones]),
          shouldAbort,
        });
        if (r?.ok && r.card?.phone) return { card: r.card, message: r.message || null };
        getProviderState(ctx).claimPhase = 'custom-claim-failed';
        getProviderState(ctx).lastError = String(r?.error || 'custom claim training failed').slice(0, 180);
        console.warn(`[CustomBot] Claim training fail: ${String(r?.error || 'unknown').slice(0, 140)}`);
        return null;
      } catch (error) {
        getProviderState(ctx).claimPhase = 'custom-claim-error';
        getProviderState(ctx).lastError = String(error?.message || error).slice(0, 180);
        return null;
      }
    }
  }

  if (!forceNew) {
    const existing = await latestNumberCardUnlocked(excludePhones);
    if (existing) return existing;
  }

  let baselineSignatures = await currentSignatures();
  let lastClaimCursor = { afterMessageId: 0, afterSignature: '', afterPhone: '' };
  const freshSinceBaseline = async () => {
    const messages = await fetchIncomingUnlocked(20, ctx);
    const selection = _selectLatestFreshHermesNumberCard(messages, {
      baselineSignatures,
      excludePhones,
      ...lastClaimCursor,
    });
    return selection.status === 'fresh' ? selection.result : null;
  };
  let sentStart = false;

  // Ek hi claim ke andar max 3 action cycles. Pehli click ka jawab 5s me
  // na aaye to poora 20s andhere me nahi jalega: latest screen dobara
  // padhkar sahi button, ya ek baar /start se welcome reset karke FIND.
  for (let cycle = 0; cycle < 3 && remainingMs() > 500; cycle++) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return null;
    getProviderState(ctx).claimPhase = `latest-screen-cycle-${cycle + 1}`;
    const clicked = await clickLatestHermesButtonUnlocked({ mode: 'claim' });

    if (!clicked.ok) {
      if (sentStart || remainingMs() <= 1_500) break;
      sentStart = true;
      getProviderState(ctx).claimPhase = 'send-start';
      await sendStartUnlocked();
      await sleepInterruptibly(Math.min(900, remainingMs()), shouldAbort);
      const lateFresh = await freshSinceBaseline();
      if (lateFresh) return lateFresh;
      baselineSignatures = await currentSignatures();
      continue;
    }

    lastClaimCursor = {
      afterMessageId: Number(clicked.messageId) || 0,
      afterSignature: clicked.screenSignature || '',
      afterPhone: clicked.cardPhone || '',
    };

    const waitMs = cycle === 2
      ? remainingMs()
      : Math.min(8_000, remainingMs());
    const fresh = await waitForNumberCardUnlocked({
      baselineSignatures,
      excludePhones,
      timeoutMs: waitMs,
      shouldAbort,
      ...lastClaimCursor,
    });
    if (fresh) return fresh;
    if ((typeof shouldAbort === 'function' && shouldAbort()) || remainingMs() <= 500) return null;

    // Hermes ka jawab 5s wali pehli wait ke thik baad bhi aa sakta hai.
    // Baseline reset ya /start se pehle use pakdo, warna asal card chhup
    // jayega aur bot use NEW karke bekaar me agla number le lega.
    const lateFresh = await freshSinceBaseline();
    if (lateFresh) return lateFresh;

    baselineSignatures = await currentSignatures();
    const latestAny = await latestNumberCardUnlocked(new Set());
    if (latestAny?.card?.phone && excludePhones.has(latestAny.card.phone)) {
      // Hermes ne consumed/rejected number hi dikhaya hai — agle cycle me
      // usi latest card ka NEW NUMBER turant chalega, timeout nahi jalega.
      getProviderState(ctx).claimPhase = 'excluded-card-new-number';
      continue;
    }

    if (!sentStart && cycle === 0 && remainingMs() > 2_000) {
      sentStart = true;
      getProviderState(ctx).claimPhase = 'no-response-send-start';
      await sendStartUnlocked();
      await sleepInterruptibly(Math.min(900, remainingMs()), shouldAbort);
      const lateFreshAfterStart = await freshSinceBaseline();
      if (lateFreshAfterStart) return lateFreshAfterStart;
      baselineSignatures = await currentSignatures();
    }
  }

  if (!forceNew) return latestNumberCardUnlocked(excludePhones);
  return null;
}

function entryFromCard(result, config) {
  const { card, message } = result;
  const profile = getOtpBotProfile(config?.otpBotProfile || '');
  return {
    phone: card.phone,
    deviceId: `${profile.id}:${card.device || card.phone}`,
    telegramDevice: card.device || '',
    online: /^(ACTIVE|ONLINE)$/i.test(card.status || '') ? true : undefined,
    label: card.device ? `${profile.label} ${card.device}` : `${profile.label} Telegram`,
    joined: '',
    status: '',
    childKey: `telegram:${messageId(message)}`,
    noPatch: true,
    source: 'telegram',
    otpProvider: 'telegram',
    otpBotProfile: profile.id,
    otpBotLabel: profile.label,
    telegramBotUsername: config.botUsername,
    telegramMessageId: messageId(message),
  };
}

// Account badalne ke liye client band karo (ek hi waqt par ek account).
async function resetClientForSlotSwitch(reason = 'account-rotate', ctx) {
  resetClientForContext(reason, ctx);
}

// Ek account ke saath number claim — account pin ho jata hai taaki us number
// ka OTP/REFRESH bhi usi account se ho (doosre account ke chat me wo number
// hota hi nahi).
async function claimNumberWithActiveAccount(opts = {}, ctx) {
    const { config } = await ensureClientUnlocked(ctx);
    roster.pinSlot(Number(config.accountSlot) || 0);
    const excluded = new Set((Array.isArray(opts.excludePhones) ? opts.excludePhones : []).map(String));
    if (getProviderState(ctx).currentConsumed && getProviderState(ctx).currentPhone) excluded.add(getProviderState(ctx).currentPhone);
    let forceNew = Boolean(opts.forceNew || getProviderState(ctx).currentConsumed);
    const maxAttempts = Math.max(1, Math.min(10, Number(opts.maxAttempts) || 5));
    const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
    let lastEntry = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (shouldAbort?.()) throw new Error('Telegram Hermes number claim aborted');
      const result = await obtainCardUnlocked({
        forceNew,
        excludePhones: excluded,
        timeoutMs: opts.timeoutMs ?? 20_000,
        shouldAbort,
      }, ctx);
      if (!result) {
        const screenButtons = getProviderState(ctx).lastScreenButtons?.length
          ? getProviderState(ctx).lastScreenButtons.join(' | ')
          : 'none';
        const clicked = getProviderState(ctx).lastClickedButton
          ? `last click ${getProviderState(ctx).lastClickedButton}`
          : 'koi click nahi ho paya';
        const callback = getProviderState(ctx).lastCallbackMessage
          ? `; callback: ${getProviderState(ctx).lastCallbackMessage}`
          : '';
        throw new Error(`@${config.botUsername} se number card nahi mila (latest screen: ${screenButtons}; ${clicked}${callback})`);
      }
      const entry = entryFromCard(result, config);
      lastEntry = entry;

      let accepted = true;
      if (typeof opts.acceptEntry === 'function') {
        try { accepted = Boolean(await opts.acceptEntry(entry)); } catch { accepted = false; }
      }
      getProviderState(ctx).currentPhone = entry.phone;
      getProviderState(ctx).currentEntry = { ...entry };
      getProviderState(ctx).currentMessageId = entry.telegramMessageId || 0;
      getProviderState(ctx).currentConsumed = true;
      getProviderState(ctx).lastError = '';
      if (accepted) return entry;

      excluded.add(entry.phone);
      forceNew = true;
    }

    throw new Error(`Telegram Hermes se usable number nahi mila (${maxAttempts} tries${lastEntry ? `, last ${lastEntry.phone}` : ''})`);
}

// Multi-account claim: agar active account PEER_FLOOD / FLOOD_WAIT / session
// dead nikle to us account ko side par rakh kar doosra spare account try karo.
// (Sirf claim par rotate — number mil jane ke baad account badalna galat hai,
// kyunki OTP usi account ke chat me aata hai.)
export async function getNextTelegramNumber(opts = {}, ctx) {
  return withTelegramLock(async () => {
    let lastAccountError = null;
    for (let accountAttempt = 0; accountAttempt < 2; accountAttempt++) {
      try {
        return await claimNumberWithActiveAccount(opts, ctx);
      } catch (error) {
        const classified = classifyTelegramError(error);
        const actionable = classified.fatal || classified.kind === 'flood' || classified.cooldownMs > 0;
        if (!actionable) throw error;
        const config = ctx?.config || getTelegramOtpConfig();
        const slot = Number(config.accountSlot) || 0;
        roster.markAccountFailure(slot, error);
        lastAccountError = classified;
        const next = Number(config.accountCount) > 1
          ? roster.nextHealthySlot(config.accounts || [], { skipPinned: true })
          : -1;
        if (accountAttempt === 1 || next < 0 || next === slot) {
          throw new Error(`${classified.label}. ${classified.hint}`);
        }
        roster.pinSlot(next);
        await resetClientForSlotSwitch(`rotate-from-slot-${slot}`, ctx);
      }
    }
    throw new Error(`${lastAccountError?.label || 'Telegram account error'}. ${lastAccountError?.hint || ''}`.trim());
  });
}

export function discardCurrentTelegramNumber(phoneOrReason = '', ctx) {
  const maybePhone = String(phoneOrReason || '').replace(/\D/g, '').slice(-10);
  if (!maybePhone || !getProviderState(ctx).currentPhone || maybePhone === getProviderState(ctx).currentPhone) {
    getProviderState(ctx).currentConsumed = true;
  }
}

function emptySnapshot(phone) {
  return {
    ids: new Set(),
    codes: new Set(),
    code: '',
    signature: '',
    smsTimeMs: 0,
    rawTime: '',
    sender: '',
    messageId: 0,
    editDateMs: 0,
    phone: phone || '',
  };
}

function snapshotFromParsed(phone, message, parsed) {
  const signature = parsed?.signature || '';
  const code = parsed?.code || '';
  const idKey = message ? `telegram:${messageId(message)}:${messageEditMs(message)}:${signature}` : '';
  return {
    ids: new Set(idKey ? [idKey] : []),
    codes: new Set(code ? [code] : []),
    code,
    signature,
    smsTimeMs: parsed?.smsTimeMs || 0,
    rawTime: parsed?.rawTime || '',
    sender: parsed?.sender || '',
    messageId: message ? messageId(message) : 0,
    editDateMs: message ? messageEditMs(message) : 0,
    phone: parsed?.phone || phone || '',
  };
}

export async function snapshotTelegramOtpState(phone, opts = {}, ctx) {
  return withTelegramLock(async () => {
    try {
      const messages = await fetchIncomingUnlocked(12, ctx);
      for (const message of messages) {
        const parsed = parseTelegramOtpText(messageText(message));
        if (!parsed?.code) continue;
        if (parsed.phone && parsed.phone !== phone) continue;
        if (!parsed.phone && getProviderState(ctx).currentPhone && getProviderState(ctx).currentPhone !== phone) continue;
        return snapshotFromParsed(phone, message, parsed);
      }
      return emptySnapshot(phone);
    } catch (error) {
      setLastError(error, ctx);
      return { ...emptySnapshot(phone), error: String(error?.message || error) };
    }
  });
}

function toStringSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return new Set([...value].map(String));
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set([String(value)]);
}

function normalizeBaseline(input) {
  const base = input && typeof input === 'object' ? input : {};
  const codes = toStringSet(base.codes);
  if (base.code) codes.add(String(base.code));
  const ids = toStringSet(base.ids);
  if (base.idKey) ids.add(String(base.idKey));
  return {
    signature: String(base.signature || ''),
    code: String(base.code || [...codes][0] || ''),
    codes,
    ids,
    smsTimeMs: Number(base.smsTimeMs || base.ts || 0) || 0,
    messageId: Number(base.messageId || 0) || 0,
    editDateMs: Number(base.editDateMs || 0) || 0,
    // Watermark: number bhejne ke baad aaya/edited code hamesha naya hai.
    afterMs: Number(base.afterMs || 0) || 0,
  };
}

// Kya ye candidate is number ka NAYA OTP hai?
//   • wahi message + wahi edit jo baseline me tha → purana, chhodo
//   • watermark ke baad banaya/EDIT kiya gaya message → naya (Hermes/Hathi
//     card ko edit karke SMS dikhate hain — yahi asli case hai)
//   • watermark hi nahi tha (koi baseline nahi) → naya
//   • warna shak ho to purana maano — galat OTP type karke number na jale.
function candidateIsNew(candidate, baseline) {
  const { parsed, idKey } = candidate;
  if (!parsed?.code) return false;
  if (baseline.ids.has(idKey)) return false;
  if (baseline.signature && parsed.signature === baseline.signature) return false;

  const hasBaseline = Boolean(baseline.ids.size || baseline.codes.size || baseline.afterMs || baseline.messageId);
  if (!hasBaseline) return true;

  // Telegram ka waqt second me aata hai — 2s ki chhoot.
  const slackMs = 2_000;
  const editedOrNewAfterMark = baseline.afterMs > 0
    && Number(candidate.ts || 0) >= baseline.afterMs - slackMs;
  const newerMessage = baseline.messageId > 0
    && Number(candidate.messageId || 0) > Number(baseline.messageId);

  if (!baseline.codes.has(parsed.code)) {
    // Code pehle kabhi nahi dikha → naya data, le lo (jaldi aaya OTP bhi).
    if (editedOrNewAfterMark || newerMessage) return true;
    if (baseline.smsTimeMs && parsed.smsTimeMs && parsed.smsTimeMs > baseline.smsTimeMs) return true;
    return false;
  }
  // Code pehle se dikha tha — sirf naya message / naya edit hi naya OTP hai.
  return editedOrNewAfterMark || newerMessage;
}

// ---------------------------------------------------------------------------
// 🔎 OTP scanning — "OTP aaya hi nahi" ki asli wajah yahi thi
//
// 1) Purana code sirf latest 12 messages padhta tha. OTP Sent ke baad hum har
//    second REFRESH dabate hain (90s tak) — har refresh chat me naye messages
//    jodta hai, isliye asli SMS/card 12-message window se BAAHAR chala jata tha
//    aur OTP kabhi "mila" hi nahi. Ab window 30 (env se 12–60) + number card
//    ki message id se seedha padhna.
// 2) Bot kabhi OTP ko card ko EDIT karke dikhata hai. Edit ka waqt (editDate)
//    number bhejne ke baad ka hai → wo naya data hai, use lena hai. Iske liye
//    "watermark" (number bhejne se thik pehle ka snapshot) use hota hai.
// 3) Code kabhi "123 456" ya button label me aata hai — strict parse fail
//    hone par loose parse (4–8 digit, sirf OTP/SMS context me) chalta hai.
// ---------------------------------------------------------------------------
function otpScanLimit() {
  return telegramOtpScanLimit();
}

function messageButtonsText(message) {
  try {
    const rows = message?.buttons;
    if (!rows) return '';
    const flat = [];
    for (const row of rows) {
      if (Array.isArray(row)) {
        for (const b of row) flat.push(String(b?.text || b?.button?.text || ''));
      } else {
        flat.push(String(row?.text || row?.button?.text || ''));
      }
    }
    return flat.filter(Boolean).join('\n');
  } catch { return ''; }
}

// Loose OTP: "OTP: 123 456", "code - 123456", "123456 is your OTP",
// button "Copy 123456" — sirf tab jab text me OTP/SMS context ho, taaki phone
// number / device id / date ko galti se OTP na samjhein.
export function extractLooseOtpCode(text = '') {
  const src = normalizeTelegramFancyText(String(text ?? ''));
  if (!src) return '';
  if (!/(otp|verif|passcode|\bcode\b|\bpin\b|\bsmsh?\b)/i.test(src)) return '';
  const usable = (value = '') => {
    const digits = String(value).replace(/\D/g, '');
    if (digits.length < 4 || digits.length > 8) return '';
    if (/^(19|20)\d{2}$/.test(digits)) return '';
    return digits;
  };

  // 1) Label ke bilkul baad wala group — sabse bharosemand.
  const labeled = /(?:otp|passcode|\bcode\b|\bpin\b)\s*(?:is|:|-|—|=)?\s*((?:\d[\s\-]?){4,10})(?!\d)/gi;
  let m;
  while ((m = labeled.exec(src))) {
    const digits = usable(m[1]);
    if (digits) return digits;
  }
  // 2) "123 456" jaisa spaced 6-digit code.
  const spaced = /(?<!\d)(\d{3})[\s\-](\d{3})(?!\d)/g;
  while ((m = spaced.exec(src))) {
    const digits = usable(`${m[1]}${m[2]}`);
    if (digits) return digits;
  }
  // 3) Aksar "123456 is your Swiggy OTP" — code pehle, label baad me.
  const leading = /(?<!\d)(\d{6})(?!\d)\s*(?:is\s+)?(?:your\s+)?(?:swiggy|swgtns\s+)?(?:otp|code|pin)/i;
  m = src.match(leading);
  if (m) {
    const digits = usable(m[1]);
    if (digits) return digits;
  }
  // 4) Sirf 6-digit plain code (Swiggy always 6) — context already confirmed.
  const plain = src.match(/(?<!\d)\d{6}(?!\d)/g) || [];
  for (const value of plain) {
    const digits = usable(value);
    if (digits && digits.length === 6) return digits;
  }
  return '';
}

// Ek message se OTP nikalna: strict parse pehle (Hermes/Hathi ka asli format),
// phir loose (edit/space/button-label wale cases).
export function parseTelegramOtpMessage(phone = '', message = null) {
  const text = messageText(message);
  const strict = parseTelegramOtpText(text);
  if (strict?.code) {
    const card = parseTelegramNumberCard(text);
    return { ...strict, phone: strict.phone || card?.phone || '', via: 'strict' };
  }
  const loose = extractLooseOtpCode([text, messageButtonsText(message)].filter(Boolean).join('\n'));
  if (!loose) return null;
  const card = parseTelegramNumberCard(text);
  return {
    phone: card?.phone || '', code: loose, sender: '', rawTime: '', smsTimeMs: 0,
    signature: `loose|${loose}`, via: 'loose',
  };
}

function trackOtpMessageId(id = 0, ctx) {
  const n = Number(id) || 0;
  if (!n) return;
  const list = getProviderState(ctx).trackedOtpMessageIds;
  if (list.includes(n)) return;
  list.push(n);
  while (list.length > 10) list.shift();
}

// 📌 Window se bahar chale gaye card/OTP messages — id se seedha padho.
// (Har second refresh chat me naye messages jodta hai, isliye asli SMS card
//  latest window ke baahar chala jata hai. Pehle wahi card chup-chaap miss hota
//  tha aur bot ko OTP kabhi nahi milta tha.)
async function fetchTrackedMessagesUnlocked(knownMessages = [], ctx) {
  const known = new Set((knownMessages || []).map(messageId));
  const ids = [...new Set([...getProviderState(ctx).trackedOtpMessageIds, getProviderState(ctx).currentMessageId])]
    .map(Number)
    .filter((id) => id > 0 && !known.has(id))
    .slice(-10);
  if (!ids.length) return [];
  try {
    const { client, config } = await ensureClientUnlocked(ctx);
    const entity = await ensureEntityUnlocked(client, config, ctx);
    const extra = await client.getMessages(entity, { ids });
    const out = [];
    for (const message of (Array.isArray(extra) ? extra : [...(extra || [])])) {
      if (message && !known.has(messageId(message))) {
        out.push(message);
        known.add(messageId(message));
      }
    }
    return out;
  } catch (error) {
    getProviderState(ctx).lastOtpScan = {
      ...(getProviderState(ctx).lastOtpScan || {}),
      extraError: String(error?.message || error).slice(0, 80),
    };
    return [];
  }
}

async function readOtpCandidatesUnlocked(phone, ctx) {
  const limit = otpScanLimit();
  const windowMessages = await fetchIncomingUnlocked(limit, ctx);
  const tracked = await fetchTrackedMessagesUnlocked(windowMessages);
  const messages = [...(windowMessages || []), ...tracked];
  const extraIds = tracked.map(messageId);

  const out = [];
  let otpLike = 0;
  let lastText = '';
  for (const message of messages) {
    const text = messageText(message);
    if (text && !lastText) lastText = text;
    const digitsText = String(text || '').replace(/\D/g, '');
    if (/otp|sms|verif|passcode|\bcode\b/i.test(text)
      || (phone && digitsText.includes(String(phone).replace(/\D/g, '')))) {
      trackOtpMessageId(messageId(message));
    }
    const parsed = parseTelegramOtpMessage(phone, message);
    if (!parsed?.code) continue;
    otpLike += 1;
    // Kisi DOOSRE number ka card hai to chhodo. Number likha hi nahi (sirf
    // "OTP: 123456") to bhi lo — pehle yahan silent drop ho raha tha.
    if (parsed.phone && parsed.phone !== phone) continue;
    if (!parsed.phone && getProviderState(ctx).currentPhone && getProviderState(ctx).currentPhone !== phone) continue;
    out.push({
      message,
      parsed,
      ts: Math.max(messageDateMs(message), messageEditMs(message)),
      messageId: messageId(message),
      phoneMatched: Boolean(parsed.phone && parsed.phone === phone),
      idKey: `telegram:${messageId(message)}:${messageEditMs(message)}:${parsed.signature}`,
    });
  }
  // Apne number ka card pehle, phir baaki.
  out.sort((a, b) => Number(b.phoneMatched) - Number(a.phoneMatched));
  getProviderState(ctx).lastOtpScan = {
    at: Date.now(),
    limit,
    scanned: messages.length,
    extraIds: extraIds.length,
    otpLike,
    tracked: getProviderState(ctx).trackedOtpMessageIds.length,
    codes: out.map((c) => c.parsed.code).slice(0, 5),
    lastText: lastText.slice(0, 160),
  };
  if (!out.length && lastText) getProviderState(ctx).lastOtpText = lastText.slice(0, 200);
  return out;
}

// 🔖 Watermark — number bhejne se THIK PEHLE ka OTP state. Iske baad aaya ya
// edit hua code hi "naya" maana jata hai. Pehle baseline OTP Sent ke baad
// liya jata tha, isliye jaldi aa gaya OTP "purana" gina jata tha aur 90s
// tak ignore hota tha.
export async function captureTelegramOtpWatermark(phone) {
  return withTelegramLock(async () => {
    const ts = Date.now();
    try {
      const messages = await fetchIncomingUnlocked(otpScanLimit());
      const codes = new Set();
      const ids = new Set();
      let messageIdMax = 0;
      for (const message of messages || []) {
        const parsed = parseTelegramOtpMessage(phone, message);
        ids.add(`telegram:${messageId(message)}:${messageEditMs(message)}:${parsed?.signature || ''}`);
        if (parsed?.code) codes.add(parsed.code);
        messageIdMax = Math.max(messageIdMax, messageId(message));
      }
      return { codes: [...codes], ids: [...ids], signature: '', ts, afterMs: ts, messageId: messageIdMax };
    } catch (error) {
      return { codes: [], ids: [], ts, afterMs: ts, messageId: 0, error: String(error?.message || error).slice(0, 120) };
    }
  });
}

// Tests: scan window + "naya code" ka faisla (network ke bina).
export function telegramOtpScanLimit(env = process.env) {
  const n = Number(env.SWIGGY_OTP_SCAN_LIMIT ?? 30);
  return Math.min(60, Math.max(12, Number.isFinite(n) && n > 0 ? n : 30));
}

export function _otpCandidateIsNewForTests(candidate, baseline) {
  return candidateIsNew(candidate || {}, normalizeBaseline(baseline));
}

// Capture full messages before verification so an old reward is never forwarded.
export async function captureTelegramMessageBaseline() {
  return withTelegramLock(async () => {
    const messages = await fetchIncomingUnlocked(otpScanLimit());
    const tracked = await fetchTrackedMessagesUnlocked(messages);
    return [...messages, ...tracked].map(message => `${messageId(message)}|${messageText(message)}`);
  });
}

export async function waitForGoldDropReward(phone, { baseline = [], deliveredCodes = [], timeoutMs = 10000 } = {}) {
  return withTelegramLock(async () => {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    const scan = async () => {
      const recent = await fetchIncomingUnlocked(otpScanLimit());
      const tracked = await fetchTrackedMessagesUnlocked(recent);
      return findFreshGoldDropReward([...recent, ...tracked].map(message => ({
        id: messageId(message), text: messageText(message),
      })), {
        phone, baseline, deliveredCodes,
        cardPhoneOf: text => parseTelegramNumberCard(text)?.phone || '',
      });
    };
    // Scan before refreshing; also scan once after the final refresh even if a
    // slow Telegram request has used the remaining time budget.
    let reward = await scan();
    if (reward) return reward;
    while (Date.now() < deadline) {
      await refreshHermesChatUnlocked({ phone, attempt: ++attempt });
      await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
      reward = await scan();
      if (reward) return reward;
    }
    return '';
  });
}

export async function waitForTelegramOtpCode(phone, opts = {}, ctx) {
  return withTelegramLock(async () => {
    const timeoutMs = Math.max(1_000, Number(opts.timeoutMs) || 20_000);
    const refreshMs = Math.max(800, Number(opts.refreshMs ?? opts.pollMs) || 1_000);
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    const acceptAnyAfterMs = Math.max(
      0,
      Number(opts.acceptAnyAfterMs ?? Math.min(15_000, Math.floor(timeoutMs * 0.75))) || 0
    );
    const baseline = normalizeBaseline(opts.baseline ?? opts.excludeIds ?? opts.exclude);
    const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
    const aborted = () => Boolean(shouldAbort?.());

    try {
      if (aborted()) return { code: '', aborted: true };
      if (waitMs) await sleepInterruptibly(waitMs, shouldAbort);
      if (aborted()) return { code: '', aborted: true };

      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      let lastRefreshAt = 0;
      let refreshAttempts = 0;
      let lastError = null;
      // 🐢 REFRESH ka apna backoff. Owner ka rule "har second refresh" tab
      // tak hai jab tak Telegram saath de. Owner ke logs me refreshes ki
      // barish (1s par, 90s tak) Telegram ko throttle kar deti thi —
      // `Sleeping for 16s on flood wait` — aur usi waqt world bot ka delete/
      // login jawab aaya hota tha. Isliye refresh dheema hua to (read/click
      // me 2s+ lage) apne aap 2s → 3s → 5s par chala jata hai, aur theek
      // hone par wapas 1s.
      let currentRefreshMs = refreshMs;
      let slowReads = 0;

      while (Date.now() < deadline) {
        if (aborted()) return { code: '', aborted: true };
        const iterStartedAt = Date.now();
        try {
          const candidates = await readOtpCandidatesUnlocked(phone, ctx);
          const accepted = candidates.filter((candidate) => candidateIsNew(candidate, baseline)
            && (typeof opts.candidateFilter !== 'function' || opts.candidateFilter(candidate)));
          const swiggy = accepted.find((candidate) => (
            /swiggy|swgtns/i.test(candidate.parsed.sender || '') ||
            /swiggy|swgtns/i.test(messageText(candidate.message) || '')
          ));
          const chosen = swiggy || ((Date.now() - startedAt) >= acceptAnyAfterMs ? accepted[0] : null);
          if (chosen) {
            getProviderState(ctx).currentPhone = phone;
            getProviderState(ctx).currentMessageId = messageId(chosen.message);
            getProviderState(ctx).lastError = '';
            return {
              code: chosen.parsed.code,
              via: 'telegram-hermes',
              ts: chosen.parsed.smsTimeMs || messageDateMs(chosen.message) || null,
              idKey: chosen.idKey,
              sender: chosen.parsed.sender || '',
            };
          }
        } catch (error) {
          lastError = error;
          setLastError(error, ctx);
        }

        if (aborted()) return { code: '', aborted: true };
        const now = Date.now();
        if (now >= deadline) break;
        if (now - lastRefreshAt >= currentRefreshMs) {
          lastRefreshAt = now;
          refreshAttempts += 1;
          try {
            await refreshHermesChatUnlocked({ phone, attempt: refreshAttempts }, ctx);
          } catch (error) {
            lastError = error;
            setLastError(error, ctx);
          }
          // 🔍 Har 10th refresh par scan summary — owner ko console me saaf
          // dikhe ki chat me kya mila (kitne messages, kitne OTP-like).
          if (refreshAttempts % 10 === 0) {
            const scan = getProviderState(ctx).lastOtpScan || {};
            console.log(
              `[Hermes] 👀 scan ${scan.scanned || 0} msgs (limit ${scan.limit || otpScanLimit()})`
              + ` · otp-like ${scan.otpLike || 0} · tracked ${scan.tracked || 0}`
              + (scan.lastText ? ` · last: "${String(scan.lastText).replace(/\s+/g, ' ').slice(0, 70)}"` : '')
            );
          }
        }
        const iterCostMs = Date.now() - iterStartedAt;
        if (iterCostMs > 2_000) {
          slowReads += 1;
          currentRefreshMs = Math.min(5_000, Math.max(currentRefreshMs, Math.min(5_000, iterCostMs)));
          if (slowReads === 1 || slowReads % 10 === 0) {
            console.warn(`[Hermes] 🐢 OTP refresh dheema (${iterCostMs}ms) — ab ${Math.round(currentRefreshMs)}ms par (Telegram flood se bachao)`);
          }
        } else if (iterCostMs < 800 && currentRefreshMs > refreshMs) {
          slowReads = 0;
          currentRefreshMs = Math.max(refreshMs, currentRefreshMs - 500);
        }
        await sleepInterruptibly(Math.min(500, Math.max(0, deadline - Date.now())), shouldAbort);
      }

      const classified = lastError ? classifyTelegramError(lastError) : null;
      if (classified && (classified.fatal || classified.kind === 'flood')) {
        // Account hi block/flood hai — roster me mark karo taaki agli claim
        // doosra spare account uthaye.
        try { roster.markAccountFailure(getTelegramOtpConfig().accountSlot, lastError); } catch {}
      }
      return lastError
        ? {
          code: '',
          error: classified && classified.code !== 'UNKNOWN'
            ? `${classified.label} — ${String(lastError?.message || lastError).slice(0, 150)}`
            : `Telegram OTP wait fail: ${String(lastError?.message || lastError).slice(0, 180)}`,
          errorCode: classified?.code || '',
          hint: classified?.hint || '',
        }
        : {
          code: '',
          error: `OTP bot chat me ${Math.round(timeoutMs / 1000)}s tak code nahi mila`
            + ` (scan: ${getProviderState(ctx).lastOtpScan?.scanned ?? 0} msgs, otp-like ${getProviderState(ctx).lastOtpScan?.otpLike ?? 0}`
            + `, refresh ${refreshAttempts}x)`
            + (getProviderState(ctx).lastOtpScan?.lastText
              ? ` · last message: "${String(getProviderState(ctx).lastOtpScan.lastText).replace(/\s+/g, ' ').slice(0, 100)}"`
              : ''),
          otpScan: getProviderState(ctx).lastOtpScan || null,
        };
    } catch (error) {
      setLastError(error, ctx);
      return { code: '', error: `Telegram Hermes OTP wait fail: ${String(error?.message || error).slice(0, 180)}` };
    }
  });
}

export function getTelegramOtpStatus(env = process.env, ctx) {
  const config = getTelegramOtpConfig(env);
  return {
    configured: config.configured,
    missing: [...config.missing],
    apiIdPresent: Boolean(config.apiIdPresent),
    apiHashPresent: Boolean(config.apiHashPresent),
    apiCredentialsSource: config.apiCredentialsSource || '',
    apiCredentialsFile: config.apiCredentialsFile || '',
    sessionPresent: Boolean(config.sessionPresent),
    botUsername: config.botUsername,
    otpBotProfile: config.otpBotProfile || '',
    otpBotProfileLabel: config.otpBotProfileLabel || '',
    otpBotTitle: config.otpBotTitle || '',
    sessionFile: config.sessionFile,
    sessionSource: config.sessionSource,
    connected: getProviderState(ctx).connected,
    authorized: getProviderState(ctx).authorized,
    loginInProgress: Boolean(getProviderState(ctx).loginInProgress),
    me: getProviderState(ctx).meLabel,
    currentPhone: getProviderState(ctx).currentPhone,
    lastError: getProviderState(ctx).lastError,
    lastErrorCode: getProviderState(ctx).lastErrorCode || '',
    lastErrorLabel: getProviderState(ctx).lastErrorLabel || '',
    lastErrorHint: getProviderState(ctx).lastErrorHint || '',
    accountSlot: Number.isInteger(getProviderState(ctx).accountSlot) ? getProviderState(ctx).accountSlot : (config.accountSlot || 0),
    accountTag: config.accountTag || '',
    accounts: roster.rosterSummary(config.accounts || []),
    accountLines: roster.rosterSummary(config.accounts || []).accounts.map((a) => a.line),
    lastActionAt: getProviderState(ctx).lastActionAt,
    lastCheckedAt: getProviderState(ctx).lastCheckedAt,
    lastScreenButtons: [...(getProviderState(ctx).lastScreenButtons || [])],
    lastClickedButton: getProviderState(ctx).lastClickedButton || '',
    lastClickedRole: getProviderState(ctx).lastClickedRole || '',
    lastCallbackMessage: getProviderState(ctx).lastCallbackMessage || '',
    claimPhase: getProviderState(ctx).claimPhase || '',
    otpScan: getProviderState(ctx).lastOtpScan || null,
    lastOtpText: getProviderState(ctx).lastOtpText || '',
    trackedOtpMessages: [...(getProviderState(ctx).trackedOtpMessageIds || [])],
  };
}

export async function verifyTelegramOtpConnection(opts = {}, ctx) {
  return withTelegramLock(async () => {
    const { config } = await ensureClientUnlocked(ctx);

    const collect = async (messages) => {
      let currentPhone = '';
      let buttons = [];
      for (const message of messages) {
        if (!currentPhone) {
          const card = parseTelegramNumberCard(messageText(message));
          if (card?.phone) currentPhone = card.phone;
        }
        if (!buttons.length) {
          buttons = (await getMessageButtons(message)).map(buttonText).filter(Boolean);
        }
        if (currentPhone && buttons.length) break;
      }
      return { currentPhone, buttons };
    };

    let messages = await fetchIncomingUnlocked(5);
    let found = await collect(messages);
    let sentStart = false;

    // Bilkul naya spare account Hermes chat pehle kabhi khola hi na ho to
    // welcome card laane ke liye ek /start bhejna padta hai. Existing chat
    // me koi number/button pehle se ho to dobara /start nahi bhejte.
    if (opts.sendStartIfEmpty && !messages.length && !found.buttons.length) {
      await sendStartUnlocked();
      sentStart = true;
      await sleep(1_000);
      messages = await fetchIncomingUnlocked(5);
      found = await collect(messages);
    }

    return {
      ok: true,
      configured: true,
      botUsername: config.botUsername,
      me: getProviderState(ctx).meLabel,
      currentPhone: found.currentPhone,
      buttons: found.buttons,
      sentStart,
      accountSlot: config.accountSlot,
      accountTag: config.accountTag,
    };
  });
}

function telegramLoginAbortError() {
  const error = new Error('Telegram account login cancel/timeout ho gaya.');
  error.code = 'TELEGRAM_LOGIN_ABORTED';
  return error;
}

function telegramAccountLabel(user) {
  if (!user || typeof user !== 'object') return '';
  if (user.username) return `@${String(user.username).replace(/^@+/, '')}`;
  return [user.firstName, user.lastName].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
}

function normalizeTelegramFirstAndLastNames(value) {
  if (Array.isArray(value)) {
    return [String(value[0] || '').trim() || 'Telegram', String(value[1] || '').trim()];
  }
  if (value && typeof value === 'object') {
    return [
      String(value.firstName || value.first_name || value.first || '').trim() || 'Telegram',
      String(value.lastName || value.last_name || value.last || '').trim(),
    ];
  }
  const clean = String(value || '').trim();
  if (!clean) return ['Telegram', ''];
  const splitAt = clean.indexOf(' ');
  return splitAt > 0
    ? [clean.slice(0, splitAt).trim(), clean.slice(splitAt + 1).trim()]
    : [clean, ''];
}

export async function loginTelegramUserInteractive(callbacks = {}, opts = {}, ctx) {
  if (getProviderState(ctx).loginInProgress) {
    throw new Error('Telegram account login pehle se chal raha hai — pehle use complete ya cancel karo.');
  }
  if (typeof callbacks?.phoneNumber !== 'function' || typeof callbacks?.phoneCode !== 'function') {
    throw new Error('Telegram login ke liye phoneNumber aur phoneCode callbacks chahiye.');
  }

  getProviderState(ctx).loginInProgress = true;
  getProviderState(ctx).lastError = '';

  let loginClient = null;
  let result = null;
  const throwIfAborted = () => {
    if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) throw telegramLoginAbortError();
  };

  try {
    result = await withTelegramLock(async () => {
      await disconnectTelegramUserClient();
      throwIfAborted();

      const env = opts.env || process.env;
      let config = getTelegramOtpConfig(env);
      const providedApiId = opts.apiId !== undefined && opts.apiId !== null && String(opts.apiId).trim() !== '';
      const providedApiHash = opts.apiHash !== undefined && opts.apiHash !== null && String(opts.apiHash).trim() !== '';
      const apiId = providedApiId
        ? (/^\d+$/.test(String(opts.apiId).trim()) ? Number(String(opts.apiId).trim()) : 0)
        : config.apiId;
      const apiHash = providedApiHash ? String(opts.apiHash).trim() : config.apiHash;

      if ((providedApiId || providedApiHash) && opts.persistApiCredentials !== false) {
        saveTelegramApiCredentials(
          { apiId, apiHash },
          { env, updateProcessEnv: opts.updateProcessEnv !== false }
        );
        config = getTelegramOtpConfig(process.env);
      }

      config = {
        ...config,
        apiId: Number(apiId) || 0,
        apiHash: String(apiHash || ''),
        session: '',
        sessionPresent: false,
        configured: Boolean(apiId && apiHash),
      };
      if (!config.apiId || !config.apiHash) {
        throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing hai. Add Telegram Account me my.telegram.org wali API app ki details chahiye hongi.');
      }

      loginClient = await createTelegramUserClient('', config);
      throwIfAborted();

      let loginPhone = '';
      await loginClient.start({
        // forceSMS: Telegram server SMS nahi, app/calls me code bhej sakta hai.
        // Spare account par SMS receive hona zaroori hai — force SMS karo.
        forceSMS: true,
        phoneNumber: async () => {
          throwIfAborted();
          const value = await callbacks.phoneNumber();
          throwIfAborted();
          loginPhone = normalizeTelegramLoginPhone(value);
          if (!loginPhone) {
            throw new Error('Spare Telegram account ka valid phone number chahiye (Indian 10-digit ya country code ke saath).');
          }
          return loginPhone;
        },
        phoneCode: async (...args) => {
          throwIfAborted();
          const value = await callbacks.phoneCode(...args);
          throwIfAborted();
          const code = String(value ?? '').replace(/[\s-]+/g, '').trim();
          if (!code) throw new Error('Telegram login code khali hai.');
          return code;
        },
        password: async (hint) => {
          throwIfAborted();
          if (typeof callbacks.password !== 'function') {
            throw new Error('Is spare Telegram account par 2FA ON hai — login ke liye 2FA password chahiye.');
          }
          const value = await callbacks.password(hint);
          throwIfAborted();
          const password = String(value ?? '');
          if (!password) throw new Error('Telegram 2FA password khali hai.');
          return password;
        },
        firstAndLastNames: async (...args) => {
          throwIfAborted();
          const callback = typeof callbacks.firstAndLastNames === 'function'
            ? callbacks.firstAndLastNames
            : (typeof opts.firstAndLastNames === 'function' ? opts.firstAndLastNames : null);
          const value = callback ? await callback(...args) : null;
          throwIfAborted();
          return normalizeTelegramFirstAndLastNames(value);
        },
        onError: async (error) => {
          setLastError(error, ctx);
          if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) return true;
          if (typeof callbacks.onError !== 'function') return false;
          try {
            return await callbacks.onError(error);
          } catch {
            return true;
          }
        },
      });

      throwIfAborted();
      const session = String(loginClient.session?.save?.() || '').trim();
      if (!session) throw new Error('Login ke baad Telegram session khali mili — dobara try karo.');

      let me = '';
      try { me = telegramAccountLabel(await loginClient.getMe()); } catch {}
      throwIfAborted();

      const saved = saveTelegramSessionString(session, {
        env,
        persist: opts.persistSession !== false,
        updateProcessEnv: opts.updateProcessEnv !== false,
      });

      Object.assign(providerState, {
        connected: false,
        authorized: true,
        meLabel: me,
        currentPhone: '',
        currentEntry: null,
        currentConsumed: false,
        currentMessageId: 0,
        lastError: '',
        lastCheckedAt: Date.now(),
      });

      return {
        ok: true,
        me,
        accountLabel: me,
        phone: loginPhone,
        botUsername: config.botUsername,
        sessionFile: saved.sessionFile,
        sessionSource: saved.sessionSource,
        persisted: saved.persisted,
      };
    });

    return result;
  } catch (error) {
    setLastError(error, ctx);
    throw error;
  } finally {
    try { await loginClient?.disconnect?.(); } catch {}
    getClientRef(ctx) = null;
    clientPromise = null;
    getEntityRef(ctx) = null;
    getEntityCacheKey(ctx) = '';
    getProviderState(ctx).connected = false;
    getProviderState(ctx).loginInProgress = false;
    if (result) {
      getProviderState(ctx).authorized = true;
      getProviderState(ctx).meLabel = result.me || getProviderState(ctx).meLabel;
    } else {
      getProviderState(ctx).authorized = false;
    }
  }
}

export async function clearTelegramSessionString({
  env = process.env,
  deleteFile = true,
  clearProcessEnv = true,
} = {}) {
  if (getProviderState(ctx).loginInProgress) {
    throw new Error('Telegram account login chal raha hai — pehle use complete ya cancel karo.');
  }

  return withTelegramLock(async () => {
    const before = getTelegramOtpConfig(env);
    await disconnectTelegramUserClient();

    const sessionFile = before.sessionFile || getTelegramSessionFilePath(env);
    let removedFile = false;
    if (deleteFile && sessionFile) {
      removedFile = existsSync(sessionFile);
      try { rmSync(sessionFile, { force: true }); } catch { removedFile = false; }
      if (removedFile && existsSync(sessionFile)) removedFile = false;
    }

    const removedEnvKeys = [];
    if (clearProcessEnv) {
      for (const key of ['TELEGRAM_SESSION', 'TELEGRAM_STRING_SESSION', 'TG_SESSION']) {
        if (Object.prototype.hasOwnProperty.call(process.env, key)) {
          delete process.env[key];
          removedEnvKeys.push(key);
        }
        if (env && env !== process.env && Object.prototype.hasOwnProperty.call(env, key)) {
          delete env[key];
          if (!removedEnvKeys.includes(key)) removedEnvKeys.push(key);
        }
      }
    }

    Object.assign(providerState, {
      connected: false,
      authorized: false,
      meLabel: '',
      currentPhone: '',
      currentEntry: null,
      currentConsumed: false,
      currentMessageId: 0,
      lastError: '',
      lastCheckedAt: Date.now(),
    });

    return {
      ok: true,
      sessionFile,
      removedFile,
      removedEnv: removedEnvKeys.length > 0,
      removedEnvKeys,
      previousSessionSource: before.sessionSource || '',
      envSessionMayReturnAfterRestart: before.sessionSource === 'env',
    };
  });
}

export async function clearTelegramApiCredentials({
  env = process.env,
  deleteFile = true,
  clearProcessEnv = true,
} = {}, ctx) {
  if (getProviderState(ctx).loginInProgress) {
    throw new Error('Telegram account login chal raha hai — pehle use complete ya cancel karo.');
  }

  return withTelegramLock(async () => {
    if (getProviderState(ctx).loginInProgress) {
      throw new Error('Telegram account login chal raha hai — pehle use complete ya cancel karo.');
    }
    const before = getTelegramOtpConfig(env);
    await disconnectTelegramUserClient();

    const apiCredentialsFile = before.apiCredentialsFile || getTelegramApiCredentialsFilePath(env);
    let removedFile = false;
    if (deleteFile && apiCredentialsFile) {
      const fileExisted = existsSync(apiCredentialsFile);
      try { rmSync(apiCredentialsFile, { force: true }); } catch {}
      if (existsSync(apiCredentialsFile)) {
        throw new Error('Telegram API credentials file remove nahi ho payi. File permissions/path check karein.');
      }
      removedFile = fileExisted;
    }

    const envKeys = [
      'TELEGRAM_API_ID', 'TG_API_ID', 'TELEGRAM_APP_ID',
      'TELEGRAM_API_HASH', 'TG_API_HASH', 'TELEGRAM_APP_HASH',
    ];
    for (let slot = 2; slot <= roster.MAX_ROSTER_ACCOUNTS; slot++) {
      envKeys.push(
        `TELEGRAM_API_ID_${slot}`, `TG_API_ID_${slot}`,
        `TELEGRAM_API_HASH_${slot}`, `TG_API_HASH_${slot}`,
      );
    }

    const removedEnvKeys = [];
    if (clearProcessEnv) {
      for (const key of envKeys) {
        if (Object.prototype.hasOwnProperty.call(process.env, key)) {
          delete process.env[key];
          removedEnvKeys.push(key);
        }
        if (env && env !== process.env && Object.prototype.hasOwnProperty.call(env, key)) {
          delete env[key];
          if (!removedEnvKeys.includes(key)) removedEnvKeys.push(key);
        }
      }
    }

    Object.assign(providerState, {
      connected: false,
      authorized: false,
      meLabel: '',
      currentPhone: '',
      currentEntry: null,
      currentConsumed: false,
      currentMessageId: 0,
      lastError: '',
      lastCheckedAt: Date.now(),
    });

    return {
      ok: true,
      apiCredentialsFile,
      removedFile,
      removedEnv: removedEnvKeys.length > 0,
      removedEnvKeys,
      previousApiCredentialsSource: before.apiCredentialsSource || '',
      envCredentialsMayReturnAfterRestart: String(before.apiCredentialsSource || '').includes('env'),
    };
  });
}

export async function disconnectTelegramUserClient(ctx) {
  const client = getClientRef(ctx);
  if (ctx) { ctx.clientRef = null; ctx.clientPromise = null; ctx.entityRef = null; ctx.entityCacheKey = ''; }
  else { clientRef = null; clientPromise = null; entityRef = null; entityCacheKey = ''; }
  getProviderState(ctx).connected = false;
  getProviderState(ctx).authorized = false;
  // loginInProgress lock reset karo — purana failed/interrupted login
  // is lock ko stuck kar sakta tha, jisse spare account add hamesha block
  // ho jata tha. Disconnect ke saath lock bhi khol do.
  getProviderState(ctx).loginInProgress = false;
  try { await client?.disconnect?.(); } catch {}
}

// Force-clear stuck loginInProgress lock — Settings → Add Telegram Account
// par "login chal raha hai" dikhaye aur koi bhi naya login start na ho to
// is function ko call karo. Existing client disconnect karke lock reset karta hai.
export async function forceClearTelegramLoginLock() {
  await disconnectTelegramUserClient();
}

// ---------------------------------------------------------------------------
// 🔍 Account audit — har spare account ko alag-alag test karo.
//   npm run telegram:audit
// Ye batata hai kaun sa account (a) connect hota hai, (b) authorized hai,
// (c) OTP bot ka chat khol pata hai, (d) kaun se buttons dikh rahe hain.
// Yhi "kaun sa account kharab hai" ka seedha jawab hai.
// ---------------------------------------------------------------------------
export async function auditTelegramAccounts() {
  const base = getTelegramOtpConfig();
  const accounts = base.accounts || [];
  const results = [];
  if (!accounts.length) {
    return [{ slot: 0, tag: '', ok: false, stage: 'config', error: 'Koi TELEGRAM_SESSION set nahi hai' }];
  }
  for (const account of accounts) {
    roster.pinSlot(account.slot);
    await resetClientForSlotSwitch(`audit-slot-${account.slot}`);
    const row = {
      slot: account.slot,
      label: `account ${account.slot + 1}`,
      envKey: account.envKey,
      tag: account.tag,
      ok: false,
      stage: 'connect',
      me: '',
      currentPhone: '',
      buttons: [],
      error: '',
      code: '',
      hint: '',
    };
    try {
      const status = await verifyTelegramOtpConnection({ skipDisconnect: true });
      row.ok = true;
      row.stage = 'ready';
      row.me = status?.me || '';
      row.currentPhone = status?.currentPhone || '';
      row.buttons = Array.isArray(status?.buttons) ? status.buttons : [];
      roster.markAccountHealthy(account.slot, { me: row.me });
    } catch (error) {
      const classified = classifyTelegramError(error);
      row.error = String(error?.message || error || '').slice(0, 200);
      row.code = classified.code;
      row.hint = classified.hint;
      row.stage = classified.kind === 'dead' || classified.kind === 'blocked' ? 'dead' : classified.kind;
      roster.markAccountFailure(account.slot, error);
    } finally {
      await resetClientForSlotSwitch(`audit-end-${account.slot}`);
    }
    results.push(row);
  }
  roster.unpinSlot();
  return results;
}

export function _resetTelegramOtpSourceForTests() {
  clientRef = null;
  clientPromise = null;
  entityRef = null;
  entityCacheKey = '';
  Object.assign(providerState, {
    connected: false,
    authorized: false,
    loginInProgress: false,
    meLabel: '',
    currentPhone: '',
    currentEntry: null,
    currentConsumed: false,
    currentMessageId: 0,
    lastError: '',
    lastActionAt: 0,
    lastCheckedAt: 0,
    lastScreenButtons: [],
    lastClickedButton: '',
    lastClickedRole: '',
    lastCallbackMessage: '',
    claimPhase: '',
  });
  // Clear all slot contexts too
  slotContexts.clear();
}
