// ===== Toing Pro Web HTTP Client (Concurrency-Safe + Multi-Key + Strict Timeouts) =====
// Replicates exact storelex.store/toing_web flow:
//   1. POST /api/auth/check_mobile          -> { registered }
//   2. POST /api/auth/send_otp              -> { success, sid, tid, device_id }
//   3. POST /api/auth/verify_otp            -> { success }
//   4. POST /api/accounts/{mobile}/export   -> { success, export: { mobile, name, token, sid, tid, deviceId, customerId } }

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

export function sanitizeErrorText(raw = '', maxLen = 180) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/<(?:!doctype|html|head|body|title)\b/i.test(s)) {
    const titleMatch = s.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) {
      return titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, maxLen);
    }
    return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export function parseSendOtpCooldownMs(reason = '') {
  const text = String(reason || '').trim();
  if (!text) return 0;

  // e.g. "Number of login attempts exceeded. Please retry after 2 hours."
  const hoursMatch = text.match(/(?:retry|try\s*again)\s*(?:after|in)\s*(\d+)\s*h(?:ours?|rs?)?\b/i);
  if (hoursMatch) {
    const hours = Math.max(1, Math.min(6, Number(hoursMatch[1]) || 1));
    return hours * 60 * 60_000;
  }

  // e.g. "Swiggy is blocking OTPs for this number right now. Try again in 5 min."
  const minsMatch = text.match(/(?:retry|try\s*again)\s*(?:after|in)\s*(\d+)\s*m(?:in(?:utes?)?)?\b/i);
  if (minsMatch) {
    // Enforce at least 10 min cooldown so 15–50 slots don't keep re-hitting a blocked number
    const mins = Math.max(10, Math.min(360, Number(minsMatch[1]) || 10));
    return mins * 60_000;
  }

  // Generic Swiggy / Toing phone-level OTP block without an explicit duration
  if (/(attempts?\s+exceeded|blocking\s+otps?|otp\s+blocked|too\s+many\s+(?:attempts?|requests?|otps?)|temporarily\s+blocked|rate\s*limit)/i.test(text)) {
    return 30 * 60_000;
  }

  return 0;
}

const TRANSIENT_UPSTREAM_ERROR_RE = /(expecting\s+value|unexpected\s+token|json\s*decode|empty\s+response|bad\s+gateway|service\s+unavailable|gateway\s+time-?out|\b50[234]\b|upstream|timed?\s*out)/i;

export class AsyncSemaphore {
  constructor(limit = 20) {
    this.limit = Math.max(1, Number(limit) || 20);
    this.active = 0;
    this.waiters = [];
  }

  setLimit(newLimit) {
    this.limit = Math.max(1, Number(newLimit) || 20);
    this._drain();
  }

  _drain() {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift();
      this.active += 1;
      next();
    }
  }

  async run(fn, { shouldAbort = null } = {}) {
    if (shouldAbort?.()) throw new Error('aborted');
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      if (shouldAbort?.()) throw new Error('aborted');
      return await fn();
    } finally {
      this.active = Math.max(0, this.active - 1);
      this._drain();
    }
  }

  stats() {
    return { active: this.active, queued: this.waiters.length, limit: this.limit };
  }
}

export class ToingClient {
  constructor({
    getBaseUrl,
    getAccessKeys,
    concurrency = 20,
    fetchImpl = globalThis.fetch,
    timeouts = {},
  } = {}) {
    this.getBaseUrl = typeof getBaseUrl === 'function' ? getBaseUrl : () => String(getBaseUrl || '').replace(/\/+$/, '');
    this.getAccessKeys = typeof getAccessKeys === 'function'
      ? getAccessKeys
      : () => (Array.isArray(getAccessKeys) ? getAccessKeys : [String(getAccessKeys || '')]).filter(Boolean);
    this.fetchImpl = fetchImpl;
    this.semaphore = new AsyncSemaphore(concurrency);
    this.timeouts = {
      checkMobileMs: timeouts.checkMobileMs || 6_000,
      sendOtpMs: timeouts.sendOtpMs || 10_000,
      verifyOtpMs: timeouts.verifyOtpMs || 12_000,
      exportMs: timeouts.exportMs || 12_000,
    };

    this._keyCursor = 0;
    this._keyCooldownUntil = new Map(); // key -> timestamp ms
    this._globalThrottleUntil = 0;
    this.metrics = {
      requests: 0,
      rateLimited429: 0,
      networkErrors: 0,
    };
  }

  setConcurrency(limit) {
    this.semaphore.setLimit(limit);
  }

