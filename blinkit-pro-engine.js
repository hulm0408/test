// ===== ⚡ BLINKIT PRO WEB SIGNUP ENGINE =====
//
// Blinkit Pro flow (storelex.store/webapp) — Zepto Pro ka twin
// (same storelex.store API family, live contract from
// https://storelex.store/webapp/openapi.json, v0.1.0):
//   1. GET  /api/auth/validate_key/{access_key}
//      - key valid hai ya nahi — fail fast (preflight)
//   2. POST /api/login/send-otp  { mobile }
//      - already registered number pe "Account Found / registered" signal
//        aata hai → ⚡ OWNER KA RULE: number fauran SKIP (OTP bhejna hi nahi)
//      - nahi to OTP bhejta hai (sid/tid/device_id agar mile to verify me pass)
//   3. OTP Telegram OTP Bot (Hathi / Hermes) se poll
//   4. POST /api/login/verify-otp { mobile, otp }
//      - session banti hai (Zepto jaise — koi check_mobile nahi)
//   5. GET  /api/login/export?mobile=...
//      - session JSON export (import ke wahi shape me)
//   6. importSessionJson -> session file -> sendSession -> ledger/vault
//
// Auth: har request me header `x-user-key: <BLINKIT_ACCESS_KEY>`.
// Key kabhi log ya report me nahi jaati.

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

export const DEFAULT_BLINKIT_BASE_URL = 'https://storelex.store/webapp';
// 🔑 Default key built-in (Swiggy Pro / Zepto / Toing wahi pattern) —
// env ya Settings se override ho sakti hai, par bina koi key set kiye bhi
// Blinkit Pro chala.
export const DEFAULT_BLINKIT_ACCESS_KEY = 'TNG-6BMI-SHBL-OOLY';

export function getBlinkitConfig(env = process.env) {
  const baseUrl = (env.BLINKIT_PRO_BASE_URL || getSetting('blinkitBaseUrl') || DEFAULT_BLINKIT_BASE_URL).replace(/\/+$/, '');
  const accessKey = env.BLINKIT_ACCESS_KEY || getSetting('blinkitAccessKey') || DEFAULT_BLINKIT_ACCESS_KEY;
  return { baseUrl, accessKey };
}

// Key set hai ya nahi — text input se pehle yehi check chalta hai.
export function isBlinkitKeySet(env = process.env) {
  return Boolean(getBlinkitConfig(env).accessKey);
}

