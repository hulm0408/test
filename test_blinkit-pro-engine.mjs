// Unit tests — Blinkit Pro Web Signup Engine (koi network nahi; fetch MOCK hai).
//   node test_blinkit-pro-engine.mjs
//
// Kya cover hota hai:
//   • Config — getBlinkitConfig / isBlinkitKeySet (env + setting + default)
//   • Engine flow — mock client se poora flow:
//       - send-otp fail → fail
//       - OTP miss → failed_otp_timeout + number discard
//       - verify fail → blinkit_verify_fail
//       - export fail → blinkit_export_fail
//       - full success → session file + sendSession + ledger/pool
//   • Cooldown — pehle extract ho chuka number deferred
//   • Key missing / key invalid (validate_key) → early fail
//   • abort/skip handling

import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

// Test ka APNA DB folder — production data/db.json KABHI touch na ho.
// Alag folder (test-data se) taaki dusre test files ke DB state se interfere na ho.
process.env.DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-data-blinkit');

const engine = await import('./blinkit-pro-engine.js');
const {
  DEFAULT_BLINKIT_BASE_URL,
  getBlinkitConfig,
  isBlinkitKeySet,
  processSingleNumberViaBlinkitPro,
  _setBlinkitOtpPollForTests,
} = engine;

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
// MOCK fetch — Blinkit API endpoints
// ---------------------------------------------------------------------------
const MOCK_BASE = 'https://storelex.test';
const mock = {
  validateKey: { valid: true, user_id: 6484999726, access_key: 'BLKP-TEST-KEY-1', accounts_count: 0 },
  sendOtp: { success: true, sid: 'sid-1', tid: 'tid-1', device_id: 'dev-1' },
  verify: { success: true, link: 'https://storelex.store/webapp/session/abc123' },
  export: { mobile: '9876543210', token: 'tk', tid: 'tid-1', deviceId: 'dev-1', cookies: 'a=b' },
  exportFailStatus: 0,
  calls: [],
};

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  mock.calls.push({ url: u, opts });
  const respond = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  if (u.includes('/api/auth/validate_key/')) return respond(mock.validateKey);
  if (u.includes('/api/login/send-otp')) return respond(mock.sendOtp);
  if (u.includes('/api/login/verify-otp')) return respond(mock.verify);
  if (u.includes('/api/login/export')) {
    if (mock.exportFailStatus) return respond({ detail: 'no such account' }, mock.exportFailStatus);
    return respond(mock.export);
  }
  return respond({ detail: 'not found' }, 404);
};

const fakeEntry = { phone: '9876543210', id: 'entry-1' };
// Har test apna number — cooldown ledger doosre test ko affect na kare.
const entry = (phone, id) => ({ phone, id });

function resetCalls() { mock.calls = []; }

// ---------------------------------------------------------------------------
console.log('— Config —');
ok(DEFAULT_BLINKIT_BASE_URL === 'https://storelex.store/webapp', 'default base URL storelex.store/webapp');
ok(getBlinkitConfig({ BLINKIT_PRO_BASE_URL: 'https://x.test/', BLINKIT_ACCESS_KEY: 'BLKP-X' }).baseUrl === 'https://x.test', 'env base URL trailing slash trim');
ok(getBlinkitConfig({ BLINKIT_ACCESS_KEY: 'BLKP-X' }).accessKey === 'BLKP-X', 'env access key');
ok(isBlinkitKeySet({ BLINKIT_ACCESS_KEY: 'BLKP-X' }) === true, 'isBlinkitKeySet true when env set');
ok(isBlinkitKeySet({}) === true, 'isBlinkitKeySet true — default key built-in (BLKP-SP08-IYFV-BISB-Y5KL)');
// Default key built-in hai — env empty hone par bhi true (Zepto/Swiggy wahi pattern).
const cfgEmpty = getBlinkitConfig({ BLINKIT_ACCESS_KEY: '', BLINKIT_PRO_BASE_URL: '' });
ok(cfgEmpty.accessKey === 'BLKP-SP08-IYFV-BISB-Y5KL', 'empty env → built-in default key use hoti hai');

console.log('— Engine flow (mock client) —');

// 1) Bad entry
{
  const r = await processSingleNumberViaBlinkitPro({ entry: { phone: '12' }, otpCfg: {} });
  ok(r.ok === false && r.kind === 'failed_bad_entry' && r.phone === '', 'bad phone → failed_bad_entry');
}

