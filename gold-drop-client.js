// Gold Drop API protocol based on the supplied PHP example. No automatic retries:
// register/verify can create an entry and must not be repeated on a timeout.
import { createHmac, randomInt, randomBytes } from 'node:crypto';

const BASE = 'https://golddropgolddhamaka.com/api';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const b64 = value => Buffer.from(value, 'utf8').toString('base64');

// Gmail plus addressing keeps delivery in the original inbox while using six
// randomly selected digits from the current mobile number for each entry.
export function goldDropEmailForMobile(email, mobile, randomIndex = randomInt) {
  const match = /^([^@+]+)@(gmail\.com)$/i.exec(String(email));
  if (!match || !/^[6789]\d{9}$/.test(String(mobile))) throw new Error('Invalid Gold Drop email or mobile');
  const digits = [...String(mobile)];
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    const index = randomIndex(digits.length);
    if (!Number.isInteger(index) || index < 0 || index >= digits.length) throw new Error('Invalid random index');
    suffix += digits.splice(index, 1)[0];
  }
  return `${match[1]}+${suffix}@${match[2]}`;
}

// Only known upstream OTP rejections should advance to another number.
// Unknown rate limits and transport failures must not trigger a retry loop.
function goldDropErrorMessage(error) {
  return String(error?.message || '').replace(/^Gold Drop HTTP \d+:\s*/i, '').trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').trim();
}

export function isGoldDropDailyOtpLimit(error) {
  const message = goldDropErrorMessage(error);
  return /^(?:Your OTP limit for today is exhausted\.\s*)?Please try again tomorrow(?: using the same number)?[.!]?$/i.test(message);
}

export function isGoldDropInvalidOtp(error) {
  return /^Invalid OTP(?:\s*[,.:!-]\s*Please enter OTP)?[.!]?$/i.test(goldDropErrorMessage(error));
}

export function isGoldDropSecurityCheck(error) {
  return /^Please complete the security check to continue[.!]?$/i.test(goldDropErrorMessage(error));
}

// A security rejection may be temporary, but waiting does not solve a challenge.
// Retry only this explicit rejection, never timeouts/unknown errors, and stop
// after a bounded number of retries instead of repeatedly consuming numbers.
export async function retryGoldDropSecurity(operation, {
  maxRetries = 3, delayMs = 60000, shouldStop = () => false, onWait = async () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let retries = 0; ; retries++) {
    if (shouldStop()) throw new Error('Gold Drop stopped');
    try { return await operation(); } catch (error) {
      if (!isGoldDropSecurityCheck(error) || retries >= maxRetries || shouldStop()) throw error;
      await onWait(retries + 1, maxRetries);
      let remaining = delayMs;
      while (remaining > 0 && !shouldStop()) {
        const ms = Math.min(1000, remaining);
        await sleep(ms);
        remaining -= ms;
      }
      if (shouldStop()) throw new Error('Gold Drop stopped');
    }
  }
}

export function signGoldDropPayload(fields, dataKey, userKey, timestamp = String(Date.now())) {
  const t = String(timestamp);
  const payload = b64(JSON.stringify({ ...fields, userKey: String(userKey), t }));
  const ts = b64(t);
  const digest = b64(createHmac('sha256', String(dataKey).slice(4, 18)).update(`${ts}.${payload}`).digest('hex'));
  const p = randomInt(1, 7);
  const m = randomInt(2, 9);
  let nonce = '';
  for (let i = 0; i < m; i++) nonce += ALPHABET[randomInt(ALPHABET.length)];
  return `${ts}.${payload}.${m}${p}${digest.slice(0, p)}${nonce}${digest.slice(p)}`;
}

export function unwrapGoldDropResponse(value) {
  if (typeof value?.resp === 'string') {
    try { return JSON.parse(Buffer.from(value.resp, 'base64').toString('utf8')); } catch { /* return original */ }
  }
  return value;
}

export class GoldDropClient {
  constructor({ fetchImpl = fetch, base = BASE } = {}) {
    this.fetch = fetchImpl;
    this.base = base.replace(/\/$/, '');
    this.userKey = '';
    this.dataKey = '';
  }

  async request(path, body, contentType) {
    const headers = { Accept: 'application/json', Origin: 'https://golddropgolddhamaka.com', Referer: 'https://golddropgolddhamaka.com/register', 'X-Requested-With': 'lodu.hehe.com' };
    if (contentType) headers['Content-Type'] = contentType;
    if (this.userKey) headers.Cookie = `gold-drop-id=${this.userKey}`;
    const response = await this.fetch(`${this.base}${path}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(45000) });
    const raw = await response.text();
    let data;
    try { data = unwrapGoldDropResponse(JSON.parse(raw)); } catch { data = { raw }; }
    if (!response.ok) throw new Error(`Gold Drop HTTP ${response.status}: ${String(data?.message || 'request failed').slice(0, 200)}`);
    return data;
  }

  async bootstrap(ipInfo = {}) {
    const body = await this.request('/users', JSON.stringify({ ipInfo }), 'application/json');
    if (!body?.userKey || !body?.dataKey) throw new Error(String(body?.message || 'Gold Drop bootstrap did not return session keys'));
    this.userKey = String(body.userKey);
    this.dataKey = String(body.dataKey);
    await this.request(`/users/get-start/${encodeURIComponent(this.userKey)}`, '', 'application/json');
  }

  async register({ name, mobile, email, pincode, code, image }) {
    if (!this.userKey || !this.dataKey) throw new Error('Bootstrap required');
    if (!/^[6789]\d{9}$/.test(mobile) || !/^\d{6}$/.test(pincode) || !name || !email || !code || !image?.length) throw new Error('Invalid registration details');
    const t = String(Date.now());
    const signed = signGoldDropPayload({ name, mobile, email, pincode, code, terms_accepted: '1' }, this.dataKey, this.userKey, t);
    const boundary = `----GoldDrop${randomBytes(16).toString('hex')}`;
    const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${signed}\r\n--${boundary}\r\nContent-Disposition: form-data; name="img"; filename="pack.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.from(image), Buffer.from(`\r\n--${boundary}--\r\n`)];
    const result = await this.request(`/users/register/${encodeURIComponent(this.userKey)}?t=${t}`, Buffer.concat(chunks), `multipart/form-data; boundary=${boundary}`);
    if (result?.statusCode !== 200) throw new Error(String(result?.message || 'Registration failed'));
    return result;
  }

  async verifyOtp(otp) {
    if (!this.userKey || !this.dataKey) throw new Error('Bootstrap required');
    if (!/^\d{6}$/.test(otp)) throw new Error('OTP must be six digits');
    const t = String(Date.now());
    const data = signGoldDropPayload({ otp }, this.dataKey, this.userKey, t);
    const result = await this.request(`/users/verify-otp/${encodeURIComponent(this.userKey)}?t=${t}`, JSON.stringify({ data }), 'application/json');
    if (result?.statusCode !== 200) throw new Error(String(result?.message || 'OTP verification failed'));
    return result;
  }
}
