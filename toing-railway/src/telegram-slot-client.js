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
      import('teleproto/events').catch(() => ({})),
    ]).then(([main, sessions, apiMod, eventsMod]) => ({
      TelegramClient: main.TelegramClient,
      Logger: main.Logger || main.default?.Logger || null,
      StringSession: sessions.StringSession,
      apiMod,
      NewMessage: eventsMod?.NewMessage || null,
      EditedMessage: eventsMod?.EditedMessage || null,
    }));
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

function normalizeEntityIdStr(val) {
  if (val === undefined || val === null) return '';
  return String(val).trim().replace(/^-/, '');
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
    botPacer = null,
  } = {}) {
    this.slotId = Number(slotId);
    this.slotNo = Number(slotNo);
    this.label = String(label || `Slot-${slotNo}`);
    Object.defineProperty(this, '_session', { value: String(session || '').trim(), enumerable: false });
    this.apiId = Number(apiId) || 0;
    this.apiHash = String(apiHash || '').trim();
    this.profile = getOtpBotProfile(otpBotProfile);
    this.botPacer = botPacer || null;

    this.client = null;
    this.entity = null;
    this.inputEntity = null;
    this.entityUsername = '';
    this.meLabel = '';
    this.connected = false;
    this.trackedOtpMessageIds = [];
    this.currentCardMessageId = 0;
    this.currentPhone = '';
    this._lock = Promise.resolve();

    // Real-time MTProto push buffer (eliminates 95%+ of messages.GetHistory polling & FLOOD_WAITs!)
    this._pushedMessages = [];
    this._pushEpoch = 0;
    this._pushWaiters = new Set();
    this._pushActive = false;
  }

  _clearPushCache() {
    this._pushedMessages = [];
    this._pushEpoch += 1;
    this._notifyPushWaiters();
  }

  _notifyPushWaiters() {
    if (!this._pushWaiters.size) return;
    const waiters = [...this._pushWaiters];
    this._pushWaiters.clear();
    for (const wake of waiters) {
      try { wake(true); } catch {}
    }
  }

  _hydratePushedMessage(msg) {
    if (!msg) return;
    if (this.inputEntity && !msg._inputChat) {
      try { msg._inputChat = this.inputEntity; } catch {}
    }
    if (this.inputEntity && !msg._inputSender) {
      try { msg._inputSender = this.inputEntity; } catch {}
    }
    if (this.client && !msg._client) {
      try { msg._client = this.client; } catch {}
    }
  }

  _mergeMessagesIntoCache(messages = [], { notify = false } = {}) {
    if (!Array.isArray(messages) || !messages.length) return;
    let changed = false;
    for (const msg of messages) {
      if (!isIncomingMessage(msg)) continue;
      this._hydratePushedMessage(msg);
      const id = messageId(msg);
      const existingIdx = id > 0 ? this._pushedMessages.findIndex((m) => messageId(m) === id) : -1;
      if (existingIdx >= 0) {
        const prev = this._pushedMessages[existingIdx];
        // Replace on edit or when fetched copy has fresher edit timestamp / text
        const prevEdit = messageEditMs(prev);
        const nextEdit = messageEditMs(msg);
        if (notify || nextEdit >= prevEdit || messageSignature(msg) !== messageSignature(prev)) {
          this._pushedMessages[existingIdx] = msg;
          changed = true;
        }
      } else {
        this._pushedMessages.unshift(msg);
        changed = true;
      }
    }
    if (changed) {
      // Keep newest-edited / newest-created messages at front so active screen is always index 0
      this._pushedMessages.sort((a, b) => {
        const tsDiff = Math.max(messageEditMs(b), messageDateMs(b)) - Math.max(messageEditMs(a), messageDateMs(a));
        if (tsDiff !== 0) return tsDiff;
        return messageId(b) - messageId(a);
      });
      if (this._pushedMessages.length > 15) {
        this._pushedMessages.length = 15;
      }
      if (notify) {
        this._pushEpoch += 1;
        this._notifyPushWaiters();
      }
    }
  }

  _ingestPushedMessage(msg) {
    if (!isIncomingMessage(msg)) return;
    this._mergeMessagesIntoCache([msg], { notify: true });
  }

  _attachPushHandlers(client, { NewMessage, EditedMessage } = {}) {
    if (!client || typeof client.addEventHandler !== 'function' || !NewMessage) {
      this._pushActive = false;
      return;
    }
    const onBotEvent = (event) => {
      try {
        const msg = event?.message;
        if (!msg || msg.out === true) return;
        const expectedId = normalizeEntityIdStr(this.entity?.id);
        if (!expectedId) return;
        const candidates = [
          normalizeEntityIdStr(msg.peerId?.userId),
          normalizeEntityIdStr(msg.chatId),
          normalizeEntityIdStr(msg.senderId),
        ].filter(Boolean);
        if (!candidates.includes(expectedId)) return;
        this._ingestPushedMessage(msg);
      } catch {}
    };
    try {
      client.addEventHandler(onBotEvent, new NewMessage({ incoming: true }));
      if (EditedMessage) {
        client.addEventHandler(onBotEvent, new EditedMessage({ incoming: true }));
      }
      this._pushActive = true;
    } catch {
      this._pushActive = false;
    }
  }

  async _waitForPush(maxMs, shouldAbort, sinceEpoch) {
    if (this._pushEpoch !== sinceEpoch) return true;
    const budget = Math.max(0, Number(maxMs) || 0);
    if (budget <= 0 || shouldAbort?.()) return false;

    return new Promise((resolve) => {
      let done = false;
      const finish = (gotPush) => {
        if (done) return;
        done = true;
        this._pushWaiters.delete(onPush);
        clearTimeout(timer);
        if (abortPoll) clearInterval(abortPoll);
        resolve(gotPush);
      };
      const onPush = () => finish(true);
      this._pushWaiters.add(onPush);
      const timer = setTimeout(() => finish(this._pushEpoch !== sinceEpoch), budget);
      const abortPoll = typeof shouldAbort === 'function'
        ? setInterval(() => {
          if (shouldAbort()) finish(false);
        }, Math.min(200, Math.max(40, budget)))
        : null;
      // Re-check immediately in case a push raced before registering waiter
      if (this._pushEpoch !== sinceEpoch) finish(true);
    });
  }

  setBotProfile(profileId) {
    const next = getOtpBotProfile(profileId);
    if (next.id !== this.profile.id) {
      this.profile = next;
      this.entity = null;
      this.inputEntity = null;
      this.entityUsername = '';
      this.trackedOtpMessageIds = [];
      this.currentCardMessageId = 0;
      this._clearPushCache();
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

    if (this.client) {
      // If teleproto autoReconnect is mid-flight, wait briefly instead of tearing down!
      if (this.client._sender?.isReconnecting || this.client._sender?.isConnecting) {
        const waitEnd = Date.now() + 4_000;
        while (Date.now() < waitEnd) {
          if (this.client.connected && !this.client.disconnected) {
            this.connected = true;
            return this.client;
          }
          await sleep(150);
        }
      }

      if (this.connected && this.client.connected !== false && !this.client.disconnected) {
        return this.client;
      }

      // Reuse existing non-destroyed client via connect() before creating a brand-new instance
      if (!this.client._destroyed) {
        try {
          await Promise.race([
            this.client.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: MTProto reconnect timed out (15s)')), 15_000)),
          ]);
          if (this.client.connected && !this.client.disconnected) {
            this.connected = true;
            return this.client;
          }
        } catch {}
      }
    }

    await this._disconnectUnlocked();

    const { TelegramClient, StringSession, Logger, NewMessage, EditedMessage } = await loadTeleproto();
    const baseLogger = typeof Logger === 'function' ? new Logger('error') : undefined;
    const client = new TelegramClient(new StringSession(this._session), this.apiId, this.apiHash, {
      connectionRetries: 2,
      // requestRetries MUST be >= 2 so teleproto's floodWait & internal-error retry policies actually execute!
      requestRetries: 3,
      autoReconnect: true,
      reconnectRetries: 3,
      floodSleepThreshold: 10,
      // Push-driven bot updates (NewMessage + EditedMessage) cut messages.GetHistory RPCs by 95%+
      receiveUpdates: true,
      ...(baseLogger ? { baseLogger } : {}),
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
    this.inputEntity = null;
    this.entityUsername = '';
    this._clearPushCache();
    this._attachPushHandlers(client, { NewMessage, EditedMessage });
    console.log(`[Slot #${this.slotNo}] 🔌 Connected (${this.meLabel || this.label}) | bot=@${this.profile.username}${this._pushActive ? ' | push=ON' : ''}`);
    return client;
  }

  async _ensureEntityUnlocked() {
    const client = await this._ensureConnectedUnlocked();
    if (this.entity && this.entityUsername === this.profile.username) {
      return this.entity;
    }
    this.entity = await client.getEntity(this.profile.username);
    this.entityUsername = this.profile.username;
    try {
      this.inputEntity = typeof client.getInputEntity === 'function'
        ? await client.getInputEntity(this.entity)
        : this.entity;
    } catch {
      this.inputEntity = this.entity;
    }
    return this.entity;
  }

  async _disconnectUnlocked() {
    const c = this.client;
    this.client = null;
    this.entity = null;
    this.inputEntity = null;
    this.entityUsername = '';
    this.connected = false;
    this._pushActive = false;
    this._clearPushCache();
    if (c) {
      try { await c.disconnect(); } catch {}
      try { await c.destroy?.(); } catch {}
    }
  }

  _invalidateIfConnectionError(err) {
    if (isConnectionError(err)) {
      this.connected = false;
      this.entity = null;
      this.inputEntity = null;
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

  async _fetchIncomingUnlocked(limit = 6) {
    try {
      const client = await this._ensureConnectedUnlocked();
      const entity = await this._ensureEntityUnlocked();
      const msgs = await client.getMessages(entity, { limit: Math.max(1, Number(limit) || 6) });
      const arr = (Array.isArray(msgs) ? msgs : [...(msgs || [])]).filter(isIncomingMessage);
      this._mergeMessagesIntoCache(arr, { notify: false });
      return arr;
    } catch (err) {
      this._invalidateIfConnectionError(err);
      throw err;
    }
  }

  async _getMessagesCachedOrFetchUnlocked({ limit = 6, forceFetch = false } = {}) {
    await this._ensureEntityUnlocked();
    if (!forceFetch && this._pushActive && this._pushedMessages.length > 0) {
      return this._pushedMessages.slice(0, Math.max(1, Number(limit) || 6));
    }
    return this._fetchIncomingUnlocked(limit);
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
      this._mergeMessagesIntoCache(out, { notify: false });
      return out;
    } catch {
      return [];
    }
  }

  async _screenFromMessages(messages = []) {
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

  async _latestScreenUnlocked(limit = 6, { cachedMessages = null, forceFetch = false } = {}) {
    if (Array.isArray(cachedMessages) && cachedMessages.length > 0) {
      const cachedScreen = await this._screenFromMessages(cachedMessages);
      if (cachedScreen) return cachedScreen;
    }
    const messages = await this._getMessagesCachedOrFetchUnlocked({ limit, forceFetch });
    const screen = await this._screenFromMessages(messages);
    if (screen || forceFetch) return screen;
    // One fallback fetch if push cache had no interactive button screen
    const fresh = await this._fetchIncomingUnlocked(limit);
    return this._screenFromMessages(fresh);
  }

  async _safeClickButton(entry, { timeoutMs = 4_500 } = {}) {
    const startedAt = Date.now();
    const clickTimeoutMs = Math.max(1_500, Number(timeoutMs) || 4_500);
    let timer = null;
    try {
      const clickPromise = Promise.resolve().then(() => entry.button.click({}));
      // Prevent unhandled rejection if soft timeout wins and Telegram rejects late
      clickPromise.catch(() => {});

      const raceResult = await Promise.race([
        clickPromise.then((answer) => ({ done: true, answer })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ done: false, softTimeout: true }), clickTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);

      if (!raceResult.done) {
        // Callback already sent to Telegram; don't freeze slot for 10s waiting on bot toast!
        this.botPacer?.noteBotSlow(this.profile.id);
        return { clicked: true, softTimeout: true, callbackMessage: 'click_soft_timeout' };
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 2_800) {
        this.botPacer?.noteBotSlow(this.profile.id);
      } else if (elapsedMs < 2_000) {
        this.botPacer?.noteBotFast(this.profile.id);
      }
      return {
        clicked: true,
        callbackMessage: String(raceResult.answer?.message || '').trim().slice(0, 160),
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      const pool = `${err?.errorMessage || ''} ${err?.message || err || ''}`;
      if (/(BOT_RESPONSE_TIMEOUT|QUERY_ID_INVALID|MESSAGE_NOT_MODIFIED)/i.test(pool)) {
        // Callback reached Telegram; OTP bot simply took >5s to answer toast or card unchanged
        if (/BOT_RESPONSE_TIMEOUT/i.test(pool)) this.botPacer?.noteBotSlow(this.profile.id);
        return { clicked: true, softTimeout: true, callbackMessage: pool.trim().slice(0, 80) };
      }
      if (/(MESSAGE_ID_INVALID|BUTTON_INVALID|BUTTON_NOT_FOUND|DATA_INVALID)/i.test(pool)) {
        return { clicked: false, reason: pool.trim().slice(0, 80) };
      }
      this._invalidateIfConnectionError(err);
      throw err;
    }
  }

  async _clickLatestButtonUnlocked({ mode = 'claim', phone = '', cachedMessages = null } = {}) {
    const screen = await this._latestScreenUnlocked(6, { cachedMessages });
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
    const clickRes = await this._safeClickButton(entry);
    if (!clickRes.clicked) {
      return {
        ok: false,
        reason: clickRes.reason || 'button-click-invalid',
        messageId: messageId(screen.message),
        cardPhone: screen.card?.phone || '',
      };
    }
    return {
      ok: true,
      role: action.role,
      messageId: messageId(screen.message),
      screenSignature: messageSignature(screen.message),
      buttonText: entry.text,
      cardPhone: screen.card?.phone || '',
      callbackMessage: clickRes.callbackMessage || '',
      softTimeout: Boolean(clickRes.softTimeout),
    };
  }

  async _sendStartUnlocked() {
    const client = await this._ensureConnectedUnlocked();
    const entity = await this._ensureEntityUnlocked();
    await client.sendMessage(entity, { message: this.profile.startCommand || '/start' });
  }

  // Claim a fresh phone number card from this slot's OTP bot.
  // Push-first design: reuses cached messages + NewMessage/EditedMessage pushes (0 GetHistory RPCs in steady state!).
  async claimFreshNumber({
    forceNew = false,
    excludePhones = new Set(),
    timeoutMs = 16_000,
    shouldAbort = null,
  } = {}) {
    return this._withSlotLock(async () => {
      const budgetMs = Math.max(4_000, Number(timeoutMs) || 16_000);
      let deadline = Date.now() + budgetMs;
      const remaining = () => Math.max(0, deadline - Date.now());
      const excludedPhonesSeen = [];

      // Single read (from push cache if warm -> 0 GetHistory RPCs; else 1 initial fetch)
      let latestMsgs = await this._getMessagesCachedOrFetchUnlocked({ limit: 6 });

      // If forceNew=false, reuse an untouched fresh card ALREADY sitting on screen (0 wasted numbers!)
      if (!forceNew) {
        const sel = selectLatestFreshNumberCard(latestMsgs, { excludePhones });
        if (sel.status === 'fresh') {
          this.currentCardMessageId = messageId(sel.result.message);
          this.currentPhone = sel.result.card.phone;
          this._trackMessageId(this.currentCardMessageId);
          return {
            ok: true,
            phone: sel.result.card.phone,
            card: sel.result.card,
            messageId: this.currentCardMessageId,
            reusedOnScreen: true,
            excludedPhonesSeen,
          };
        }
      }

      let baselineSignatures = new Set(latestMsgs.map(messageSignature));
      let cursor = { afterMessageId: 0, afterSignature: '', afterPhone: '' };
      let sentStart = false;
      let lastFailureReason = 'claim_timeout';

      for (let cycle = 0; cycle < 3 && remaining() > 600; cycle++) {
        if (shouldAbort?.()) return { ok: false, aborted: true, excludedPhonesSeen };

        // Yield politely to shared per-bot pacer so NEW NUMBER scans never starve active OTP REFRESH clicks
        if (this.botPacer) {
          const granted = await this.botPacer.acquire(this.profile.id, { priority: 'claim', shouldAbort });
          if (!granted) return { ok: false, aborted: true, excludedPhonesSeen };
          // Pacer wait shouldn't eat the first click's response deadline
          if (cycle === 0) {
            deadline = Math.max(deadline, Date.now() + budgetMs);
          }
        }

        // Capture push epoch BEFORE clicking NEW NUMBER so even a 30ms bot reply during click() is caught!
        let lastEpoch = this._pushEpoch;
        const clicked = await this._clickLatestButtonUnlocked({ mode: 'claim', cachedMessages: latestMsgs });
        if (!clicked.ok) {
          lastFailureReason = clicked.reason || 'no-claim-button';
          if (sentStart || remaining() <= 1_800) break;
          sentStart = true;
          const startEpoch = this._pushEpoch;
          await this._sendStartUnlocked();
          const gotStartPush = await this._waitForPush(Math.min(2_200, remaining()), shouldAbort, startEpoch);
          latestMsgs = gotStartPush
            ? this._pushedMessages.slice(0, 6)
            : await this._fetchIncomingUnlocked(6);
          baselineSignatures = new Set(latestMsgs.map(messageSignature));
          continue;
        }

        cursor = {
          afterMessageId: clicked.messageId || 0,
          afterSignature: clicked.screenSignature || '',
          afterPhone: clicked.cardPhone || '',
        };

        // Generous first-click wait (up to 11s) so slow OTP bots finish replying instead of
        // double-clicking NEW NUMBER and throwing away the first number!
        const waitBudget = cycle === 0 ? Math.min(11_000, remaining()) : Math.min(6_500, remaining());
        const waitEnd = Date.now() + waitBudget;
        const fallbackPollGapMs = this._pushActive ? 3_000 : 650;
        let sawExcludedReply = false;

        while (Date.now() < waitEnd) {
          if (shouldAbort?.()) return { ok: false, aborted: true, excludedPhonesSeen };

          const waitSlice = Math.min(fallbackPollGapMs, Math.max(0, waitEnd - Date.now()));
          const gotPush = this._pushActive
            ? await this._waitForPush(waitSlice, shouldAbort, lastEpoch)
            : false;

          if (shouldAbort?.()) return { ok: false, aborted: true, excludedPhonesSeen };

          let msgs;
          if (gotPush) {
            lastEpoch = this._pushEpoch;
            msgs = this._pushedMessages.slice(0, 8);
          } else {
            // Safety fallback fetch only if no push arrived in 3.0s (or non-push mock)
            if (!this._pushActive && waitSlice > 0) {
              await sleepInterruptibly(waitSlice, shouldAbort);
              if (shouldAbort?.()) return { ok: false, aborted: true, excludedPhonesSeen };
            }
            msgs = await this._fetchIncomingUnlocked(5);
            lastEpoch = this._pushEpoch;
          }
          latestMsgs = msgs;

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
              reusedOnScreen: false,
              excludedPhonesSeen,
            };
          }
          // Bot already replied with a brand-new card, but its phone is in excludePhones ->
          // stop waiting immediately and request the next number!
          if (sel.status === 'excluded-latest' && sel.result?.card?.phone) {
            const dupPhone = sel.result.card.phone;
            if (!excludedPhonesSeen.includes(dupPhone)) excludedPhonesSeen.push(dupPhone);
            lastFailureReason = 'bot_returned_excluded';
            sawExcludedReply = true;
            break;
          }
        }

        if (shouldAbort?.() || remaining() <= 600) {
          return {
            ok: false,
            aborted: Boolean(shouldAbort?.()),
            reason: lastFailureReason,
            excludedPhonesSeen,
          };
        }

        // Reuse already-fetched/pushed messages for next baseline (0 extra GetHistory RPCs!)
        baselineSignatures = new Set(latestMsgs.map(messageSignature));
        if (sawExcludedReply) {
          await sleepInterruptibly(Math.min(350, remaining()), shouldAbort);
          continue;
        }
        lastFailureReason = 'claim_timeout';
        this.botPacer?.noteBotSlow(this.profile.id);
      }

      if (lastFailureReason === 'claim_timeout') {
        this.botPacer?.noteBotSlow(this.profile.id);
      }
      return { ok: false, reason: lastFailureReason, excludedPhonesSeen };
    });
  }

  // CRITICAL: Call BEFORE Toing send_otp so fast 1-2s OTPs are NEVER ignored!
  // Uses warm push cache when available (0 GetHistory RPCs!).
  async captureOtpWatermark(phone) {
    return this._withSlotLock(async () => {
      const ts = Date.now();
      try {
        const recent = await this._getMessagesCachedOrFetchUnlocked({ limit: 8 });
        const tracked = this._pushActive ? [] : await this._fetchTrackedUnlocked(recent);
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

  async _readOtpCandidatesUnlocked(phone, { forceFetch = false } = {}) {
    const cleanPhone = normalizePhone10(phone);
    const recent = await this._getMessagesCachedOrFetchUnlocked({ limit: 8, forceFetch });
    const tracked = forceFetch ? await this._fetchTrackedUnlocked(recent) : [];
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

  // Targeted refresh: prefers clicking REFRESH right on the cached active card (0 GetHistory RPCs!)
  async _refreshOtpChatUnlocked(phone, attempt = 1, shouldAbort = null) {
    const wanted = normalizePhone10(phone);
    const allowed = this.profile.refreshRoles || ['refresh'];

    // VIP fast-lane on shared per-bot pacer: REFRESH jumps ahead of all NEW NUMBER scans!
    if (this.botPacer) {
      const granted = await this.botPacer.acquire(this.profile.id, { priority: 'refresh', shouldAbort });
      if (!granted) return { ok: false, aborted: true };
    }

    const tryClickInMessages = async (messages) => {
      let fallbackEntry = null;
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

        const cardPhone = parseTelegramNumberCard(messageText(message))?.phone || '';
        const matchEntry = entries.find((e) => allowed.includes(e.role));
        if (!matchEntry) continue;

        if (wanted && cardPhone && cardPhone !== wanted) {
          if (!fallbackEntry) fallbackEntry = matchEntry;
          continue;
        }
        const clickRes = await this._safeClickButton(matchEntry, { timeoutMs: 3_500 });
        if (clickRes.clicked) return { ok: true, via: 'click' };
      }
      if (fallbackEntry && attempt >= 2) {
        const clickRes = await this._safeClickButton(fallbackEntry, { timeoutMs: 3_500 });
        if (clickRes.clicked) return { ok: true, via: 'click-fallback' };
      }
      return null;
    };

    try {
      // 1. Try cached/pushed messages first -> ZERO messages.GetHistory RPCs!
      if (this._pushActive && this._pushedMessages.length > 0) {
        const cachedHit = await tryClickInMessages(this._pushedMessages.slice(0, 8));
        if (cachedHit) return cachedHit;
      }

      // 2. Only fetch history if push cache didn't contain a valid refresh button
      const recent = await this._fetchIncomingUnlocked(6);
      const tracked = await this._fetchTrackedUnlocked(recent);
      const fetchedHit = await tryClickInMessages([...tracked, ...recent]);
      if (fetchedHit) return fetchedHit;
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
    timeoutMs = 30_000,
    refreshMs = 2_200,
    shouldAbort = null,
  } = {}) {
    return this._withSlotLock(async () => {
      this.botPacer?.markOtpWaitStart(this.profile.id);
      try {
        const cleanPhone = normalizePhone10(phone);
        const totalMs = Math.max(4_000, Number(timeoutMs) || 30_000);
        const baseRefreshMs = Math.max(900, Number(refreshMs) || 2_200);
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
        // Wait ~1.5s before first REFRESH so Swiggy SMS has a moment to arrive (push catches instant OTPs immediately!)
        let lastRefreshAt = startedAt - Math.floor(baseRefreshMs * 0.3);
        let lastFallbackFetchAt = startedAt;
        let lastEpoch = this._pushEpoch;
        let attempts = 0;
        let lastError = null;
        const fallbackFetchGapMs = this._pushActive ? 6_000 : 700;

        while (Date.now() < deadline) {
          if (shouldAbort?.()) return { ok: false, aborted: true, code: '' };
          const iterStart = Date.now();

          const needFallbackFetch = !this._pushActive || (iterStart - lastFallbackFetchAt >= fallbackFetchGapMs);
          if (needFallbackFetch) lastFallbackFetchAt = iterStart;

          try {
            const candidates = await this._readOtpCandidatesUnlocked(cleanPhone, { forceFetch: needFallbackFetch });
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
              await this._refreshOtpChatUnlocked(cleanPhone, attempts, shouldAbort);
            } catch (err) {
              lastError = err;
              if (/FLOOD_WAIT|PEER_FLOOD|AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|CHAT_WRITE_FORBIDDEN/i.test(String(err?.message || err))) {
                throw err;
              }
            }
          }

          const iterMs = Date.now() - iterStart;
          if (iterMs > 2_000) {
            // Cap refresh cadence at 3.0s so a 30s OTP wait ALWAYS fires 8-12 crisp refreshes (not 3!)
            currentRefreshMs = Math.min(3_000, Math.max(currentRefreshMs, Math.min(iterMs, 3_000)));
          } else if (iterMs < 800 && currentRefreshMs > baseRefreshMs) {
            currentRefreshMs = Math.max(baseRefreshMs, currentRefreshMs - 400);
          }

          // Sleep until either the next REFRESH tick OR an instant MTProto push (NewMessage / EditedMessage)!
          const untilRefresh = Math.max(150, (lastRefreshAt + currentRefreshMs) - Date.now());
          const untilFallback = Math.max(150, (lastFallbackFetchAt + fallbackFetchGapMs) - Date.now());
          const waitMs = Math.min(untilRefresh, untilFallback, Math.max(0, deadline - Date.now()));
          if (this._pushActive) {
            const gotPush = await this._waitForPush(waitMs, shouldAbort, lastEpoch);
            if (gotPush) {
              lastEpoch = this._pushEpoch;
              // Push arrived — postpone safety fallback fetch since push channel is actively delivering!
              lastFallbackFetchAt = Date.now();
            }
          } else {
            await sleepInterruptibly(Math.min(500, waitMs), shouldAbort);
          }
        }

        // One final forced read right at the deadline so an OTP that arrived at the last second isn't missed!
        if (!shouldAbort?.()) {
          try {
            const finalCandidates = await this._readOtpCandidatesUnlocked(cleanPhone, { forceFetch: true });
            const fresh = finalCandidates.filter((c) => candidateIsNew(c, normBaseline));
            const swiggy = fresh.find((c) =>
              /swiggy|swgtns|toing/i.test(c.parsed.sender || '') ||
              /swiggy|swgtns|toing/i.test(messageText(c.message) || '')
            );
            const chosen = swiggy || fresh[0] || null;
            if (chosen) {
              return {
                ok: true,
                code: chosen.parsed.code,
                sender: chosen.parsed.sender || '',
                elapsedMs: Date.now() - startedAt,
              };
            }
          } catch {}
        }

        return {
          ok: false,
          code: '',
          timeout: true,
          attempts,
          elapsedMs: Date.now() - startedAt,
          error: lastError ? String(lastError?.message || lastError).slice(0, 160) : `OTP timeout (${Math.round(totalMs / 1000)}s)`,
        };
      } finally {
        this.botPacer?.markOtpWaitEnd(this.profile.id);
      }
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

export function formatCodeDeliverySummary(info = {}) {
  const type = String(info?.type || 'unknown').toLowerCase();
  const nextType = String(info?.nextType || '').toLowerCase();
  const length = Number(info?.length) || 5;

  let channelLine = '';
  let tipLine = '';

  switch (type) {
    case 'app':
      channelLine = `📲 <b>Telegram App</b> me code bheja gaya hai (<code>${length}-digit</code> — spare account ke <b>"Telegram"</b> official chat me check karo, SMS me nahi!)`;
      tipLine = nextType
        ? `<i>App open nahi hai? Neeche <b>🔄 Resend (${nextType.toUpperCase()})</b> daba sakte ho — ya <b>/addqr</b> se 3 sec me QR scan kar lo.</i>`
        : `<i>Tip: Spare account kisi phone/desktop Telegram me login hona chahiye, ya <b>/addqr</b> use karo.</i>`;
      break;
    case 'sms':
      channelLine = `📩 <b>SMS</b> par code bheja gaya hai (<code>${length}-digit</code>).`;
      tipLine = `<i>⚠️ Agar 30s me SMS na aaye: Telegram custom API ID par aksar SMS block/delay karta hai. Is number ko pehle phone ke official Telegram app me login kar lo (phir code turant app me aayega), ya <b>/addqr</b> se QR scan karo!</i>`;
      break;
    case 'call':
    case 'flashcall':
    case 'missedcall':
      channelLine = `📞 <b>Phone Call</b> par code aa raha hai (<code>${type}</code>).`;
      tipLine = `<i>Call me bole gaye / last digits code ke roop me bhejo.</i>`;
      break;
    case 'fragment':
      channelLine = `💎 <b>Fragment</b> par code bheja gaya hai${info?.url ? ` (${info.url})` : ''}.`;
      tipLine = `<i>Fragment par aaya code paste karo.</i>`;
      break;
    default:
      channelLine = `📩 Code bheja gaya hai (channel: <code>${type}</code>).`;
      tipLine = `<i>Agar code na mile to /cancel karke <b>/addqr</b> try karo.</i>`;
  }

  return { type, nextType, channelLine, tipLine };
}

export function qrLoginUrlFromToken(token) {
  const buf = Buffer.isBuffer(token) ? token : Buffer.from(token || '');
  return `tg://login?token=${buf.toString('base64url')}`;
}

export async function loginInteractiveSession({
  apiId,
  apiHash,
  forceSMS = false,
  callbacks,
  shouldAbort = null,
} = {}) {
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH env me set karo (my.telegram.org).');
  }
  const { TelegramClient, StringSession, Logger } = await loadTeleproto();
  const baseLogger = typeof Logger === 'function' ? new Logger('error') : undefined;
  const client = new TelegramClient(new StringSession(''), Number(apiId), String(apiHash), {
    connectionRetries: 3,
    requestRetries: 2,
    autoReconnect: true,
    receiveUpdates: false,
    ...(baseLogger ? { baseLogger } : {}),
    deviceModel: 'Desktop',
    systemVersion: 'Linux',
    appVersion: '5.10.0',
    langCode: 'en',
    systemLangCode: 'en',
  });
  try { client.setLogLevel?.('error'); } catch {}

  const checkAbort = () => {
    if (shouldAbort?.()) throw new Error('Login cancelled');
  };

  try {
    let phoneUsed = '';
    await client.start({
      // CRITICAL: Default forceSMS=false! Telegram sends instant in-app code
      // (SentCodeTypeApp) when logged into any Telegram app. Previously forceSMS=true
      // called auth.ResendCode immediately, cancelling the App code and requesting
      // SMS which Telegram drops on third-party my.telegram.org API IDs.
      forceSMS: Boolean(forceSMS),
      phoneNumber: async () => {
        checkAbort();
        const raw = await callbacks.phoneNumber();
        checkAbort();
        phoneUsed = normalizeTelegramLoginPhone(raw);
        if (!phoneUsed) throw new Error('Valid phone number daalo (e.g. +919876543210)');
        return phoneUsed;
      },
      phoneCode: async (isCodeViaApp, info) => {
        checkAbort();
        console.log(
          `[TelegramLogin] Code sent for ${phoneUsed}: type=${info?.type || (isCodeViaApp ? 'app' : 'unknown')}`
          + ` nextType=${info?.nextType || 'none'} timeout=${info?.timeout || 0}s`
        );
        const raw = await callbacks.phoneCode(isCodeViaApp, info);
        checkAbort();
        const code = String(raw || '').replace(/[\s-]+/g, '').trim();
        if (!code) throw new Error('OTP code khali hai');
        return code;
      },
      emailVerification: typeof callbacks?.emailVerification === 'function'
        ? async (emailInfo) => {
          checkAbort();
          const raw = await callbacks.emailVerification(emailInfo);
          checkAbort();
          return String(raw || '').trim();
        }
        : undefined,
      password: async (hint) => {
        checkAbort();
        const raw = await callbacks.password(hint);
        checkAbort();
        return String(raw || '');
      },
      onError: async (err) => {
        console.warn('[TelegramLogin] Step error:', String(err?.message || err).slice(0, 180));
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

// ── QR Code Login (for /addqr — ZERO SMS / OTP headaches!) ──────────────────
export async function loginQrSession({ apiId, apiHash, callbacks, abortSignal = null } = {}) {
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH env me set karo (my.telegram.org).');
  }
  const { TelegramClient, StringSession, Logger } = await loadTeleproto();
  const baseLogger = typeof Logger === 'function' ? new Logger('error') : undefined;
  // receiveUpdates MUST be true for QR login so UpdateLoginToken arrives immediately on scan!
  const client = new TelegramClient(new StringSession(''), Number(apiId), String(apiHash), {
    connectionRetries: 3,
    requestRetries: 2,
    autoReconnect: true,
    receiveUpdates: true,
    ...(baseLogger ? { baseLogger } : {}),
    deviceModel: 'Desktop',
    systemVersion: 'Linux',
    appVersion: '5.10.0',
    langCode: 'en',
    systemLangCode: 'en',
  });
  try { client.setLogLevel?.('error'); } catch {}

  try {
    await client.connect();
    await client.signInUserWithQrCode(
      { apiId: Number(apiId), apiHash: String(apiHash) },
      {
        abortSignal: abortSignal || undefined,
        qrCode: async ({ token, expires }) => {
          const url = qrLoginUrlFromToken(token);
          await callbacks.qrCode({ url, token, expires });
        },
        password: async (hint) => {
          const raw = await callbacks.password(hint);
          return String(raw || '');
        },
        onError: async (err) => {
          console.warn('[TelegramQrLogin] Error:', String(err?.message || err).slice(0, 180));
          if (abortSignal?.aborted) return true;
          if (typeof callbacks.onError === 'function') return Boolean(await callbacks.onError(err));
          return false;
        },
      }
    );

    const session = String(client.session?.save?.() || '').trim();
    if (!session) throw new Error('QR login ke baad session khali mili');
    let me = '';
    let phone = '';
    try {
      const user = await client.getMe();
      me = accountMeLabel(user);
      if (user?.phone) phone = `+${String(user.phone).replace(/^\+/, '')}`;
    } catch {}
    return { ok: true, session, me, phone };
  } finally {
    try { await client.disconnect(); } catch {}
    try { await client.destroy?.(); } catch {}
  }
}