// 3) Full success — OTP override, session delivered
{
  resetCalls();
  mock.export.mobile = '9876543210';
  _setBlinkitOtpPollForTests(async () => ({ code: '123456' }));
  let sessionPayload = null;
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543210', 'e3'),
    otpCfg: { otpBotProfile: 'hermes', telegramOtpTimeoutMs: 2000, telegramOtpRefreshMs: 500 },
    sendSession: async (p) => { sessionPayload = p; return true; },
  });
  ok(r.ok === true && r.kind === 'fresh_new' && r.viaBlinkitPro === true, 'success → fresh_new viaBlinkitPro');
  ok(r.accountKey && String(r.accountKey).length > 0, 'accountKey mila');
  ok(sessionPayload !== null && sessionPayload.phone === '9876543210' && sessionPayload.source === 'blinkit-pro-web', 'sendSession payload correct');
  ok(sessionPayload.fileName === 'blinkit-9876543210.json', 'session file name blinkit-<phone>.json');
  // 🔗 verify-otp se session link capture ho + stored session me bhi ho
  ok(sessionPayload.jsonText && /storelex\.store\/webapp\/session\/abc123/.test(sessionPayload.jsonText), 'verify-otp session link export JSON me store hui');
  // 🏷 Account ka naam "Swiggy" nahi hona chahiye — "Blinkit" hona chahiye
  ok(sessionPayload.account?.name === 'Blinkit 9876543210', 'account name "Blinkit <phone>" (Swiggy nahi)');
  ok(sessionPayload.account?.link === 'https://storelex.store/webapp/session/abc123', 'account me link field store hui');
  const urls = mock.calls.map((c) => c.url);
  ok(urls.some((u) => u.includes('/api/auth/validate_key/')), 'validate_key preflight call');
  ok(urls.some((u) => u.includes('/api/login/send-otp')), 'send-otp call');
  ok(urls.some((u) => u.includes('/api/login/verify-otp')), 'verify-otp call');
  ok(urls.some((u) => u.includes('/api/login/export')), 'export call');
  // x-user-key header har request par
  const withKey = mock.calls.filter((c) => String(c.opts.headers?.['x-user-key'] || '').length > 0);
  ok(withKey.length === mock.calls.length, 'har request me x-user-key header');
}

// 4) send-otp fail
{
  resetCalls();
  mock.export.mobile = '9876543211';
  _setBlinkitOtpPollForTests(async () => ({ code: '111111' }));
  const prevSend = mock.sendOtp;
  mock.sendOtp = { success: false, detail: 'number blocked' };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543211', 'e4'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.sendOtp = prevSend;
  ok(r.ok === false && r.kind === 'blinkit_send_otp_fail' && /blocked/.test(r.reason), 'send-otp fail → blinkit_send_otp_fail');
}

// 4b) Already registered (owner rule: fauran skip, OTP bhejna hi nahi)
{
  resetCalls();
  mock.export.mobile = '9876543218';
  _setBlinkitOtpPollForTests(async () => ({ code: '999999' }));
  const prevSend = mock.sendOtp;
  // "Account Found / registered" signal — text shape (jaise Blinkit dikhata hai)
  mock.sendOtp = {
    success: false,
    message: 'Account Found. Found 9876543218 registered. Click on Continue to send OTP or enter a new number.',
  };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543218', 'e4b'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.sendOtp = prevSend;
  ok(r.ok === false && r.kind === 'skipped_already_registered', 'Account Found signal → skipped_already_registered');
  ok(!mock.calls.some((c) => c.url.includes('/api/login/verify-otp')), 'registered number par verify-otp call nahi bheji');
  ok(!mock.calls.some((c) => c.url.includes('/api/login/export')), 'registered number par export call nahi bheji');
}

// 4c) Already registered — boolean flag shape
{
  resetCalls();
  mock.export.mobile = '9876543219';
  _setBlinkitOtpPollForTests(async () => ({ code: '999999' }));
  const prevSend = mock.sendOtp;
  mock.sendOtp = { success: true, registered: true };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543219', 'e4c'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.sendOtp = prevSend;
  ok(r.ok === false && r.kind === 'skipped_already_registered', 'registered=true flag → skipped_already_registered');
}

// 4e) Already registered — exists=true flag
{
  resetCalls();
  mock.export.mobile = '9876543221';
  _setBlinkitOtpPollForTests(async () => ({ code: '999999' }));
  const prevSend = mock.sendOtp;
  mock.sendOtp = { success: true, exists: true };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543221', 'e4e'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.sendOtp = prevSend;
  ok(r.ok === false && r.kind === 'skipped_already_registered', 'exists=true flag → skipped_already_registered');
}

// 4f) Already registered — "existing account" text signal
{
  resetCalls();
  mock.export.mobile = '9876543222';
  _setBlinkitOtpPollForTests(async () => ({ code: '999999' }));
  const prevSend = mock.sendOtp;
  mock.sendOtp = { success: true, message: 'An existing account was found for this number. Please login instead.' };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543222', 'e4f'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.sendOtp = prevSend;
  ok(r.ok === false && r.kind === 'skipped_already_registered', 'existing account text → skipped_already_registered');
}

