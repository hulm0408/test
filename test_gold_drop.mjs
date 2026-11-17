import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoldDropClient, goldDropEmailForMobile, isGoldDropDailyOtpLimit, isGoldDropInvalidOtp, isGoldDropSecurityCheck, retryGoldDropSecurity, signGoldDropPayload, unwrapGoldDropResponse } from './gold-drop-client.js';
import { GoldDropCookieJar } from './gold-drop-cookies.js';
import { extractGoldDropReward, isNewGoldDropReward, findFreshGoldDropReward } from './gold-drop-rewards.js';
import { parseTelegramNumberCard } from './telegram-otp-source.js';
import { parseWinningCodes, checkGoldDropCode, launchGoldDropChecker, launchGoldDropStealthChecker } from './gold-drop-checker.js';

const key = 'abcdefghijklmnopqrstuv';
const signed = signGoldDropPayload({ otp: '123456' }, key, 'user', '1234');
const [ts, payload, mixed] = signed.split('.');
const m = Number(mixed[0]), p = Number(mixed[1]);
const digest = mixed.slice(2, 2 + p) + mixed.slice(2 + p + m);
assert.equal(Buffer.from(digest, 'base64').toString(), createHmac('sha256', key.slice(4, 18)).update(`${ts}.${payload}`).digest('hex'));
assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64')), { otp: '123456', userKey: 'user', t: '1234' });
assert.deepEqual(unwrapGoldDropResponse({ resp: Buffer.from('{"ok":true}').toString('base64') }), { ok: true });

const calls = [];
const replies = [{ userKey: 'u', dataKey: key }, { statusCode: 200 }, { statusCode: 200 }, { statusCode: 200 }];
const client = new GoldDropClient({ fetchImpl: async (url, options) => {
  calls.push({ url, options });
  return new Response(JSON.stringify(replies.shift()), { status: 200 });
} });
await client.bootstrap({ zip: '509412' });
await client.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') });
await client.verifyOtp('123456');
assert.equal(calls.length, 4);
assert.equal(calls[2].options.headers.Cookie, 'gold-drop-id=u');
assert.match(calls[2].options.body.toString(), /name="img"; filename="pack.jpg"/);
assert.match(calls[3].url, /\/users\/verify-otp\/u\?t=/);

