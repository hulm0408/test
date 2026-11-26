// ===== Isolated Per-Slot Telegram MTProto Client =====
// Zero global singletons! Up to 50 instances run simultaneously in one Node process.
// Each instance owns its own TelegramClient, per-slot mutex, entity cache, and tracked card ID.

import { getOtpBotProfile, otpBotButtonRole, selectOtpBotScreenAction } from './otp-profiles.js';
import {
  candidateIsNew,
  messageDateMs,
  messageEditMs,
  messageId,
  messageSignature,
  messageText,
  normalizePhone10,
  parseTelegramNumberCard,
  parseTelegramOtpMessage,
  selectLatestFreshNumberCard,
} from './otp-parser.js';
import { isConnectionError } from './telegram-health.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

async function sleepInterruptibly(ms, shouldAbort) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    if (shouldAbort?.()) return;
    await sleep(Math.min(200, end - Date.now()));
  }
}

let teleprotoPromise = null;
export async function loadTeleproto() {
  if (!teleprotoPromise) {
    teleprotoPromise = Promise.all([
      import('teleproto'),
      import('teleproto/sessions'),
      import('teleproto/tl/generated/api.js'),
    ]).then(([main, sessions, apiMod]) => {
      // Quiet down noisy MTProto info logs when 50 clients run in parallel
      try {
        const Logger = main.Logger || main.default?.Logger;
        if (Logger?.setLevel) Logger.setLevel('error');
      } catch {}

      try {
        const CodeSettings = apiMod.Api?.CodeSettings;
        if (CodeSettings && !CodeSettings.__smsPatched) {
          const origCtor = CodeSettings;
          CodeSettings.__smsPatched = true;
          const patched = function CodeSettingsSmsOnly(...args) {
            const inst = new origCtor(...args);
            inst.appSandbox = false;
            return inst;
          };
          patched.prototype = origCtor.prototype;
          Object.assign(patched, origCtor);
          apiMod.Api.CodeSettings = patched;
        }
      } catch {}

      return {
        TelegramClient: main.TelegramClient,
        StringSession: sessions.StringSession,
        apiMod,
      };
    });
  }
  return teleprotoPromise;
}

function accountMeLabel(user) {
  if (!user) return '';
  const username = user.username ? `@${user.username}` : '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const phone = user.phone ? `+${String(user.phone).replace(/^\+/, '')}` : '';
  return [username || name, phone].filter(Boolean).join(' · ') || `id:${user.id}`;
}

function isIncomingMessage(message) {
  if (!message) return false;
  if (message.out === true) return false;
  return true;
}

function buttonText(button) {
  try { return String(button?.text || button?.button?.text || ''); } catch { return ''; }
}

async function getMessageButtons(message) {
  let rows;
  try { rows = message?.buttons; } catch {}
  if (!rows) {
    try {
      rows = typeof message?.getButtons === 'function' ? await message.getButtons() : null;
    } catch {}
  }
  if (!rows) rows = message?._buttons || (message?._buttonsFlat ? [message._buttonsFlat] : []);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (Array.isArray(row) ? row : [row])).filter(Boolean);
}

export class TelegramSlotClient {
  constructor({
    slotId,
    slotNo,
    label = '',
    session,
    apiId,
    apiHash,
    otpBotProfile = 'hathi',
  } = {}) {
    this.slotId = Number(slotId);
    this.slotNo = Number(slotNo);
    this.label = String(label || `Slot-${slotNo}`);
    Object.defineProperty(this, '_session', { value: String(session || '').trim(), enumerable: false });
    this.apiId = Number(apiId) || 0;
    this.apiHash = String(apiHash || '').trim();
    this.profile = getOtpBotProfile(otpBotProfile);

    this.client = null;
    this.entity = null;
    this.entityUsername = '';
    this.meLabel = '';
    this.connected = false;
    this.trackedOtpMessageIds = [];
    this.currentCardMessageId = 0;
    this.currentPhone = '';
    this._lock = Promise.resolve();
  }

  setBotProfile(profileId) {
    const next = getOtpBotProfile(profileId);
    if (next.id !== this.profile.id) {
      this.profile = next;
      this.entity = null;
      this.entityUsername = '';
      this.trackedOtpMessageIds = [];
      this.currentCardMessageId = 0;
    }
    return this.profile;
  }