// 4g) Already registered — "number registered" text signal
{
  resetCalls();
  mock.export.mobile = '9876543223';
  _setBlinkitOtpPollForTests(async () => ({ code: '999999' }));
  const prevSend = mock.sendOtp;
  mock.sendOtp = { success: true, message: 'This number is already registered on the platform.' };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543223', 'e4g'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.sendOtp = prevSend;
  ok(r.ok === false && r.kind === 'skipped_already_registered', 'number registered text → skipped_already_registered');
}

// 4d) Normal success response (registered flag nahi) — flow aage chale
{
  resetCalls();
  mock.export.mobile = '9876543220';
  _setBlinkitOtpPollForTests(async () => ({ code: '888888' }));
  const prevSend = mock.sendOtp;
  mock.sendOtp = { success: true, sid: 's1', tid: 't1', device_id: 'd1' };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543220', 'e4d'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.sendOtp = prevSend;
  ok(r.ok === true && r.kind === 'fresh_new', 'normal send-otp response → flow aage chale (skip nahi)');
}

// 5) OTP timeout
{
  resetCalls();
  mock.export.mobile = '9876543212';
  _setBlinkitOtpPollForTests(async () => ({ code: '' }));
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543212', 'e5'),
    otpCfg: { otpBotProfile: 'hermes', telegramOtpTimeoutMs: 1000, telegramOtpRefreshMs: 500 },
  });
  ok(r.ok === false && r.kind === 'failed_otp_timeout', 'OTP miss → failed_otp_timeout');
}

// 6) verify fail
{
  resetCalls();
  mock.export.mobile = '9876543213';
  _setBlinkitOtpPollForTests(async () => ({ code: '222222' }));
  const prevVerify = mock.verify;
  mock.verify = { success: false, detail: 'otp expired' };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543213', 'e6'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.verify = prevVerify;
  ok(r.ok === false && r.kind === 'blinkit_verify_fail' && /expired/.test(r.reason), 'verify fail → blinkit_verify_fail');
}

// 7) export fail
{
  resetCalls();
  mock.export.mobile = '9876543214';
  mock.exportFailStatus = 404;
  _setBlinkitOtpPollForTests(async () => ({ code: '333333' }));
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543214', 'e7'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.exportFailStatus = 0;
  ok(r.ok === false && r.kind === 'blinkit_export_fail', 'export fail → blinkit_export_fail');
}

// 8) key invalid (validate_key valid=false)
{
  resetCalls();
  mock.export.mobile = '9876543215';
  _setBlinkitOtpPollForTests(async () => ({ code: '444444' }));
  const prevKey = mock.validateKey;
  mock.validateKey = { valid: false, detail: 'bad key' };
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543215', 'e8'),
    otpCfg: { otpBotProfile: 'hermes' },
  });
  mock.validateKey = prevKey;
  ok(r.ok === false && r.kind === 'blinkit_key_invalid', 'invalid key → blinkit_key_invalid (OTP bhejne se pehle rok)');
  ok(!mock.calls.some((c) => c.url.includes('/api/login/send-otp')), 'invalid key par OTP call nahi bheji');
}

// 9) Abort before send-otp
{
  resetCalls();
  mock.export.mobile = '9876543216';
  _setBlinkitOtpPollForTests(async () => ({ code: '555555' }));
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543216', 'e9'),
    otpCfg: { otpBotProfile: 'hermes' },
    shouldAbort: () => true,
  });
  ok(r.ok === false && r.kind === 'aborted', 'abort → aborted');
  ok(!mock.calls.some((c) => c.url.includes('/api/login/send-otp')), 'abort par OTP call nahi bheji');
}

// 10) Skip (owner)
{
  resetCalls();
  mock.export.mobile = '9876543217';
  _setBlinkitOtpPollForTests(async () => ({ code: '666666' }));
  const r = await processSingleNumberViaBlinkitPro({
    entry: entry('9876543217', 'e10'),
    otpCfg: { otpBotProfile: 'hermes' },
    shouldSkip: () => true,
  });
  ok(r.ok === false && r.kind === 'manual_skip' && r.manualSkip === true, 'skip → manual_skip');
}

// 11) Cooldown — number dobara turant na uthaya jaye
{
  // Pehle ek success — ledger me number mark ho jayega.
  resetCalls();
  _setBlinkitOtpPollForTests(async () => ({ code: '777777' }));
  const first = await processSingleNumberViaBlinkitPro({
    entry: { phone: '9123456780', id: 'e2' },
    otpCfg: { otpBotProfile: 'hermes' },
  });
  ok(first.ok === true, 'pehla number success (cooldown seed)');
  // Doosri baar same number — cooldown block hogi (ledger success mark ke baad).
  const second = await processSingleNumberViaBlinkitPro({
    entry: { phone: '9123456780', id: 'e2b' },
    otpCfg: { otpBotProfile: 'hermes' },
  });
  ok(second.ok === false && second.kind === 'deferred_number_cooldown', 'cooldown → deferred_number_cooldown');
}

_setBlinkitOtpPollForTests(null);

console.log(`\n✅ ${passed} checks pass`);
