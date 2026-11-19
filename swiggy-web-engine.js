// ===== 🍔 SWIGGY PRO WEB SIGNUP ENGINE =====
//
// Swiggy Pro Web flow (storelex.store/swiggy_web) — Toing Pro ka twin
// (same API family, live verify kiya hua):
//   1. POST /api/auth/check_mobile { mobile }
//      - registered === true  → ⚡ FAURAN SKIP (owner ka rule: already
//        registered number par OTP bhejna hi nahi — number chhod do)
//      - registered === false → fresh number, aage badho
//   2. POST /api/auth/send_otp { mobile } -> { sid, tid, device_id }
//   3. OTP Telegram OTP Bot (Hathi / Hermes) se poll
//   4. POST /api/auth/verify_otp { mobile, otp, sid, tid, device_id, is_new: true }
//   5. POST /api/accounts/{mobile}/export -> session JSON
//   6. importSessionJson -> session file -> sendSession -> ledger/vault
//
// Auth: har request me header `x-user-key: <SWG-ACCESS-KEY>`.
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

export const DEFAULT_SWIGGY_WEB_BASE_URL = 'https://storelex.store/swiggy_web';
export const DEFAULT_SWIGGY_WEB_ACCESS_KEY = '';

export function getSwiggyWebConfig(env = process.env) {
  const baseUrl = (env.SWIGGY_WEB_BASE_URL || getSetting('swiggyWebBaseUrl') || DEFAULT_SWIGGY_WEB_BASE_URL).replace(/\/+$/, '');
  const accessKey = env.SWIGGY_WEB_ACCESS_KEY || getSetting('swiggyWebAccessKey') || DEFAULT_SWIGGY_WEB_ACCESS_KEY;
  return { baseUrl, accessKey };
}

// Key set hai ya nahi — UI isi se "Set Key" button dikhata hai.
export function isSwiggyWebKeySet(env = process.env) {
  return Boolean(getSwiggyWebConfig(env).accessKey);
}

function normalizePhone(val = '') {
  const digits = String(val || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function redactSensitive(text = '') {
  let out = String(text || '');
  try {
    const { accessKey } = getSwiggyWebConfig();
    if (accessKey) out = out.split(accessKey).join('***');
  } catch {}
  return out.replace(/"otp"\s*:\s*"\d+"/gi, '"otp":"***"');
}

async function swiggyPost(baseUrl, accessKey, path, body, timeoutMs = 25000) {
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
      data: { detail: err.name === 'AbortError' ? `Swiggy Pro server ${timeoutMs / 1000}s me respond nahi hua` : String(err.message || err) },
    };
  } finally {
    clearTimeout(timer);
  }
}

function failReason(data, status) {
  const d = data?.detail ?? data?.error ?? data?.message;
  let msg = Array.isArray(d) ? (d[0]?.msg || JSON.stringify(d)) : String(d || '');
  if (!msg) msg = status === 401 || status === 403
    ? 'Swiggy Pro access key reject ho gayi — Settings me sahi key set karo'
    : (status ? `Swiggy Pro server error (HTTP ${status})` : 'Swiggy Pro server se jawab nahi aaya');
  return redactSensitive(msg);
}