  _withSlotLock(fn) {
    const prev = this._lock.catch(() => {});
    let release;
    const gate = new Promise((r) => { release = r; });
    this._lock = prev.then(() => gate);
    return prev.then(() => fn()).finally(() => release());
  }

  async _ensureConnectedUnlocked() {
    if (!this.apiId || !this.apiHash) {
      throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing');
    }
    if (!this._session) {
      throw new Error('SESSION_INVALID: empty session');
    }

    if (this.client && this.connected) {
      const looksUp = this.client.connected !== false && !this.client.disconnected;
      if (looksUp) return this.client;
    }

    await this._disconnectUnlocked();

    const { TelegramClient, StringSession } = await loadTeleproto();
    const client = new TelegramClient(new StringSession(this._session), this.apiId, this.apiHash, {
      connectionRetries: 2,
      requestRetries: 1,
      autoReconnect: true,
      reconnectRetries: 2,
      floodSleepThreshold: 15,
      // Crucial for 50 parallel accounts: skip background update loop overhead
      receiveUpdates: false,
      deviceModel: `ToingWorker-${this.slotNo}`,
      systemVersion: process.version,
      appVersion: '2.0.0',
      langCode: 'en',
      systemLangCode: 'en',
    });

    // Silence per-client verbose logs if supported
    try { client.setLogLevel?.('error'); } catch {}

    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: MTProto connect timed out (20s)')), 20_000)),
    ]);

    const authorized = await client.checkAuthorization().catch(() => false);
    if (!authorized) {
      try { await client.disconnect(); } catch {}
      throw new Error('AUTH_KEY_UNREGISTERED: Telegram session not authorized');
    }

    try {
      const me = await client.getMe();
      this.meLabel = accountMeLabel(me);
    } catch {}

    this.client = client;
    this.connected = true;
    this.entity = null;
    this.entityUsername = '';
    return client;
  }

  async _ensureEntityUnlocked() {
    const client = await this._ensureConnectedUnlocked();
    if (this.entity && this.entityUsername === this.profile.username) {
      return this.entity;
    }
    this.entity = await client.getEntity(this.profile.username);
    this.entityUsername = this.profile.username;
    return this.entity;
  }

  async _disconnectUnlocked() {
    const c = this.client;
    this.client = null;
    this.entity = null;
    this.entityUsername = '';
    this.connected = false;
    if (c) {
      try { await c.disconnect(); } catch {}
      try { await c.destroy?.(); } catch {}
    }
  }

  _invalidateIfConnectionError(err) {
    if (isConnectionError(err)) {
      this.connected = false;
      this.entity = null;
    }
  }

  async connect() {
    return this._withSlotLock(async () => {
      await this._ensureConnectedUnlocked();
      await this._ensureEntityUnlocked();
      return { ok: true, me: this.meLabel, botUsername: this.profile.username };
    });
  }

  async disconnect() {
    return this._withSlotLock(async () => {
      await this._disconnectUnlocked();
    });
  }

  async _fetchIncomingUnlocked(limit = 10) {
    try {
      const client = await this._ensureConnectedUnlocked();
      const entity = await this._ensureEntityUnlocked();
      const msgs = await client.getMessages(entity, { limit: Math.max(1, Number(limit) || 10) });
      const arr = Array.isArray(msgs) ? msgs : [...(msgs || [])];
      return arr.filter(isIncomingMessage);
    } catch (err) {
      this._invalidateIfConnectionError(err);
      throw err;
    }
  }

  _trackMessageId(id = 0) {
    const n = Number(id) || 0;
    if (!n) return;
    if (!this.trackedOtpMessageIds.includes(n)) {
      this.trackedOtpMessageIds.push(n);
      while (this.trackedOtpMessageIds.length > 6) this.trackedOtpMessageIds.shift();
    }
  }

  async _fetchTrackedUnlocked(knownMessages = []) {
    const known = new Set((knownMessages || []).map(messageId));
    const ids = [...new Set([...this.trackedOtpMessageIds, this.currentCardMessageId])]
      .map(Number)
      .filter((id) => id > 0 && !known.has(id))
      .slice(-6);
    if (!ids.length) return [];
    try {
      const client = await this._ensureConnectedUnlocked();
      const entity = await this._ensureEntityUnlocked();
      const extra = await client.getMessages(entity, { ids });
      const out = [];
      for (const m of (Array.isArray(extra) ? extra : [...(extra || [])])) {
        if (m && !known.has(messageId(m))) {
          out.push(m);
          known.add(messageId(m));
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async _latestScreenUnlocked(limit = 6) {
    const messages = await this._fetchIncomingUnlocked(limit);
    for (const message of messages) {
      const buttons = await getMessageButtons(message);
      const entries = buttons
        .map((button) => ({
          button,
          text: buttonText(button),
          role: otpBotButtonRole(buttonText(button), this.profile),
        }))
        .filter((e) => e.text);
      if (!entries.length) continue;
      const text = messageText(message);
      return {
        message,
        text,
        entries,
        buttons: entries.map((e) => e.text),
        buttonRoles: entries.map((e) => e.role),
        card: parseTelegramNumberCard(text),
      };
    }
    return null;
  }

  async _clickLatestButtonUnlocked({ mode = 'claim', phone = '' } = {}) {
    const screen = await this._latestScreenUnlocked(6);
    if (!screen) return { ok: false, reason: 'no-latest-screen' };

    const action = selectOtpBotScreenAction([screen], {
      mode,
      phone,
      profileId: this.profile.id,
      cardPhoneOf: (t) => parseTelegramNumberCard(t)?.phone || '',
    });
    if (!action?.role || action.buttonIndex < 0) {
      return {
        ok: false,
        reason: action?.reason || 'no-matching-button',
        messageId: messageId(screen.message),
        cardPhone: screen.card?.phone || '',
      };
    }

    const entry = screen.entries[action.buttonIndex];
    const answer = await entry.button.click({});
    return {
      ok: true,
      role: action.role,
      messageId: messageId(screen.message),
      screenSignature: messageSignature(screen.message),
      buttonText: entry.text,
      cardPhone: screen.card?.phone || '',
      callbackMessage: String(answer?.message || '').trim().slice(0, 160),
    };
  }

  async _sendStartUnlocked() {
    const client = await this._ensureConnectedUnlocked();
    const entity = await this._ensureEntityUnlocked();
    await client.sendMessage(entity, { message: this.profile.startCommand || '/start' });
  }

  // Claim a fresh phone number card from this slot's OTP bot.
  async claimFreshNumber({
    forceNew = true,
    excludePhones = new Set(),
    timeoutMs = 15_000,
    shouldAbort = null,
  } = {}) {
    return this._withSlotLock(async () => {
      const deadline = Date.now() + Math.max(4_000, Number(timeoutMs) || 15_000);
      const remaining = () => Math.max(0, deadline - Date.now());

      if (!forceNew) {
        const msgs = await this._fetchIncomingUnlocked(8);
        const sel = selectLatestFreshNumberCard(msgs, { excludePhones });
        if (sel.status === 'fresh') {
          this.currentCardMessageId = messageId(sel.result.message);
          this.currentPhone = sel.result.card.phone;
          this._trackMessageId(this.currentCardMessageId);
          return { ok: true, phone: sel.result.card.phone, card: sel.result.card, messageId: this.currentCardMessageId };
        }
      }

      const currentSigs = async () => new Set((await this._fetchIncomingUnlocked(12)).map(messageSignature));
      let baselineSignatures = await currentSigs();
      let cursor = { afterMessageId: 0, afterSignature: '', afterPhone: '' };
      let sentStart = false;

      for (let cycle = 0; cycle < 3 && remaining() > 500; cycle++) {
        if (shouldAbort?.()) return { ok: false, aborted: true };

        const clicked = await this._clickLatestButtonUnlocked({ mode: 'claim' });
        if (!clicked.ok) {
          if (sentStart || remaining() <= 1_500) break;
          sentStart = true;
          await this._sendStartUnlocked();
          await sleepInterruptibly(Math.min(800, remaining()), shouldAbort);
          baselineSignatures = await currentSigs();
          continue;
        }

        cursor = {
          afterMessageId: clicked.messageId || 0,
          afterSignature: clicked.screenSignature || '',
          afterPhone: clicked.cardPhone || '',
        };

        const waitBudget = cycle === 2 ? remaining() : Math.min(6_500, remaining());
        const waitEnd = Date.now() + waitBudget;
        while (Date.now() < waitEnd) {
          if (shouldAbort?.()) return { ok: false, aborted: true };
          const msgs = await this._fetchIncomingUnlocked(12);
          const sel = selectLatestFreshNumberCard(msgs, {
            baselineSignatures,
            excludePhones,
            ...cursor,
          });
          if (sel.status === 'fresh') {
            this.currentCardMessageId = messageId(sel.result.message);
            this.currentPhone = sel.result.card.phone;
            this._trackMessageId(this.currentCardMessageId);
            return {
              ok: true,
              phone: sel.result.card.phone,
              card: sel.result.card,
              messageId: this.currentCardMessageId,
            };
          }
          await sleepInterruptibly(Math.min(600, Math.max(0, waitEnd - Date.now())), shouldAbort);
        }

        if (shouldAbort?.() || remaining() <= 500) return { ok: false, aborted: Boolean(shouldAbort?.()), reason: 'claim_timeout' };

        baselineSignatures = await currentSigs();
        const latestMsgs = await this._fetchIncomingUnlocked(8);
        const latestAny = selectLatestFreshNumberCard(latestMsgs, { excludePhones: new Set() });
        if (latestAny.status === 'fresh' && excludePhones.has(latestAny.result.card.phone)) {
          // Bot gave an excluded phone — loop immediately to click NEW NUMBER again
          continue;
        }
        if (!sentStart && cycle === 0 && remaining() > 2_000) {
          sentStart = true;
          await this._sendStartUnlocked();
          await sleepInterruptibly(Math.min(800, remaining()), shouldAbort);
          baselineSignatures = await currentSigs();
        }
      }

      return { ok: false, reason: 'claim_timeout' };
    });
  }

  // CRITICAL: Call BEFORE Toing send_otp so fast 1-2s OTPs are NEVER ignored!
  async captureOtpWatermark(phone) {
    return this._withSlotLock(async () => {
      const ts = Date.now();
      try {
        const recent = await this._fetchIncomingUnlocked(12);
        const tracked = await this._fetchTrackedUnlocked(recent);
        const all = [...recent, ...tracked];
        const codes = new Set();
        const ids = new Set();
        let maxId = 0;
        for (const message of all) {
          const parsed = parseTelegramOtpMessage(message);
          ids.add(`tg:${messageId(message)}:${messageEditMs(message)}:${parsed?.signature || ''}`);
          if (parsed?.code) codes.add(parsed.code);
          maxId = Math.max(maxId, messageId(message));
        }
        return { codes: [...codes], ids: [...ids], ts, afterMs: ts, messageId: maxId };
      } catch (err) {
        return { codes: [], ids: [], ts, afterMs: ts, messageId: 0, error: String(err?.message || err).slice(0, 120) };
      }
    });
  }

  async _readOtpCandidatesUnlocked(phone) {
    const cleanPhone = normalizePhone10(phone);
    const recent = await this._fetchIncomingUnlocked(12);
    const tracked = await this._fetchTrackedUnlocked(recent);
    const messages = [...recent, ...tracked];

    const out = [];
    for (const message of messages) {
      const text = messageText(message);
      const digits = text.replace(/\D/g, '');
      if (/otp|sms|verif|passcode|\bcode\b/i.test(text) || (cleanPhone && digits.includes(cleanPhone))) {
        this._trackMessageId(messageId(message));
      }
      const parsed = parseTelegramOtpMessage(message);
      if (!parsed?.code) continue;
      if (parsed.phone && parsed.phone !== cleanPhone) continue;
      if (!parsed.phone && this.currentPhone && this.currentPhone !== cleanPhone) continue;

      out.push({
        message,
        parsed,
        ts: Math.max(messageDateMs(message), messageEditMs(message)),
        messageId: messageId(message),
        phoneMatched: Boolean(parsed.phone && parsed.phone === cleanPhone),
        idKey: `tg:${messageId(message)}:${messageEditMs(message)}:${parsed.signature}`,
      });
    }
    out.sort((a, b) => Number(b.phoneMatched) - Number(a.phoneMatched));
    return out;
  }

  // Targeted refresh: prefers clicking REFRESH right on the active number card (minimum RPCs!)
  async _refreshOtpChatUnlocked(phone, attempt = 1) {
    const wanted = normalizePhone10(phone);
    const allowed = this.profile.refreshRoles || ['refresh'];
    let fallbackEntry = null;

    try {
      const recent = await this._fetchIncomingUnlocked(8);
      const tracked = await this._fetchTrackedUnlocked(recent);
      for (const message of [...tracked, ...recent]) {
        const buttons = await getMessageButtons(message);
        const entries = buttons
          .map((button) => ({
            button,
            text: buttonText(button),
            role: otpBotButtonRole(buttonText(button), this.profile),
          }))
          .filter((e) => e.text);
        if (!entries.length) continue;

        const cardPhone = parseTelegramNumberCard(messageText(message))?.phone || '';
        const matchEntry = entries.find((e) => allowed.includes(e.role));
        if (!matchEntry) continue;

        if (wanted && cardPhone && cardPhone !== wanted) {
          if (!fallbackEntry) fallbackEntry = matchEntry;
          continue;
        }
        await matchEntry.button.click({});
        return { ok: true, via: 'click' };
      }
      if (fallbackEntry && attempt >= 2) {
        await fallbackEntry.button.click({});
        return { ok: true, via: 'click-fallback' };
      }
    } catch (err) {
      this._invalidateIfConnectionError(err);
      throw err;
    }

    // Text fallback if button vanished
    const client = await this._ensureConnectedUnlocked();
    const entity = await this._ensureEntityUnlocked();
    await client.sendMessage(entity, { message: this.profile.refreshText || 'Refresh' });
    return { ok: true, via: 'text' };
  }

  async waitForOtp(phone, {
    baseline = null,
    timeoutMs = 20_000,
    refreshMs = 1_800,
    shouldAbort = null,
  } = {}) {
    return this._withSlotLock(async () => {
      const cleanPhone = normalizePhone10(phone);
      const totalMs = Math.max(4_000, Number(timeoutMs) || 20_000);
      const baseRefreshMs = Math.max(900, Number(refreshMs) || 1_800);
      const acceptAnyAfterMs = Math.min(10_000, Math.floor(totalMs * 0.55));
      const startedAt = Date.now();
      const deadline = startedAt + totalMs;

      const normBaseline = {
        ids: new Set(baseline?.ids || []),
        codes: new Set(baseline?.codes || []),
        ts: Number(baseline?.ts) || startedAt,
        afterMs: Number(baseline?.afterMs || baseline?.ts) || startedAt,
        messageId: Number(baseline?.messageId) || 0,
      };

      let currentRefreshMs = baseRefreshMs;
      let lastRefreshAt = 0;
      let attempts = 0;
      let lastError = null;

      while (Date.now() < deadline) {
        if (shouldAbort?.()) return { ok: false, aborted: true, code: '' };
        const iterStart = Date.now();

        try {
          const candidates = await this._readOtpCandidatesUnlocked(cleanPhone);
          const fresh = candidates.filter((c) => candidateIsNew(c, normBaseline));
          const swiggy = fresh.find((c) =>
            /swiggy|swgtns|toing/i.test(c.parsed.sender || '') ||
            /swiggy|swgtns|toing/i.test(messageText(c.message) || '')
          );
          const chosen = swiggy || ((Date.now() - startedAt) >= acceptAnyAfterMs ? fresh[0] : null);
          if (chosen) {
            return {
              ok: true,
              code: chosen.parsed.code,
              sender: chosen.parsed.sender || '',
              elapsedMs: Date.now() - startedAt,
            };
          }
        } catch (err) {
          lastError = err;
          // Re-throw fatal / flood errors immediately so SlotWorker handles health properly
          if (/FLOOD_WAIT|PEER_FLOOD|AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|CHAT_WRITE_FORBIDDEN/i.test(String(err?.message || err))) {
            throw err;
          }
        }

        if (shouldAbort?.() || Date.now() >= deadline) break;

        const now = Date.now();
        if (now - lastRefreshAt >= currentRefreshMs) {
          lastRefreshAt = now;
          attempts += 1;
          try {
            await this._refreshOtpChatUnlocked(cleanPhone, attempts);
          } catch (err) {
            lastError = err;
            if (/FLOOD_WAIT|PEER_FLOOD|AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|CHAT_WRITE_FORBIDDEN/i.test(String(err?.message || err))) {
              throw err;
            }
          }
        }

        const iterMs = Date.now() - iterStart;
        if (iterMs > 2_000) {
          currentRefreshMs = Math.min(5_000, Math.max(currentRefreshMs, iterMs));
        } else if (iterMs < 800 && currentRefreshMs > baseRefreshMs) {
          currentRefreshMs = Math.max(baseRefreshMs, currentRefreshMs - 400);
        }

        await sleepInterruptibly(Math.min(450, Math.max(0, deadline - Date.now())), shouldAbort);
      }

      return {
        ok: false,
        code: '',
        timeout: true,
        attempts,
        error: lastError ? String(lastError?.message || lastError).slice(0, 160) : `OTP timeout (${Math.round(totalMs / 1000)}s)`,
      };
    });
  }
}

// ── Interactive Phone Login (for /addaccount inside Telegram bot) ───────────
// Completely independent temporary TelegramClient — NEVER pauses or blocks running slots!
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
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return '';
}

export async function loginInteractiveSession({ apiId, apiHash, callbacks, shouldAbort = null } = {}) {
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH env me set karo (my.telegram.org).');
  }
  const { TelegramClient, StringSession, apiMod } = await loadTeleproto();
  const client = new TelegramClient(new StringSession(''), Number(apiId), String(apiHash), {
    connectionRetries: 3,
    requestRetries: 2,
    autoReconnect: true,
    receiveUpdates: false,
    deviceModel: 'ToingRailwayLogin',
    systemVersion: process.version,
    appVersion: '2.0.0',
    langCode: 'en',
    systemLangCode: 'en',
  });
  try { client.setLogLevel?.('error'); } catch {}

  // Force SMS delivery on SendCode if Telegram tried app/call first
  const originalInvoke = client.invoke.bind(client);
  let smsForceAttempted = false;
  client.invoke = async (request) => {
    try {
      const result = await originalInvoke(request);
      if (request?.className === 'SendCode' && result && apiMod?.Api) {
        const Api = apiMod.Api;
        if (result instanceof Api.auth?.SentCode && !(result.type instanceof Api.auth?.SentCodeTypeSms) && !smsForceAttempted) {
          smsForceAttempted = true;
          try {
            const resend = await originalInvoke(new Api.auth.ResendCode({
              phoneNumber: request.phoneNumber,
              phoneCodeHash: result.phoneCodeHash,
            }));
            if (resend instanceof Api.auth?.SentCode && resend.type instanceof Api.auth?.SentCodeTypeSms) {
              return resend;
            }
          } catch {}
        }
      }
      return result;
    } finally {
      if (request?.className === 'SendCode') smsForceAttempted = false;
    }
  };

  const checkAbort = () => {
    if (shouldAbort?.()) throw new Error('Login cancelled');
  };

  try {
    let phoneUsed = '';
    await client.start({
      forceSMS: true,
      phoneNumber: async () => {
        checkAbort();
        const raw = await callbacks.phoneNumber();
        checkAbort();
        phoneUsed = normalizeTelegramLoginPhone(raw);
        if (!phoneUsed) throw new Error('Valid phone number daalo (e.g. +919876543210)');
        return phoneUsed;
      },
      phoneCode: async () => {
        checkAbort();
        const raw = await callbacks.phoneCode();
        checkAbort();
        const code = String(raw || '').replace(/[\s-]+/g, '').trim();
        if (!code) throw new Error('OTP code khali hai');
        return code;
      },
      password: async (hint) => {
        checkAbort();
        const raw = await callbacks.password(hint);
        checkAbort();
        return String(raw || '');
      },
      onError: async (err) => {
        if (shouldAbort?.()) return true;
        if (typeof callbacks.onError === 'function') return Boolean(await callbacks.onError(err));
        return false;
      },
    });

    checkAbort();
    const session = String(client.session?.save?.() || '').trim();
    if (!session) throw new Error('Session string khali mili');
    let me = '';
    try { me = accountMeLabel(await client.getMe()); } catch {}
    return { ok: true, session, me, phone: phoneUsed };
  } finally {
    try { await client.disconnect(); } catch {}
    try { await client.destroy?.(); } catch {}
  }
}
