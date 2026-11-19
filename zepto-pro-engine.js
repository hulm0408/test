// ===== 🌐 ZEPTO PRO WEB SIGNUP ENGINE =====
//
// Mirrors the Toing Pro Web engine for Zepto Pro (storelex.store/zzbot).
// Live API contract (from https://storelex.store/zzbot/openapi.json):
//   1. POST /api/login/otp    { mobile }            -> OTP bhejta hai (Zepto)
//   2. OTP Telegram OTP Bot (Hathi / Hermes) se poll hota hai
//   3. POST /api/login/verify { mobile, otp }       -> session link hoti hai
//   4. POST /api/accounts/{mobile}/export           -> session JSON export
//   5. importSessionJson -> session file -> sendSession -> ledger/vault
//
// Auth: har request me header `x-user-key: <ZEPTO_ACCESS_KEY>`.
// Key kabhi log ya report me nahi jaati.
//
// NOTE: Toing jaise check_mobile / sid / tid / device_id yahan NAHI hai —
// spec me sirf { mobile } aur { mobile, otp } bodies hain.

import {
  waitForTelegramOtpCode,
  discardCurrentTelegramNumber,
  captureTelegramOtpWatermark,
} from './telegram-otp-source.js';
import {
  importSessionJson,
  getDb,
  syncCloudVaultNow,
} from './store.js';
import { writeSessionFile } from './session-file.js';
import {
  getExtractedNumberCooldown,
  extractedNumberCooldownDays,
  markLedger,
  markPoolStatus,
} from './number-pipeline.js';
import { getSetting } from './bot-settings.js';

export const DEFAULT_ZEPTO_BASE_URL = 'https://storelex.store/zzbot';
export const DEFAULT_ZEPTO_ACCESS_KEY = '';

export function getZeptoConfig(env = process.env) {
  const baseUrl = (env.ZEPTO_PRO_BASE_URL || getSetting('zeptoBaseUrl') || DEFAULT_ZEPTO_BASE_URL).replace(/\/+$/, '');
  const accessKey = env.ZEPTO_ACCESS_KEY || getSetting('zeptoAccessKey') || DEFAULT_ZEPTO_ACCESS_KEY;
  return { baseUrl, accessKey };
}

// Key set hai ya nahi — text input se pehle yehi check chalta hai.
export function isZeptoKeySet(env = process.env) {
  return Boolean(getZeptoConfig(env).accessKey);
}

function normalizePhone(val = '') {
  const digits = String(val || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function redactSensitive(text = '') {
  let out = String(text || '');
  try {
    const { accessKey } = getZeptoConfig();
    if (accessKey) out = out.split(accessKey).join('***');
  } catch {}
  return out.replace(/"otp"\s*:\s*"\d+"/gi, '"otp":"***"');
}

async function zeptoPost(baseUrl, accessKey, path, body, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': accessKey,
        'Accept': 'application/json',
      },
      body: body === undefined ? '{}' : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      data: { detail: err.name === 'AbortError' ? `Zepto server ${timeoutMs / 1000}s me respond nahi hua` : String(err.message || err) },
    };
  } finally {
    clearTimeout(timer);
  }
}

function failReason(data, status) {
  const d = data?.detail ?? data?.error ?? data?.message;
  let msg = Array.isArray(d) ? (d[0]?.msg || JSON.stringify(d)) : String(d || '');
  if (!msg) msg = status === 401 || status === 403
    ? 'Zepto access key reject ho gayi — Settings me sahi key set karo'
    : (status ? `Zepto server error (HTTP ${status})` : 'Zepto server se jawab nahi aaya');
  return redactSensitive(msg);
}