export async function processSingleNumberViaSwiggyWeb({
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

  const { baseUrl, accessKey } = getSwiggyWebConfig();
  if (!accessKey) {
    return {
      ok: false,
      kind: 'swiggy_key_missing',
      phone,
      reason: 'Swiggy Pro access key set nahi hai — START → 🍔 SWIGGY PRO se key set karo, ya SWIGGY_WEB_ACCESS_KEY env do',
    };
  }

  const botProfile = String(otpCfg?.otpBotProfile || getSetting('otpBotProfile') || 'hermes').toLowerCase();
  const botLabel = botProfile === 'hathi' ? '@Hathi_otp_bot (Elephant 🐘)' : '@HermeshuOTPROBOT (Hermes 📨)';

  await say([
    `🍔 <b>SWIGGY PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🤖 OTP Bot: <b>${botLabel}</b>`,
    `⏳ Number status check ho raha hai (registered = turant skip)…`,
  ].join('\n'));

  // 1. Check mobile — ⚡ OWNER KA RULE: already registered => FAURAN SKIP.
  let registered = null; // null = check fail (aage try karenge)
  try {
    const checkRes = await swiggyPost(baseUrl, accessKey, '/api/auth/check_mobile', { mobile: phone }, 15000);
    if (checkRes.ok && checkRes.data && typeof checkRes.data.registered === 'boolean') {
      registered = checkRes.data.registered;
    }
    console.log(`[SwiggyWeb] check_mobile ${phone} -> registered=${registered}`);
  } catch (err) {
    console.log(`[SwiggyWeb] check_mobile error for ${phone}: ${err.message} — flow aage try karega`);
  }

  if (aborted()) return abortResult('after_check');

  if (registered === true) {
    // Already registered — OTP bhejna hi nahi. Number release + pool me skip mark.
    discardCurrentTelegramNumber(phone);
    await markPoolStatus(entry, 'skipped');
    await say([
      `🍔 <b>SWIGGY PRO SIGNUP</b>`,
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

  await say([
    `🍔 <b>SWIGGY PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🆕 Fresh number${registered === null ? ' (check skip — server slow)' : ''} — OTP bhej raha hoon…`,
  ].join('\n'));

  // 2. Send OTP — POST /api/auth/send_otp { mobile }
  let otpState = null;
  const sendRes = await swiggyPost(baseUrl, accessKey, '/api/auth/send_otp', { mobile: phone });
  if (!sendRes.ok || sendRes.data?.success === false || !sendRes.data?.sid || !sendRes.data?.tid) {
    return {
      ok: false,
      kind: 'swiggy_send_otp_fail',
      phone,
      reason: failReason(sendRes.data, sendRes.status),
    };
  }
  otpState = {
    sid: String(sendRes.data.sid || ''),
    tid: String(sendRes.data.tid || ''),
    deviceId: String(sendRes.data.device_id || sendRes.data.deviceId || ''),
    mobile: phone,
  };
  console.log(`[SwiggyWeb] send_otp OK for ${phone} (HTTP ${sendRes.status})`);

  if (aborted()) return abortResult('after_send_otp');

  // 3. Poll OTP from Telegram Bot (Hathi / Hermes)
  const otpTimeoutMs = Number(otpCfg?.telegramOtpTimeoutMs || getSetting('telegramOtpTimeoutMs') || 35000);
  const otpRefreshMs = Number(otpCfg?.telegramOtpRefreshMs || getSetting('telegramOtpRefreshMs') || 3500);

  await say([
    `🍔 <b>SWIGGY PRO SIGNUP</b>`,
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
    console.warn(`[SwiggyWeb] OTP polling error for ${phone}:`, err.message);
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
    `🍔 <b>SWIGGY PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `🔑 OTP Mil Gaya: <code>${otpCode}</code>`,
    `⚡ Swiggy Pro par verify kar raha hoon…`,
  ].join('\n'));

  // 4. Verify OTP — POST /api/auth/verify_otp { mobile, otp, sid, tid, device_id, is_new }
  const verifyRes = await swiggyPost(baseUrl, accessKey, '/api/auth/verify_otp', {
    mobile: phone,
    otp: otpCode,
    sid: otpState.sid,
    tid: otpState.tid,
    device_id: otpState.deviceId,
    is_new: true, // registered===false hi yahan tak pahunchta hai
  });
  if (!verifyRes.ok || verifyRes.data?.success === false) {
    return {
      ok: false,
      kind: 'swiggy_verify_fail',
      phone,
      reason: failReason(verifyRes.data, verifyRes.status),
    };
  }
  console.log(`[SwiggyWeb] verify_otp OK for ${phone} (HTTP ${verifyRes.status})`);

  if (aborted()) return abortResult('after_verify');

  await say([
    `🍔 <b>SWIGGY PRO SIGNUP</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `✅ OTP Verified!`,
    `📥 Session export kar raha hoon…`,
  ].join('\n'));

  // 5. Export session — POST /api/accounts/{mobile}/export
  const exportRes = await swiggyPost(baseUrl, accessKey, `/api/accounts/${encodeURIComponent(phone)}/export`, undefined, 30000);
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
      kind: 'swiggy_export_fail',
      phone,
      reason: failReason(exportRes.data, exportRes.status) || 'Session export nahi ho paya',
    };
  }
  cleanExport.mobile = phone;

  // 6. Store locally (same Toing/Zepto pipeline)
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
    name: `swiggy-${phone}.json`,
  });

  if (file.ok) {
    console.log(`[SwiggyWeb] 🗂 Session file written: ${file.name} (${file.bytes} bytes) -> ${file.path}`);
  }

  // 7. Deliver session via sendSession callback
  let sessionSent = false;
  if (typeof sendSession === 'function') {
    try {
      const out = await sendSession({
        phone,
        accountKey: imported.key,
        kind: 'fresh_new',
        account: imported.accountObj || getDb().config.accounts?.[imported.key] || null,
        jsonText: sessionJsonStr,
        fileName: file.ok ? file.name : `swiggy-${phone}.json`,
        source: 'swiggy-pro-web',
        bytes: file.ok ? file.bytes : Buffer.byteLength(sessionJsonStr, 'utf8'),
      });
      sessionSent = out !== false;
    } catch (e) {
      console.warn('[SwiggyWeb] sendSession error:', e.message);
    }
  }

  if (markUsed) {
    markLedger(phone, 'success', { accountKey: imported.key, kind: 'swiggy_pro' });
    await markPoolStatus(entry, 'used');
  }

  syncCloudVaultNow(getDb()).catch(() => {});

  await say([
    `🎉 <b>SWIGGY PRO SIGNUP COMPLETE!</b>`,
    `📱 Mobile: <code>${phone}</code>`,
    `📦 Session: <code>${imported.key}</code>`,
    sessionSent ? `📤 File deliver ho gayi hai!` : `💾 File local store ho gayi hai!`,
  ].join('\n'));

  return {
    ok: true,
    phone,
    kind: 'fresh_new',
    accountKey: imported.key,
    viaSwiggyWeb: true,
    sessionSent: true,
  };
}