function normalizePhone(val = '') {
  const digits = String(val || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function redactSensitive(text = '') {
  let out = String(text || '');
  try {
    const { accessKey } = getBlinkitConfig();
    if (accessKey) out = out.split(accessKey).join('***');
  } catch {}
  return out.replace(/"otp"\s*:\s*"\d+"/gi, '"otp":"***"');
}

async function blinkitRequest(baseUrl, accessKey, path, { method = 'POST', body, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': accessKey,
        'Accept': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
      data: { detail: err.name === 'AbortError' ? `Blinkit server ${timeoutMs / 1000}s me respond nahi hua` : String(err.message || err) },
    };
  } finally {
    clearTimeout(timer);
  }
}

// GET helper (validate_key + export dono GET hain).
async function blinkitGet(baseUrl, accessKey, path, timeoutMs = 25000) {
  return blinkitRequest(baseUrl, accessKey, path, { method: 'GET', timeoutMs });
}

async function blinkitPost(baseUrl, accessKey, path, body, timeoutMs = 25000) {
  return blinkitRequest(baseUrl, accessKey, path, { method: 'POST', body, timeoutMs });
}

function failReason(data, status) {
  const d = data?.detail ?? data?.error ?? data?.message;
  let msg = Array.isArray(d) ? (d[0]?.msg || JSON.stringify(d)) : String(d || '');
  if (!msg) msg = status === 401 || status === 403
    ? 'Blinkit access key reject ho gayi — Settings me sahi key set karo'
    : (status ? `Blinkit server error (HTTP ${status})` : 'Blinkit server se jawab nahi aaya');
  return redactSensitive(msg);
}

// ⚡ Already-registered signal detector — Blinkit send-otp ke response me
// "Account Found / Found <phone> registered" signal kisi bhi shape me aa
// sakta hai (boolean flag ya text). Owner ka rule: signal mile to number skip.
function detectAlreadyRegisteredSignal(data) {
  if (!data || typeof data !== 'object') return false;
  // Boolean flags — sid/tid/success wala normal response me inme se koi nahi hota.
  if (data.registered === true) return true;
  if (data.account_found === true) return true;
  if (data.already_registered === true) return true;
  if (data.is_registered === true) return true;
  if (data.exists === true) return true;
  if (data.user_exists === true) return true;
  if (data.phone_exists === true) return true;
  // Text signals — "Account Found", "Found 6296591407 registered", etc.
  const text = [
    data.message, data.detail, data.error, data.status, data.raw,
    data.title, data.heading, data.msg, data.response, data.data,
  ].filter(Boolean).join(' ');
  if (!text) return false;
  const low = text.toLowerCase();
  if (/account found/.test(low)) return true;
  if (/already registered/.test(low)) return true;
  if (/found\s+\d{10}\s+registered/.test(low)) return true;
  if (/registered\.?\s*click/.test(low)) return true;
  if (/number.*registered/.test(low)) return true;
  if (/existing account/.test(low)) return true;
  if (/already.*exist/.test(low)) return true;
  if (/login.*instead/.test(low)) return true;
  return false;
}

// 🧪 Test override — tests OTP polling bina Telegram client ke simulate kar sakte hain.
let blinkitOtpPollOverride = null;
export function _setBlinkitOtpPollForTests(fn) {
  blinkitOtpPollOverride = typeof fn === 'function' ? fn : null;
}

async function waitForBlinkitOtp(phone, opts) {
  if (blinkitOtpPollOverride) return blinkitOtpPollOverride(phone, opts);
  const baseline = await captureTelegramOtpWatermark(phone).catch(() => null);
  return waitForTelegramOtpCode(phone, { ...opts, baseline });
}

export async function processSingleNumberViaBlinkitPro({
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

  const { baseUrl, accessKey } = getBlinkitConfig();
  if (!accessKey) {
    return {
      ok: false,
      kind: 'blinkit_key_missing',
      phone,
      reason: 'Blinkit Pro access key set nahi hai — START menu se key set karo, ya BLINKIT_ACCESS_KEY env do',
    };
  }

  const botProfile = String(otpCfg?.otpBotProfile || getSetting('otpBotProfile') || 'hermes').toLowerCase();
  const botLabel = botProfile === 'hathi' ? '@Hathi_otp_bot (Elephant 🐘)' : '@HermeshuOTPROBOT (Hermes 📨)';

  // 0. Preflight — key valid hai ya nahi (fail fast, OTP bhejne se pehle)
  let keyCheck = null;
  try {
    const keyRes = await blinkitGet(baseUrl, accessKey, `/api/auth/validate_key/${encodeURIComponent(accessKey)}`, 15000);
    keyCheck = keyRes.ok && keyRes.data?.valid === true ? keyRes.data : null;
    console.log(`[BlinkitPro] validate_key -> ${keyCheck ? 'valid (user_id ' + keyCheck.user_id + ')' : 'invalid / unchecked'}`);
  } catch (err) {
    console.log(`[BlinkitPro] validate_key error: ${err.message} — flow aage try karega`);
  }
  if (keyCheck === null) {
    // Key invalid ho to OTP bhejna bekaar hai — fauran rok do.
    // (Network error par nahi rokna: send-otp khud auth error dikha dega.)
    const keyRes2 = await blinkitGet(baseUrl, accessKey, `/api/auth/validate_key/${encodeURIComponent(accessKey)}`, 15000).catch(() => null);
    if (keyRes2 && keyRes2.ok && keyRes2.data?.valid === false) {
      return {
        ok: false,
        kind: 'blinkit_key_invalid',
        phone,
        reason: 'Blinkit access key reject hui (validate_key valid=false) — Settings me sahi BLKP key set karo',
      };
    }
  }

  await say([
    `⚡ <b>BLINKIT PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🤖 OTP Bot: <b>${botLabel}</b>`,
    `🚀 Blinkit gateway se OTP bhej raha hoon…`,
  ].join('\n'));

  // 1. Send OTP — POST /api/login/send-otp { mobile }
  let otpRes;
  try {
    otpRes = await blinkitPost(baseUrl, accessKey, '/api/login/send-otp', { mobile: phone });
  } catch (err) {
    return { ok: false, kind: 'blinkit_send_otp_error', phone, reason: `Blinkit send OTP error: ${err.message}` };
  }

  // ⚡ OWNER KA RULE: already registered number par OTP bhejna hi nahi —
  // number chhod do. Blinkit "Account Found / registered" signal deta hai
  // (jaise "Found 6296591407 registered. Click on Continue to send OTP...") —
  // us signal ko pehchano, number fauran skip kar do.
  const regSignal = detectAlreadyRegisteredSignal(otpRes.data);
  if (regSignal) {
    discardCurrentTelegramNumber(phone);
    if (markUsed) {
      try { await markPoolStatus(entry, 'skipped'); } catch {}
    }
    await say([
      `⚡ <b>BLINKIT PRO SIGNUP</b>`,
      `📱 Mobile: <code>${phone}</code>`,
      `⏭ <b>Already Registered</b> — number fauran skip, agla number aa raha hai…`,
    ].join('\n'));
    return {
      ok: false,
      kind: 'skipped_already_registered',
      phone,
      reason: 'Number already registered hai — bina OTP bheje skip (owner rule)',
    };
  }

  if (!otpRes.ok || otpRes.data?.success === false) {
    return {
      ok: false,
      kind: 'blinkit_send_otp_fail',
      phone,
      reason: failReason(otpRes.data, otpRes.status),
    };
  }
  // Zepto jaise — koi sid/tid zaroori nahi, lekin agar server de to verify me pass.
  const otpState = {
    sid: String(otpRes.data?.sid || ''),
    tid: String(otpRes.data?.tid || ''),
    deviceId: String(otpRes.data?.device_id || otpRes.data?.deviceId || ''),
    mobile: phone,
  };
  console.log(`[BlinkitPro] login/send-otp OK for ${phone} (HTTP ${otpRes.status})`);

  if (aborted()) return abortResult('after_send_otp');

  // 2. Poll OTP from Telegram Bot (Hathi / Hermes)
  const otpTimeoutMs = Number(otpCfg?.telegramOtpTimeoutMs || getSetting('telegramOtpTimeoutMs') || 35000);
  const otpRefreshMs = Number(otpCfg?.telegramOtpRefreshMs || getSetting('telegramOtpRefreshMs') || 3500);

  await say([
    `⚡ <b>BLINKIT PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `⏳ OTP bhej diya gaya hai!`,
    `🤖 <b>${botLabel}</b> se OTP lene ka intezar kar raha hoon (${Math.round(otpTimeoutMs / 1000)}s budget)…`,
  ].join('\n'));

  let otpCode = '';
  try {
    const poll = await waitForBlinkitOtp(phone, {
      timeoutMs: otpTimeoutMs,
      refreshMs: otpRefreshMs,
      shouldAbort: () => aborted(),
    });
    otpCode = String(poll?.code || '').trim();
  } catch (err) {
    console.warn(`[BlinkitPro] OTP polling error for ${phone}:`, err.message);
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
    `⚡ <b>BLINKIT PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🔑 OTP Mil Gaya: <code>${otpCode}</code>`,
    `⚡ Blinkit Pro par verify kar raha hoon…`,
  ].join('\n'));

  // 3. Verify OTP — POST /api/login/verify-otp { mobile, otp }
  //    (sid/tid/device_id agar send-otp se mila ho to wahi pass kar do —
  //    Zepto/Swiggy family ke anusaar, optional fields.)
  const verifyBody = { mobile: phone, otp: otpCode };
  if (otpState.sid) verifyBody.sid = otpState.sid;
  if (otpState.tid) verifyBody.tid = otpState.tid;
  if (otpState.deviceId) verifyBody.device_id = otpState.deviceId;
  const verifyRes = await blinkitPost(baseUrl, accessKey, '/api/login/verify-otp', verifyBody);
  if (!verifyRes.ok || verifyRes.data?.success === false) {
    return {
      ok: false,
      kind: 'blinkit_verify_fail',
      phone,
      reason: failReason(verifyRes.data, verifyRes.status),
    };
  }
  console.log(`[BlinkitPro] login/verify-otp OK for ${phone} (HTTP ${verifyRes.status})`);

  // 🔗 Session link — verify-otp response me session link aati hai (Zepto
  // family waisa). Ise capture karke export JSON me bhi dal do, taaki
  // stored session me link available ho.
  const sessionLink = String(
    verifyRes.data?.link ||
    verifyRes.data?.session_link ||
    verifyRes.data?.sessionLink ||
    verifyRes.data?.url ||
    verifyRes.data?.redirect_url ||
    verifyRes.data?.redirectUrl ||
    ''
  ).trim();
  if (sessionLink) {
    console.log(`[BlinkitPro] session link captured: ${sessionLink.slice(0, 80)}`);
  }

  if (aborted()) return abortResult('after_verify');

  await say([
    `⚡ <b>BLINKIT PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `✅ OTP Verified!`,
    `📥 Session export kar raha hoon…`,
  ].join('\n'));

  // 4. Export session — GET /api/login/export?mobile=<phone>
  const exportRes = await blinkitGet(baseUrl, accessKey, `/api/login/export?mobile=${encodeURIComponent(phone)}`, 30000);
  let cleanExport = null;
  if (exportRes.ok) {
    const raw = exportRes.data?.export ?? exportRes.data;
    if (Array.isArray(raw)) {
      // Multiple accounts aa sakte hain — hamari number wale ko dhoondho.
      const mine = raw.find((a) => String(a?.mobile || '') === phone) || raw[0];
      if (mine && typeof mine === 'object') cleanExport = mine;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      cleanExport = raw;
    }
  }
  if (!cleanExport) {
    return {
      ok: false,
      kind: 'blinkit_export_fail',
      phone,
      reason: failReason(exportRes.data, exportRes.status) || 'Session export nahi ho paya',
    };
  }
  // Mobile hamesha normalized rahe (file naam + store key ke liye)
  cleanExport.mobile = phone;

  // 🔗 Link + 🏷 Name — verify-otp se capture ki hui session link aur
  // Blinkit account ka name export JSON me dal do. Bina name ke,
  // importSessionJson account ka naam "Swiggy {phone}" bana deta hai —
  // Blinkit account Swiggy nahi banna chahiye.
  if (sessionLink) cleanExport.link = sessionLink;
  if (!cleanExport.name) cleanExport.name = `Blinkit ${phone}`;

  // 5. Store locally (same Zepto/Toing pipeline)
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
    name: `blinkit-${phone}.json`,
  });

  if (file.ok) {
    console.log(`[BlinkitPro] 🗂 Session file written: ${file.name} (${file.bytes} bytes) -> ${file.path}`);
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
        fileName: file.ok ? file.name : `blinkit-${phone}.json`,
        source: 'blinkit-pro-web',
        bytes: file.ok ? file.bytes : Buffer.byteLength(sessionJsonStr, 'utf8'),
      });
      sessionSent = out !== false;
    } catch (e) {
      console.warn('[BlinkitPro] sendSession error:', e.message);
    }
  }

  if (markUsed) {
    markLedger(phone, 'success', { accountKey: imported.key, kind: 'blinkit_pro' });
    await markPoolStatus(entry, 'used');
  }

  syncCloudVaultNow(getDb()).catch(() => {});

  await say([
    `🎉 <b>BLINKIT PRO SIGNUP COMPLETE!</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `📦 Session: <code>${imported.key}</code>`,
    sessionSent ? `📤 File deliver ho gayi hai!` : `💾 File local store ho gayi hai!`,
  ].join('\n'));

  return {
    ok: true,
    phone,
    kind: 'fresh_new',
    accountKey: imported.key,
    viaBlinkitPro: true,
    sessionSent: true,
  };
}