export async function processSingleNumberViaZeptoPro({
  userId = 'autopilot',
  entry,
  report = null,
  otpCfg = {},
  shouldAbort = null,
  shouldSkip = null,
  markUsed = true,
  sendSession = null,
} = {}) {
  const phone = normalizePhone(entry?.phone);
  if (!phone) {
    return { ok: false, kind: 'failed_bad_entry', phone: '', reason: 'Entry me valid 10-digit phone nahi hai' };
  }

  const say = async (text) => {
    if (report) {
      try { await report(text); } catch {}
    }
  };

  const skipRequested = () => {
    try { return Boolean(shouldSkip?.()); } catch { return false; }
  };
  const aborted = () => Boolean(skipRequested() || (shouldAbort && shouldAbort()));
  const abortResult = (stage) => ({
    ok: false,
    kind: skipRequested() ? 'manual_skip' : 'aborted',
    phone,
    stage,
    manualSkip: skipRequested(),
    reason: skipRequested() ? 'Owner ne current number SKIP kar diya' : 'Operation aborted',
  });

  if (aborted()) return abortResult('init');

  // Cooldown check — number dobara turant na uthaya jaye
  if (markUsed) {
    const cooldown = getExtractedNumberCooldown(phone);
    if (cooldown.blocked) {
      const until = cooldown.cooldownUntilMs
        ? new Date(cooldown.cooldownUntilMs).toISOString()
        : 'unknown';
      discardCurrentTelegramNumber(phone);
      return {
        ok: false,
        kind: 'deferred_number_cooldown',
        phone,
        reason: `Ye number pehle extract ho chuka hai — ${extractedNumberCooldownDays()}-day cooldown ${until} tak hai`,
      };
    }
  }

  const { baseUrl, accessKey } = getZeptoConfig();
  if (!accessKey) {
    return {
      ok: false,
      kind: 'zepto_key_missing',
      phone,
      reason: 'Zepto Pro access key set nahi hai — START menu se key set karo, ya ZEPTO_ACCESS_KEY env do',
    };
  }

  const botProfile = String(otpCfg?.otpBotProfile || getSetting('otpBotProfile') || 'hermes').toLowerCase();
  const botLabel = botProfile === 'hathi' ? '@Hathi_otp_bot (Elephant 🐘)' : '@HermeshuOTPROBOT (Hermes 📨)';

  await say([
    `🛒 <b>ZEPTO PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🤖 OTP Bot: <b>${botLabel}</b>`,
    `🚀 Zepto gateway se OTP bhej raha hoon…`,
  ].join('\n'));

  // 1. Send OTP — POST /api/login/otp { mobile }
  let otpRes;
  try {
    otpRes = await zeptoPost(baseUrl, accessKey, '/api/login/otp', { mobile: phone });
  } catch (err) {
    return { ok: false, kind: 'zepto_send_otp_error', phone, reason: `Zepto send OTP error: ${err.message}` };
  }
  if (!otpRes.ok || otpRes.data?.success === false) {
    return {
      ok: false,
      kind: 'zepto_send_otp_fail',
      phone,
      reason: failReason(otpRes.data, otpRes.status),
    };
  }
  console.log(`[ZeptoPro] login/otp OK for ${phone} (HTTP ${otpRes.status})`);

  if (aborted()) return abortResult('after_send_otp');

  // 2. Poll OTP from Telegram Bot (Hathi / Hermes)
  const otpTimeoutMs = Number(otpCfg?.telegramOtpTimeoutMs || getSetting('telegramOtpTimeoutMs') || 35000);
  const otpRefreshMs = Number(otpCfg?.telegramOtpRefreshMs || getSetting('telegramOtpRefreshMs') || 3500);

  await say([
    `🛒 <b>ZEPTO PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `⏳ OTP bhej diya gaya hai!`,
    `🤖 <b>${botLabel}</b> se OTP lene ka intezar kar raha hoon (${Math.round(otpTimeoutMs / 1000)}s budget)…`,
  ].join('\n'));

  let otpCode = '';
  try {
    const baseline = await captureTelegramOtpWatermark(phone).catch(() => null);
    const poll = await waitForTelegramOtpCode(phone, {
      timeoutMs: otpTimeoutMs,
      refreshMs: otpRefreshMs,
      baseline,
      shouldAbort: () => aborted(),
    });
    otpCode = String(poll?.code || '').trim();
  } catch (err) {
    console.warn(`[ZeptoPro] OTP polling error for ${phone}:`, err.message);
  }

  if (aborted()) return abortResult('after_otp_poll');

  if (!otpCode || !/^\d{4,6}$/.test(otpCode)) {
    discardCurrentTelegramNumber(phone);
    return {
      ok: false,
      kind: 'failed_otp_timeout',
      phone,
      reason: `OTP nahi aaya (${Math.round(otpTimeoutMs / 1000)}s timeout ho gaya)`,
    };
  }

  await say([
    `🛒 <b>ZEPTO PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🔑 OTP Mil Gaya: <code>${otpCode}</code>`,
    `⚡ Zepto Pro par verify kar raha hoon…`,
  ].join('\n'));

  // 3. Verify OTP — POST /api/login/verify { mobile, otp }
  const verifyRes = await zeptoPost(baseUrl, accessKey, '/api/login/verify', { mobile: phone, otp: otpCode });
  if (!verifyRes.ok || verifyRes.data?.success === false) {
    return {
      ok: false,
      kind: 'zepto_verify_fail',
      phone,
      reason: failReason(verifyRes.data, verifyRes.status),
    };
  }
  console.log(`[ZeptoPro] login/verify OK for ${phone} (HTTP ${verifyRes.status})`);

  if (aborted()) return abortResult('after_verify');

  await say([
    `🛒 <b>ZEPTO PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `✅ OTP Verified!`,
    `📥 Session export kar raha hoon…`,
  ].join('\n'));

  // 4. Export session — POST /api/accounts/{mobile}/export
  const exportRes = await zeptoPost(baseUrl, accessKey, `/api/accounts/${encodeURIComponent(phone)}/export`, undefined, 30000);
  let cleanExport = null;
  if (exportRes.ok) {
    const raw = exportRes.data?.export ?? (exportRes.data?.success === false ? null : exportRes.data);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      cleanExport = raw;
    }
  }
  if (!cleanExport) {
    return {
      ok: false,
      kind: 'zepto_export_fail',
      phone,
      reason: failReason(exportRes.data, exportRes.status) || 'Session export nahi ho paya',
    };
  }
  // Mobile hamesha normalized rahe (file naam + store key ke liye)
  cleanExport.mobile = phone;

  // 5. Store locally (same Toing pipeline)
  const sessionJsonStr = JSON.stringify(cleanExport, null, 2);
  const imported = importSessionJson(sessionJsonStr);

  if (!imported?.success) {
    return {
      ok: false,
      kind: 'failed_bad_entry',
      phone,
      reason: imported?.message || 'Session JSON import failed',
    };
  }

  const file = writeSessionFile({
    phone,
    accountKey: imported.key,
    text: sessionJsonStr,
    name: `zepto-${phone}.json`,
  });

  if (file.ok) {
    console.log(`[ZeptoPro] 🗂 Session file written: ${file.name} (${file.bytes} bytes) -> ${file.path}`);
  }

  // 6. Deliver session via sendSession callback
  let sessionSent = false;
  if (typeof sendSession === 'function') {
    try {
      const out = await sendSession({
        phone,
        accountKey: imported.key,
        kind: 'fresh_new',
        account: imported.accountObj || getDb().config.accounts?.[imported.key] || null,
        jsonText: sessionJsonStr,
        fileName: file.ok ? file.name : `zepto-${phone}.json`,
        source: 'zepto-pro-web',
        bytes: file.ok ? file.bytes : Buffer.byteLength(sessionJsonStr, 'utf8'),
      });
      sessionSent = out !== false;
    } catch (e) {
      console.warn('[ZeptoPro] sendSession error:', e.message);
    }
  }

  if (markUsed) {
    markLedger(phone, 'success', { accountKey: imported.key, kind: 'zepto_pro' });
    await markPoolStatus(entry, 'used');
  }

  syncCloudVaultNow(getDb()).catch(() => {});

  await say([
    `🎉 <b>ZEPTO PRO SIGNUP COMPLETE!</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `📦 Session: <code>${imported.key}</code>`,
    sessionSent ? `📤 File deliver ho gayi hai!` : `💾 File local store ho gayi hai!`,
  ].join('\n'));

  return {
    ok: true,
    phone,
    kind: 'fresh_new',
    accountKey: imported.key,
    viaZeptoPro: true,
    sessionSent: true,
  };
}