const cookieCalls = [];
const sessionClient = new GoldDropClient({ fetchImpl: async (url, opts) => {
  cookieCalls.push({ url, opts });
  const first = cookieCalls.length === 1;
  const headers = new Headers();
  if (first) {
    headers.append('set-cookie', 'session=one; Path=/api; Secure; HttpOnly');
    headers.append('set-cookie', 'narrow=private; Path=/api/users/get-start; Secure');
    headers.append('set-cookie', 'foreign=ignored; Domain=example.com; Path=/');
  }
  return new Response(JSON.stringify(first ? { userKey: 'u', dataKey: key } : { statusCode: 200 }), { status: 200, headers });
} });
await sessionClient.bootstrap({ zip: '509412' });
await sessionClient.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') });
assert.match(cookieCalls[1].opts.headers.Cookie, /session=one/);
assert.match(cookieCalls[1].opts.headers.Cookie, /narrow=private/);
assert.match(cookieCalls[2].opts.headers.Cookie, /session=one/);
assert.doesNotMatch(cookieCalls[2].opts.headers.Cookie, /narrow=private|foreign=ignored/);
assert.match(cookieCalls[2].opts.headers.Cookie, /gold-drop-id=u/);
const jar = new GoldDropCookieJar('https://example.com/api');
const hdr = new Headers(); hdr.append('set-cookie', 'x=1; Path=/api; Secure');
jar.store(hdr, 'https://example.com/api/users');
assert.equal(jar.header('https://other.example.com/api/users'), '');
assert.equal(jar.header('https://example.com/apix'), '');
const removed = new Headers(); removed.append('set-cookie', 'x=; Path=/api; Max-Age=0');
jar.store(removed, 'https://example.com/api/users');
assert.equal(jar.header('https://example.com/api/users'), '');
await assert.rejects(client.verifyOtp('123'), /six digits/);
const sample = '▪️ ʟᴀꜱᴛ ꜱᴍꜱ\n[VK-BGCITY-S] Success! Your Reward Code is 7E8RJ9MMYFWA. Please visit https://www.go\nᴛɪᴍᴇ: 17-11-2026 | 05:21 pm';
assert.deepEqual(extractGoldDropReward(sample), { code: '7E8RJ9MMYFWA', sms: '[VK-BGCITY-S] Success! Your Reward Code is 7E8RJ9MMYFWA. Please visit https://www.go' });
assert.equal(isNewGoldDropReward(sample, []), true);
assert.equal(isNewGoldDropReward(sample, [`1|${sample}`]), false);
assert.equal(isNewGoldDropReward(sample.replace('05:21', '05:22'), [`1|${sample}`]), false);
assert.equal(extractGoldDropReward('OTP 123456, registration success'), null);
assert.deepEqual(extractGoldDropReward('[VK-BGCITY-S] Your reward code: ABC12345. Redeem now'), { code: 'ABC12345', sms: '[VK-BGCITY-S] Your reward code: ABC12345. Redeem now' });
assert.deepEqual(extractGoldDropReward('[VK-BGCITY-S] Your reward code is\nAB12CD34. Visit the site\nTIME: 5:21'), { code: 'AB12CD34', sms: '[VK-BGCITY-S] Your reward code is\nAB12CD34. Visit the site' });
assert.equal(extractGoldDropReward('Your OTP code is 123456'), null);
const hathiCard = '━[ 📞 ʏᴏᴜʀ ɴᴜᴍʙᴇʀ ]━\n────────────────────\n📞 ɴᴜᴍʙᴇʀ: +91 70025 99623\n🟢 ꜱᴛᴀᴛᴜꜱ: ᴀᴄᴛɪᴠᴇ\n📱 ᴅᴇᴠɪᴄᴇ: RMX1827\n\n▪ ʟᴀꜱᴛ ꜱᴍꜱ\n[JX-BGCITY-S] Success! Your Reward Code is 7EKMXEY3R3H3. Please visit https://www.go\nᴛɪᴍᴇ: 17-11-2026 | 06:47 PM\n\n━ ⚡ HATHIX OTP ━';
assert.equal(parseTelegramNumberCard(hathiCard)?.phone, '7002599623');
const cardPhoneOf = text => parseTelegramNumberCard(text)?.phone || '';
const hathiReward = { code: '7EKMXEY3R3H3', sms: '[JX-BGCITY-S] Success! Your Reward Code is 7EKMXEY3R3H3. Please visit https://www.go' };
assert.deepEqual(findFreshGoldDropReward([{ id: 10, text: hathiCard }], { phone: '7002599623', baseline: ['10|old OTP card'], cardPhoneOf }), hathiReward);
assert.equal(findFreshGoldDropReward([{ id: 10, text: hathiCard }], { phone: '9999999999', baseline: [], cardPhoneOf }), null);
assert.equal(findFreshGoldDropReward([{ id: 10, text: hathiCard }], { phone: '7002599623', baseline: [`10|${hathiCard}`], cardPhoneOf }), null);
assert.equal(findFreshGoldDropReward([{ id: 10, text: hathiCard }], { phone: '7002599623', deliveredCodes: new Set(['7EKMXEY3R3H3']), cardPhoneOf }), null);
assert.equal(goldDropEmailForMobile('itsnoob012@gmail.com', '9876543210', () => 0), 'itsnoob012+987654@gmail.com');
assert.equal(goldDropEmailForMobile('itsnoob012@gmail.com', '9876543210', n => n - 1), 'itsnoob012+012345@gmail.com');
assert.throws(() => goldDropEmailForMobile('not-an-email', '9876543210'), /Invalid/);
assert.throws(() => goldDropEmailForMobile('itsnoob012@gmail.com', '123'), /Invalid/);
const limitMessage = 'Your OTP limit for today is exhausted. Please try again tomorrow';
assert.equal(isGoldDropDailyOtpLimit(new Error(`Gold Drop HTTP 400: ${limitMessage}`)), true);
assert.equal(isGoldDropDailyOtpLimit(new Error(limitMessage)), true);
assert.equal(isGoldDropDailyOtpLimit(new Error(`Gold Drop HTTP 400: ${limitMessage}"`)), true);
assert.equal(isGoldDropInvalidOtp(new Error('Gold Drop HTTP 400: Invalid OTP, Please enter OTP ')), true);
assert.equal(isGoldDropInvalidOtp(new Error('Invalid OTP, Please enter OTP"')), true);
assert.equal(isGoldDropInvalidOtp(new Error('Gold Drop HTTP 500: internal error')), false);
assert.equal(isGoldDropInvalidOtp(new Error('fetch failed')), false);
assert.equal(isGoldDropDailyOtpLimit(new Error('Gold Drop HTTP 400: Please try again tomorrow using the same number')), true);
assert.equal(isGoldDropDailyOtpLimit(new Error('Gold Drop HTTP 429: Too many requests')), false);
assert.equal(isGoldDropDailyOtpLimit(new Error('fetch failed')), false);
for (const status of [200, 400]) {
  const limited = new GoldDropClient({ fetchImpl: async () => new Response(JSON.stringify({ statusCode: 400, message: limitMessage }), { status }) });
  limited.userKey = 'u'; limited.dataKey = key;
  await assert.rejects(limited.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') }), isGoldDropDailyOtpLimit);
}
for (const status of [200, 400]) {
  const invalid = new GoldDropClient({ fetchImpl: async () => new Response(JSON.stringify({ statusCode: 400, message: 'Invalid OTP, Please enter OTP' }), { status }) });
  invalid.userKey = 'u'; invalid.dataKey = key;
  await assert.rejects(invalid.verifyOtp('123456'), isGoldDropInvalidOtp);
}
const securityMessage = 'Please complete the security check to continue.';
assert.equal(isGoldDropSecurityCheck(new Error(`Gold Drop HTTP 400: ${securityMessage}`)), true);
assert.equal(isGoldDropSecurityCheck(new Error('fetch failed')), false);
for (const status of [200, 400]) {
  const blocked = new GoldDropClient({ fetchImpl: async () => new Response(JSON.stringify({ statusCode: 400, message: securityMessage }), { status }) });
  await assert.rejects(blocked.bootstrap({ zip: '509412' }), isGoldDropSecurityCheck);
  blocked.userKey = 'u'; blocked.dataKey = key;
  await assert.rejects(blocked.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') }), isGoldDropSecurityCheck);
}
assert.deepEqual(parseWinningCodes('ABC123\nxyz987 ABC123'), ['ABC123', 'XYZ987']);
assert.throws(() => parseWinningCodes('bad/code'), /letters\/digits/);
assert.throws(() => parseWinningCodes('A'.repeat(13)), /12 characters/);
function mockCheckerPage({ security = true, view = { body: '', errors: [], otpField: true } } = {}) {
  const clicks = [];
  const page = {
    goto: async () => {}, waitForSelector: async () => {}, type: async () => {},
    $eval: async () => false, click: async selector => { clicks.push(selector); },
    waitForFunction: async () => { if (!security) throw new Error('timeout'); },
    waitForNavigation: async () => {}, evaluate: async () => view, close: async () => {},
  };
  return { browser: { newPage: async () => page }, clicks };
}
const allowed = mockCheckerPage();
assert.equal((await checkGoldDropCode(allowed.browser, { code: 'ABC123', name: 'Rahul Kumar', mobile: '9876543210' })).status, 'otp_sent');
assert.equal(allowed.clicks.includes('#enbBtn'), true);
const blocked = mockCheckerPage({ security: false });
assert.equal((await checkGoldDropCode(blocked.browser, { code: 'ABC123', name: 'Rahul Kumar', mobile: '9876543210' })).status, 'security_check');
assert.equal(blocked.clicks.includes('#enbBtn'), false);
const rejected = mockCheckerPage({ view: { body: '', errors: ['Invalid winning code'], otpField: false } });
assert.equal((await checkGoldDropCode(rejected.browser, { code: 'ABC123', name: 'Rahul Kumar', mobile: '9876543210' })).message, 'Invalid winning code');
let attempts = 0, waited = 0, waitNotices = 0;
assert.equal(await retryGoldDropSecurity(async () => {
  if (++attempts < 3) throw new Error(securityMessage);
  return 'ok';
}, { delayMs: 60000, sleep: async ms => { waited += ms; }, onWait: async () => { waitNotices++; } }), 'ok');
assert.equal(attempts, 3);
assert.equal(waited, 120000);
assert.equal(waitNotices, 2);
let blockedAttempts = 0;
await assert.rejects(retryGoldDropSecurity(async () => { blockedAttempts++; throw new Error(securityMessage); }, { maxRetries: 3, delayMs: 1, sleep: async () => {} }), isGoldDropSecurityCheck);
assert.equal(blockedAttempts, 4);
let otherAttempts = 0;
await assert.rejects(retryGoldDropSecurity(async () => { otherAttempts++; throw new Error('network error'); }, { sleep: async () => {} }), /network error/);
assert.equal(otherAttempts, 1);
let stopped = false, cancelledAttempts = 0;
await assert.rejects(retryGoldDropSecurity(async () => { cancelledAttempts++; throw new Error(securityMessage); }, { shouldStop: () => stopped, sleep: async () => { stopped = true; } }), /stopped/);
assert.equal(cancelledAttempts, 1);

// ─── Stealth bridge: SeleniumBase CDP mode + Playwright connect_over_cdp ───
let python3 = '';
for (const candidate of ['python3', 'python']) {
  try { execFileSync(candidate, ['--version'], { stdio: 'pipe' }); python3 = candidate; break; } catch {}
}
if (python3) {
  // Worker ka syntax + offline selftest (browser launch nahi hota).
  execFileSync(python3, ['-m', 'py_compile', 'gold_drop_stealth.py'], { stdio: 'pipe' });
  assert.match(execFileSync(python3, ['gold_drop_stealth.py', '--selftest'], { encoding: 'utf8' }), /selftest OK/);

  // Fake worker: NDJSON protocol, ek garbage line bhi bhejta hai (ignore honi chahiye).
  const fakeWorker = join(mkdtempSync(join(tmpdir(), 'gold-fake-worker-')), 'fake_worker.py');
  writeFileSync(fakeWorker, String.raw`import json, os, sys

def send(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

sys.stdout.write("ye line JSON nahi hai — bridge ko ignore karni chahiye\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    cmd = json.loads(line)
    kind = cmd.get("cmd")
    if kind == "ping":
        send({"type": "pong"})
    elif kind == "launch":
        send({"type": "ready", "id": cmd.get("id"), "endpointUrl": "http://127.0.0.1:19222"})
    elif kind == "check":
        if cmd.get("code") == "CRASH":
            os._exit(3)
        send({"type": "result", "id": cmd.get("id"), "status": "otp_sent", "message": "fake:" + str(cmd.get("code"))})
    elif kind == "close":
        break
sys.exit(0)
`);

  // Handshake endpointUrl deta hai; check commands parse hote hain; close saaf.
  const stealth = await launchGoldDropStealthChecker({ pythonPath: python3, workerPath: fakeWorker });
  assert.equal(stealth.stealth, true);
  assert.equal(stealth.endpointUrl, 'http://127.0.0.1:19222');
  assert.deepEqual(await checkGoldDropCode(stealth, { code: 'ABC123', name: 'Rahul Kumar', mobile: '9876543210' }), { status: 'otp_sent', message: 'fake:ABC123' });
  assert.equal((await checkGoldDropCode(stealth, { code: 'XYZ987', name: 'Rahul Kumar', mobile: '9876543210' })).message, 'fake:XYZ987');
  await stealth.close();
  assert.equal(stealth.closed, true);

  // Worker crash → pending + baad ke checks dono saaf reject hote hain.
  const crashing = await launchGoldDropStealthChecker({ pythonPath: python3, workerPath: fakeWorker });
  await assert.rejects(checkGoldDropCode(crashing, { code: 'CRASH', name: 'x', mobile: '9876543210' }), /band ho gaya/);
  await assert.rejects(checkGoldDropCode(crashing, { code: 'ABC123', name: 'x', mobile: '9876543210' }), /band hai/);
  await crashing.close();

  // Asal worker protocol smoke test — ping/pong/close bina browser ke chalta
  // hai (seleniumbase/playwright sirf launch par import hote hain).
  const real = spawn(python3, ['-u', 'gold_drop_stealth.py', '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let realBuffer = '';
  const lineWaiters = [];
  real.stdout.setEncoding('utf8');
  real.stdout.on('data', chunk => {
    realBuffer += chunk;
    let index;
    while ((index = realBuffer.indexOf('\n')) >= 0) {
      const line = realBuffer.slice(0, index).trim();
      realBuffer = realBuffer.slice(index + 1);
      if (line && lineWaiters.length) lineWaiters.shift()(line);
    }
  });
  const nextLine = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker response timeout')), 15000);
    lineWaiters.push(line => { clearTimeout(timer); resolve(line); });
  });
  const pongPromise = nextLine();
  real.stdin.write(JSON.stringify({ cmd: 'ping' }) + '\n');
  assert.deepEqual(JSON.parse(await pongPromise), { type: 'pong' });
  const exitPromise = new Promise(resolve => real.once('exit', resolve));
  real.stdin.write(JSON.stringify({ cmd: 'close' }) + '\n');
  assert.equal(await Promise.race([exitPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 15000))]), 0);
}

// Engine selection: GOLD_DROP_STEALTH=0 → seedha puppeteer (Chromium zaroori).
process.env.GOLD_DROP_STEALTH = '0';
await assert.rejects(launchGoldDropChecker(''), /Chromium nahi mila/);
// STRICT stealth (1): worker na chale to error hi milta hai, fallback nahi.
process.env.GOLD_DROP_STEALTH = '1';
await assert.rejects(launchGoldDropChecker('', { pythonPath: '/nonexistent-python-gold-drop' }), /start nahi hua/);
// auto (default): stealth fail → puppeteer-real-browser fallback.
delete process.env.GOLD_DROP_STEALTH;
await assert.rejects(launchGoldDropChecker('', { pythonPath: '/nonexistent-python-gold-drop' }), /Chromium nahi mila/);

console.log('Gold Drop client, reward, checker and stealth-bridge tests passed');