  _pickKey(now = Date.now()) {
    const keys = (this.getAccessKeys() || []).map((k) => String(k || '').trim()).filter(Boolean);
    if (!keys.length) throw new Error('TOING_ACCESS_KEY missing');
    for (let i = 0; i < keys.length; i++) {
      const idx = (this._keyCursor + i) % keys.length;
      const key = keys[idx];
      if ((this._keyCooldownUntil.get(key) || 0) <= now) {
        this._keyCursor = (idx + 1) % keys.length;
        return key;
      }
    }
    // All keys on cooldown — pick the one expiring soonest
    const best = keys
      .map((k) => ({ k, until: this._keyCooldownUntil.get(k) || 0 }))
      .sort((a, b) => a.until - b.until)[0];
    return best.k;
  }

  async _postJson(endpointPath, bodyObj, { timeoutMs = 10_000, retries = 1, shouldAbort = null, preferredKey = '' } = {}) {
    const baseUrl = String(this.getBaseUrl() || '').replace(/\/+$/, '');
    const url = `${baseUrl}${endpointPath}`;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (shouldAbort?.()) return { ok: false, aborted: true, error: 'aborted' };

      const waitGlobal = this._globalThrottleUntil - Date.now();
      if (waitGlobal > 0) {
        await sleep(Math.min(waitGlobal, 5_000));
        if (shouldAbort?.()) return { ok: false, aborted: true, error: 'aborted' };
      }

      const key = preferredKey || this._pickKey();

      try {
        const res = await this.semaphore.run(async () => {
          this.metrics.requests += 1;
          return this.fetchImpl(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-user-key': key,
            },
            ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
            signal: AbortSignal.timeout(timeoutMs),
          });
        }, { shouldAbort });

        if (res.status === 429) {
          this.metrics.rateLimited429 += 1;
          const retryAfterSec = Number(res.headers?.get?.('retry-after') || 0);
          const backoffMs = Math.max(2_000, Math.min(20_000, (retryAfterSec || (2 * (attempt + 1))) * 1000));
          this._keyCooldownUntil.set(key, Date.now() + backoffMs);
          if ((this.getAccessKeys() || []).length <= 1) {
            this._globalThrottleUntil = Math.max(this._globalThrottleUntil, Date.now() + Math.min(backoffMs, 4_000));
          }
          lastError = `HTTP 429 rate-limited`;
          if (attempt < retries) {
            await sleep(Math.min(backoffMs, 3_500));
            continue;
          }
          return { ok: false, status: 429, key, error: lastError };
        }

        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: sanitizeErrorText(text, 200) }; }

        if (res.status >= 500 && attempt < retries) {
          lastError = `HTTP ${res.status}${data?.raw ? ` (${data.raw})` : ''}`;
          await sleep(600 * (attempt + 1));
          continue;
        }

        return { ok: res.ok, status: res.status, key, data };
      } catch (err) {
        if (shouldAbort?.()) return { ok: false, aborted: true, error: 'aborted' };
        this.metrics.networkErrors += 1;
        lastError = sanitizeErrorText(err?.message || err, 180);
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
      }
    }

    return { ok: false, status: 0, error: lastError || 'request_failed' };
  }

  async checkMobile(mobile, { shouldAbort = null } = {}) {
    const alreadyRe = /(already\s*registered|mobile\s+number\s+is\s+already\s+registered|user\s+already\s+exists)/i;
    let lastResult = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this._postJson('/api/auth/check_mobile', { mobile }, {
        timeoutMs: this.timeouts.checkMobileMs,
        retries: 1,
        shouldAbort,
      });
      if (res.aborted) return { ok: false, aborted: true, registered: null, isNew: false, key: '' };

      const d = res.data && typeof res.data === 'object' ? res.data : {};
      const msgText = sanitizeErrorText(d.message || d.error || d.detail || d.status || d.raw || '', 180);

      if (res.ok) {
        let registered = null;
        if (typeof d.registered === 'boolean') registered = d.registered;
        else if (typeof d.is_registered === 'boolean') registered = d.is_registered;
        else if (typeof d.already_registered === 'boolean') registered = d.already_registered;
        else if (typeof d.exists === 'boolean') registered = d.exists;
        else if (typeof d.is_new === 'boolean') registered = !d.is_new;
        else if (alreadyRe.test(msgText)) registered = true;

        if (typeof registered === 'boolean') {
          return {
            ok: true,
            registered,
            isNew: !registered,
            key: res.key || '',
            message: msgText.slice(0, 160),
          };
        }
      } else if (alreadyRe.test(msgText) || res.status === 409) {
        return {
          ok: true,
          registered: true,
          isNew: false,
          key: res.key || '',
          message: msgText.slice(0, 160) || `HTTP ${res.status} already registered`,
        };
      }

      const cleanErr = sanitizeErrorText(msgText || res.error || `HTTP ${res.status || 0} invalid check_mobile response`, 180);
      lastResult = {
        ok: false,
        registered: null,
        isNew: false,
        status: res.status || 0,
        key: res.key || '',
        error: cleanErr,
      };

      // Retry once on transient HTTP 200 upstream parse/empty-body glitches (e.g. "Expecting value: line 1 column 1")
      if (attempt === 0 && !shouldAbort?.() && TRANSIENT_UPSTREAM_ERROR_RE.test(cleanErr)) {
        await sleep(450);
        continue;
      }
      break;
    }

    return lastResult;
  }

  async sendOtp(mobile, { shouldAbort = null, preferredKey = '' } = {}) {
    const res = await this._postJson('/api/auth/send_otp', { mobile }, {
      timeoutMs: this.timeouts.sendOtpMs,
      retries: 1,
      shouldAbort,
      preferredKey,
    });
    if (res.aborted) return { ok: false, aborted: true };
    const d = res.data || {};
    if (res.ok && d.success && d.sid && d.tid) {
      return {
        ok: true,
        key: res.key,
        sid: String(d.sid),
        tid: String(d.tid),
        deviceId: String(d.device_id || d.deviceId || ''),
        mobile,
      };
    }
    const reason = sanitizeErrorText(d.error || d.detail || d.message || d.raw || res.error || 'Toing send_otp failed', 180);
    const alreadyRegistered = /(already\s*registered|mobile\s+number\s+is\s+already\s+registered)/i.test(reason);
    const suspended = /(account\s+is\s+suspended|account\s+(?:has\s+been\s+)?(?:suspended|banned|disabled|deactivated)|permanently\s+blocked)/i.test(reason);
    const retryCooldownMs = (alreadyRegistered || suspended) ? 0 : parseSendOtpCooldownMs(reason);
    return {
      ok: false,
      status: res.status,
      alreadyRegistered,
      suspended,
      retryCooldownMs,
      reason,
    };
  }

  async verifyOtp({ mobile, otp, sid, tid, deviceId, isNew }, { shouldAbort = null, preferredKey = '' } = {}) {
    const res = await this._postJson('/api/auth/verify_otp', {
      mobile,
      otp,
      sid,
      tid,
      device_id: deviceId || '',
      is_new: Boolean(isNew),
    }, {
      timeoutMs: this.timeouts.verifyOtpMs,
      retries: 1,
      shouldAbort,
      preferredKey,
    });
    if (res.aborted) return { ok: false, aborted: true };
    const d = res.data || {};
    if (res.ok && d.success) {
      return { ok: true, key: res.key, data: d };
    }
    return {
      ok: false,
      status: res.status,
      reason: sanitizeErrorText(d.error || d.detail || d.message || d.raw || res.error || 'Toing verify_otp failed', 180),
    };
  }

  async exportAccount(mobile, { otpState = {}, shouldAbort = null, preferredKey = '' } = {}) {
    // 3 retries after verify_otp so a verified account is NEVER lost due to a transient hiccup!
    const res = await this._postJson(`/api/accounts/${encodeURIComponent(mobile)}/export`, undefined, {
      timeoutMs: this.timeouts.exportMs,
      retries: 3,
      shouldAbort,
      preferredKey,
    });
    const d = res.data || {};
    if (res.ok && d.success && d.export) {
      const raw = d.export;
      return {
        ok: true,
        fallback: false,
        exportObj: {
          mobile: String(raw.mobile || raw.phone || mobile).replace(/\D/g, '').slice(-10),
          name: String(raw.name || raw.customer_name || raw.userName || '').trim(),
          token: String(raw.token || raw.user_token || raw.access_token || '').trim(),
          sid: String(raw.sid || raw.session_id || otpState.sid || '').trim(),
          tid: String(raw.tid || raw.transaction_id || otpState.tid || '').trim(),
          deviceId: String(raw.deviceId || raw.device_id || otpState.deviceId || '').trim(),
          customerId: String(raw.customerId || raw.customer_id || raw.userId || raw.user_id || '').trim(),
        },
      };
    }

    // Fallback minimal export so verified session is still captured & saved
    return {
      ok: true,
      fallback: true,
      reason: String(d.error || d.detail || res.error || 'export_fallback').slice(0, 140),
      exportObj: {
        mobile,
        name: '',
        token: '',
        sid: String(otpState.sid || '').trim(),
        tid: String(otpState.tid || '').trim(),
        deviceId: String(otpState.deviceId || '').trim(),
        customerId: '',
      },
    };
  }

  getStats() {
    return {
      ...this.metrics,
      semaphore: this.semaphore.stats(),
      keysCount: (this.getAccessKeys() || []).length,
    };
  }
}
