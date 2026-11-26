// ===== Single Independent Toing Slot Worker =====
// Runs one spare Telegram account in its own completely isolated loop:
//   claim number -> atomic SQLite lock -> parallel (check_mobile + watermark)
//   -> send_otp -> poll OTP -> verify_otp -> export -> atomic DB commit + delivery queue

import { classifyTelegramError, isConnectionError } from './telegram-health.js';
import { nextFailoverProfileId } from './otp-profiles.js';
import { TelegramSlotClient } from './telegram-slot-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

function formatCooldownLeft(ms = 0) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec >= 86_400) return `${Math.ceil(sec / 86_400)}d left`;
  if (sec >= 3_600) return `${Math.floor(sec / 3_600)}h${Math.floor((sec % 3_600) / 60)}m left`;
  if (sec >= 60) return `${Math.ceil(sec / 60)}m left`;
  return `${sec}s left`;
}

export class SlotWorker {
  constructor({
    account,
    db,
    toingClient,
    getRuntimeConfig,
    clientFactory = null,
    botPacer = null,
    onSignupSuccess = null,
    onSlotAlert = null,
  } = {}) {
    this.account = account; // { id, slotNo, label, session, apiId, apiHash, otpBotProfile, ... }
    this.db = db;
    this.toingClient = toingClient;
    this.getRuntimeConfig = getRuntimeConfig;
    this.clientFactory = clientFactory;
    this.botPacer = botPacer || null;
    this.onSignupSuccess = onSignupSuccess;
    this.onSlotAlert = onSlotAlert;

    this.client = null;
    this.running = false;
    this.stopRequested = false;
    this._cycleAborted = false;
    this._wakeCooldown = false;
    this._loopPromise = null;

    this.stage = 'idle'; // idle|connecting|claiming|sending_otp|waiting_otp|verifying|exporting|cooldown|dead|stopped
    this.stageStartedAt = Date.now();
    this.currentPhone = '';
    this.lastError = account.lastError || '';
    this.cooldownUntil = Number(account.cooldownUntil || 0);
    this.healthStatus = account.healthStatus || 'ready';
    this.otpBotProfile = account.otpBotProfile || 'hathi';
    this.consecutiveClaimFails = 0;
    this.consecutiveSendFails = 0;
    this.consecutivePoolSkips = 0;
    this.localExcludes = [];
    this.createdInRun = 0;
    this.attemptsInRun = 0;
    this._lastCycleWasFastSkip = false;
  }

  _rotateBotIfPoolExhausted(cfg, trigger = 'pool_exhausted') {
    if (!cfg?.autoFailoverBots) return false;
    const threshold = Math.max(3, Number(cfg.poolRotateThreshold) || 12);
    if (this.consecutivePoolSkips < threshold) return false;
    const nextBot = nextFailoverProfileId(this.otpBotProfile);
    if (nextBot === this.otpBotProfile) return false;
    console.log(`[Slot #${this.account.slotNo}] 🔀 Pool rotate OTP bot: ${this.otpBotProfile} -> ${nextBot} (${this.consecutivePoolSkips} consecutive skips, trigger=${trigger})`);
    this.consecutivePoolSkips = 0;
    this.consecutiveClaimFails = 0;
    this.localExcludes = [];
    this.setOtpBotProfile(nextBot);
    this.db.setAccountOtpBot(this.account.id, nextBot);
    return true;
  }

  _logNumberEvent({ phone = '', outcome = 'skip', reason = 'unknown', detail = '', durationMs = 0, logConsole = true } = {}) {
    try {
      this.db.recordNumberEvent?.({
        slotId: this.account.id,
        slotNo: this.account.slotNo,
        phone,
        otpBot: this.otpBotProfile,
        outcome,
        reason,
        detail,
        durationMs,
      });
    } catch {}

    if (!logConsole) return;
    const tag = `[Slot #${this.account.slotNo}]`;
    const p = phone || '-';
    if (outcome === 'skip') {
      console.log(`${tag} ⏭ SKIP ${p} | reason=${reason} | ${detail}`);
    } else if (outcome === 'drop') {
      console.warn(`${tag} ❌ DROP ${p} | reason=${reason} | ${detail}`);
    } else if (outcome === 'claim_fail') {
      console.warn(`${tag} ⚠️ CLAIM_FAIL | bot=${this.otpBotProfile} | reason=${reason} | ${detail}`);
    }
  }

  _setStage(stage, phone = undefined) {
    this.stage = stage;
    this.stageStartedAt = Date.now();
    if (phone !== undefined) this.currentPhone = phone;
  }

  _rememberExclude(phone) {
    if (!phone) return;
    if (!this.localExcludes.includes(phone)) {
      this.localExcludes.push(phone);
      while (this.localExcludes.length > 120) this.localExcludes.shift();
    }
  }

  clearLocalExcludes() {
    this.localExcludes = [];
    this.consecutivePoolSkips = 0;
  }

  wakeFromCooldown() {
    if (this.healthStatus === 'cooldown' || this.stage === 'cooldown') {
      this._wakeCooldown = true;
      this.healthStatus = 'ready';
      this.cooldownUntil = 0;
      this.lastError = '';
    }
  }

  _isAborted() {
    return this.stopRequested || this._cycleAborted;
  }

  _createClient() {
    const cfg = this.getRuntimeConfig();
    const apiId = this.account.apiId || cfg.telegramApiId;
    const apiHash = this.account.apiHash || cfg.telegramApiHash;
    const opts = {
      slotId: this.account.id,
      slotNo: this.account.slotNo,
      label: this.account.label,
      session: this.account.session,
      apiId,
      apiHash,
      otpBotProfile: this.otpBotProfile,
      botPacer: this.botPacer,
    };
    if (typeof this.clientFactory === 'function') {
      return this.clientFactory(opts);
    }
    return new TelegramSlotClient(opts);
  }

  setOtpBotProfile(profileId) {
    this.otpBotProfile = profileId;
    if (this.client?.setBotProfile) {
      this.client.setBotProfile(profileId);
    }
  }

  start() {
    if (this.running) return;
    if (this.healthStatus === 'dead') {
      this._setStage('dead', '');
      return;
    }
    this.running = true;
    this.stopRequested = false;
    this._cycleAborted = false;
    this._loopPromise = this._runLoop().finally(() => {
      this.running = false;
      if (this.healthStatus !== 'dead' && this.healthStatus !== 'cooldown') {
        this._setStage('stopped', '');
      }
    });
  }

  async stop({ gracefulMs = 20_000 } = {}) {
    this.stopRequested = true;
    // Allow an in-flight verify/export to finish cleanly, otherwise abort right away
    if (this._loopPromise) {
      const waitMs = (this.stage === 'verifying' || this.stage === 'exporting')
        ? Math.min(gracefulMs, 15_000)
        : Math.min(gracefulMs, 3_000);
      await Promise.race([
        this._loopPromise.catch(() => {}),
        sleep(waitMs),
      ]);
    }
    if (this.currentPhone) {
      this.db.releaseClaim(this.currentPhone, this.account.id);
      this.currentPhone = '';
    }
    if (this.client) {
      try { await this.client.disconnect(); } catch {}
      this.client = null;
    }
    this.running = false;
    if (this.healthStatus !== 'dead') {
      this._setStage('stopped', '');
    }
  }

  // Called by SlotManager watchdog if a socket hangs silently beyond slotStuckTimeoutMs
  async forceRecover(reason = 'watchdog_stuck') {
    if (!this.running) return;
    console.warn(`[Slot #${this.account.slotNo}] Watchdog recovery triggered (${reason}, stage=${this.stage})`);
    this._cycleAborted = true;
    if (this.currentPhone) {
      this.db.releaseClaim(this.currentPhone, this.account.id);
      this.currentPhone = '';
    }
    const oldClient = this.client;
    this.client = null;
    if (oldClient) {
      try { await oldClient.disconnect(); } catch {}
    }
  }

  async _sleepInterruptible(ms, { wakeOnCooldownReset = false } = {}) {
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < end) {
      if (this._isAborted()) return;
      if (wakeOnCooldownReset && this._wakeCooldown) {
        this._wakeCooldown = false;
        return;
      }
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  _handleTelegramError(err) {
    const classified = classifyTelegramError(err);
    const now = Date.now();
    this.lastError = `${classified.label}: ${classified.raw}`.slice(0, 200);
    console.warn(`[Slot #${this.account.slotNo}] ⚠️ TG_ERROR | code=${classified.code} | kind=${classified.kind} | ${classified.raw}`);

    if (classified.fatal || classified.healthStatus === 'dead') {
      this.healthStatus = 'dead';
      this.cooldownUntil = now + classified.cooldownMs;
      this.db.updateAccountHealth(this.account.id, {
        healthStatus: 'dead',
        cooldownUntil: this.cooldownUntil,
        lastError: this.lastError,
      });
      this._setStage('dead', '');
      this.onSlotAlert?.({
        slotNo: this.account.slotNo,
        label: this.account.label,
        severity: 'dead',
        code: classified.code,
        message: this.lastError,
      });
      return 'dead';
    }

    if (classified.cooldownMs > 0) {
      this.healthStatus = 'cooldown';
      this.cooldownUntil = now + classified.cooldownMs;
      this.db.updateAccountHealth(this.account.id, {
        healthStatus: 'cooldown',
        cooldownUntil: this.cooldownUntil,
        lastError: this.lastError,
      });
      this._setStage('cooldown', '');
      if (classified.kind === 'peer-flood' || classified.kind === 'blocked') {
        this.onSlotAlert?.({
          slotNo: this.account.slotNo,
          label: this.account.label,
          severity: 'cooldown',
          code: classified.code,
          message: this.lastError,
        });
      }
      return 'cooldown';
    }

    this.db.updateAccountHealth(this.account.id, {
      healthStatus: 'ready',
      cooldownUntil: 0,
      lastError: this.lastError,
    });
    return 'retry';
  }

  async _ensureClientConnected() {
    if (this.client?.connected) return this.client;
    this._setStage('connecting', '');
    if (!this.client) {
      this.client = this._createClient();
    }
    const info = await this.client.connect();
    this.healthStatus = 'ready';
    this.cooldownUntil = 0;
    this.lastError = '';
    this.db.updateAccountHealth(this.account.id, {
      healthStatus: 'ready',
      cooldownUntil: 0,
      lastError: '',
      tgUserLabel: info?.me || '',
    });
    return this.client;
  }

  async _claimLockedPhone(cfg) {
    const excludeSet = new Set(this.localExcludes);
    const maxFastSkips = 14;
    const ignoreAlreadyRegistered = cfg.skipRegistered === false;

    for (let skip = 0; skip < maxFastSkips; skip++) {
      if (this._isAborted()) return { ok: false, aborted: true };
      if (skip > 0) {
        // Gentle spacing between rapid NEW NUMBER clicks so OTP bot callback queue never stalls
        await this._sleepInterruptible(300);
        if (this._isAborted()) return { ok: false, aborted: true };
      }
      this._setStage('claiming', '');

      // On first attempt (skip === 0), pass forceNew=false so an untouched fresh card
      // ALREADY sitting on screen is used immediately (0 wasted numbers!).
      // Once we skip a card, forceNew=true requests a new number from the OTP bot.
      const claimRes = await this.client.claimFreshNumber({
        forceNew: skip > 0,
        excludePhones: excludeSet,
        timeoutMs: cfg.claimTimeoutMs,
        shouldAbort: () => this._isAborted(),
      });

      if (Array.isArray(claimRes?.excludedPhonesSeen)) {
        for (const dupPhone of claimRes.excludedPhonesSeen) {
          this.consecutivePoolSkips += 1;
          this._logNumberEvent({
            phone: dupPhone,
            outcome: 'skip',
            reason: 'bot_duplicate',
            detail: 'OTP bot ne wahi number dobara diya jo ye slot pehle dekh chuka hai',
          });
        }
      }

      if (claimRes.aborted || this._isAborted()) return { ok: false, aborted: true };
      if (!claimRes.ok || !claimRes.phone) {
        if (this._rotateBotIfPoolExhausted(cfg, claimRes.reason || 'claim_empty')) {
          return { ok: false, rotated: true, reason: 'pool_rotated' };
        }
        if (claimRes.reason === 'bot_returned_excluded') {
          // Bot IS replying normally; it simply returned already-seen numbers — do NOT sleep 5s as CLAIM_FAIL!
          return { ok: false, poolDuplicate: true, reason: 'bot_returned_excluded' };
        }
        return { ok: false, reason: claimRes.reason || 'claim_empty' };
      }

      const phone = claimRes.phone;
      const lockRes = this.db.tryClaimPhone(phone, this.account.id, {
        ttlMs: cfg.claimLockTtlMs,
        ignoreAlreadyRegistered,
      });
      if (lockRes.ok) {
        this._rememberExclude(phone);
        return { ok: true, phone, card: claimRes.card, reusedOnScreen: Boolean(claimRes.reusedOnScreen) };
      }

      // Duplicate / cooldown / already in-flight on another slot -> explicit reason log + fast-skip!
      excludeSet.add(phone);
      this._rememberExclude(phone);
      this.consecutivePoolSkips += 1;
      this.db.recordMetric(this.account.id, 'duplicate_skip', 0);

      if (lockRes.reason === 'cooldown') {
        const sub = lockRes.status || 'used';
        const leftStr = lockRes.remainingMs > 0 ? formatCooldownLeft(lockRes.remainingMs) : 'cooldown active';
        this._logNumberEvent({
          phone,
          outcome: 'skip',
          reason: 'used_cooldown',
          detail: `pehle ${sub} list me hai (${leftStr}) — OTP nahi bheja`,
        });
      } else if (lockRes.reason === 'in_flight') {
        this._logNumberEvent({
          phone,
          outcome: 'skip',
          reason: 'in_flight',
          detail: `doosra slot (id=${lockRes.bySlot}) abhi process kar raha hai — OTP nahi bheja`,
        });
      } else {
        this._logNumberEvent({
          phone,
          outcome: 'skip',
          reason: lockRes.reason || 'claim_rejected',
          detail: 'SQLite claim guard ne reject kiya — OTP nahi bheja',
        });
      }

      if (this._rotateBotIfPoolExhausted(cfg, lockRes.reason || 'duplicate_skip')) {
        return { ok: false, rotated: true, reason: 'pool_rotated' };
      }
    }

    return { ok: false, poolDuplicate: true, reason: 'all_claimed_duplicates' };
  }

  async _runSingleCycle() {
    const cfg = this.getRuntimeConfig();
    const cycleStart = Date.now();
    let lockedPhone = '';
    this._lastCycleWasFastSkip = false;

    try {
      await this._ensureClientConnected();
      if (this._isAborted()) return;

      // 1. Claim fresh phone + atomic cross-slot SQLite lock
      const claimed = await this._claimLockedPhone(cfg);
      if (claimed.aborted || this._isAborted()) return;

      if (claimed.rotated) {
        this._lastCycleWasFastSkip = true;
        return;
      }

      if (claimed.poolDuplicate) {
        // Single-bot pool scan hit repeated used/excluded numbers while bot IS responsive:
        // do NOT count as a broken-bot CLAIM_FAIL and do NOT stack 5s backoff sleep!
        this.consecutiveClaimFails = 0;
        this._lastCycleWasFastSkip = true;
        return;
      }

      if (!claimed.ok) {
        this.consecutiveClaimFails += 1;
        this.db.recordMetric(this.account.id, 'claim_fail', Date.now() - cycleStart);
        this._logNumberEvent({
          phone: '',
          outcome: 'claim_fail',
          reason: claimed.reason || 'claim_empty',
          detail: `consecutive_fails=${this.consecutiveClaimFails}`,
          durationMs: Date.now() - cycleStart,
        });

        // Optional OTP bot auto-failover if current bot is empty/stuck
        if (cfg.autoFailoverBots && this.consecutiveClaimFails >= 4) {
          const nextBot = nextFailoverProfileId(this.otpBotProfile);
          console.log(`[Slot #${this.account.slotNo}] Failover OTP bot: ${this.otpBotProfile} -> ${nextBot}`);
          this.consecutiveClaimFails = 0;
          this.consecutivePoolSkips = 0;
          this.localExcludes = [];
          this.setOtpBotProfile(nextBot);
          this.db.setAccountOtpBot(this.account.id, nextBot);
        }
        this._setStage('backoff', '');
        const baseBackoff = Number(cfg.claimFailBackoffMs ?? 1_200);
        await this._sleepInterruptible(Math.min(5_000, baseBackoff * this.consecutiveClaimFails));
        return;
      }

      this.consecutiveClaimFails = 0;
      lockedPhone = claimed.phone;
      this.attemptsInRun += 1;

      // 2. CHECK REGISTRATION STATUS *FIRST* (before watermark RPC & BEFORE send_otp!)
      // Already-registered numbers are skipped in ~200ms with ZERO OTPs sent & ZERO wasted TG RPCs!
      this._setStage('checking', lockedPhone);
      this.db.updateClaimStage(lockedPhone, this.account.id, 'checking');

      const checkRes = await this.toingClient.checkMobile(lockedPhone, {
        shouldAbort: () => this._isAborted(),
      });
      if (checkRes?.aborted || this._isAborted()) return;

      const skipRegistered = cfg.skipRegistered !== false;
      if (skipRegistered) {
        if (!checkRes?.ok) {
          this.db.recordMetric(this.account.id, 'check_mobile_fail', Date.now() - cycleStart);
          this.lastError = `check_mobile: ${checkRes?.error || 'failed'}`.slice(0, 180);
          this._logNumberEvent({
            phone: lockedPhone,
            outcome: 'skip',
            reason: 'check_mobile_failed',
            detail: `${checkRes?.error || 'unknown status'} — safe skip (OTP nahi bheja)`,
            durationMs: Date.now() - cycleStart,
          });
          this._setStage('backoff', '');
          await this._sleepInterruptible(500);
          return;
        }

        if (checkRes.registered === true) {
          const skippedPhone = lockedPhone;
          this.consecutivePoolSkips += 1;
          this.db.markNumberUsed(skippedPhone, {
            status: 'already_registered',
            slotId: this.account.id,
            cooldownDays: cfg.usedCooldownDays,
            source: 'toing_check',
          });
          lockedPhone = ''; // claim already released inside markNumberUsed TX
          this.db.recordMetric(this.account.id, 'already_registered_skip', Date.now() - cycleStart);
          this._logNumberEvent({
            phone: skippedPhone,
            outcome: 'skip',
            reason: 'already_registered',
            detail: checkRes.message || 'Already Registered on Toing — turant skip (OTP nahi bheja)',
            durationMs: Date.now() - cycleStart,
          });
          this._rotateBotIfPoolExhausted(cfg, 'already_registered');
          this._lastCycleWasFastSkip = true;
          return;
        }
      }

      const isNew = Boolean(checkRes?.isNew);

      // 3. Number is verified FRESH (or skipRegistered=false) -> capture OTP watermark BEFORE send_otp!
      this._setStage('sending_otp', lockedPhone);
      this.db.updateClaimStage(lockedPhone, this.account.id, 'sending_otp');

      const watermark = await this.client.captureOtpWatermark(lockedPhone);
      if (this._isAborted()) return;

      console.log(`[Slot #${this.account.slotNo}] 📨 SEND_OTP ${lockedPhone} | ${isNew ? 'FRESH ✅' : 'EXISTING'} | bot=${this.otpBotProfile}${claimed.reusedOnScreen ? ' (on-screen)' : ''}`);

      const sendRes = await this.toingClient.sendOtp(lockedPhone, {
        shouldAbort: () => this._isAborted(),
        preferredKey: checkRes?.key || '',
      });
      if (sendRes.aborted || this._isAborted()) return;

      if (!sendRes.ok) {
        if (sendRes.alreadyRegistered) {
          const skippedPhone = lockedPhone;
          this.consecutivePoolSkips += 1;
          this.db.markNumberUsed(skippedPhone, {
            status: 'already_registered',
            slotId: this.account.id,
            cooldownDays: cfg.usedCooldownDays,
            source: 'toing_send_otp',
          });
          lockedPhone = '';
          this.db.recordMetric(this.account.id, 'already_registered_skip', Date.now() - cycleStart);
          this._logNumberEvent({
            phone: skippedPhone,
            outcome: 'skip',
            reason: 'already_registered',
            detail: sendRes.reason || 'Already Registered (send_otp response)',
            durationMs: Date.now() - cycleStart,
          });
          this._rotateBotIfPoolExhausted(cfg, 'already_registered_send_otp');
          this._lastCycleWasFastSkip = true;
          return;
        }

        // Persist phone-specific Swiggy/Toing OTP blocks so NO other slot retries this number!
        if (Number(sendRes.retryCooldownMs) > 0) {
          const blockedPhone = lockedPhone;
          const coolMin = Math.max(1, Math.round(sendRes.retryCooldownMs / 60_000));
          this.consecutivePoolSkips += 1;
          this.db.markNumberUsed(blockedPhone, {
            status: 'send_otp_blocked',
            slotId: this.account.id,
            cooldownMs: sendRes.retryCooldownMs,
            source: 'swiggy_block',
          });
          lockedPhone = ''; // already released inside markNumberUsed TX
          this.db.incrementAccountAttempt(this.account.id, { failed: true });
          this.db.recordMetric(this.account.id, 'send_otp_fail', Date.now() - cycleStart);
          this.lastError = `send_otp_blocked: ${sendRes.reason || 'blocked'}`.slice(0, 180);
          this._logNumberEvent({
            phone: blockedPhone,
            outcome: 'drop',
            reason: 'send_otp_blocked',
            detail: `${sendRes.reason || 'Swiggy blocking OTPs'} (${coolMin}m cooldown set — doosra slot retry nahi karega)`,
            durationMs: Date.now() - cycleStart,
          });
          this._rotateBotIfPoolExhausted(cfg, 'send_otp_blocked');
          this._lastCycleWasFastSkip = true;
          return;
        }

        this.consecutiveSendFails += 1;
        this.db.incrementAccountAttempt(this.account.id, { failed: true });
        this.db.recordMetric(this.account.id, 'send_otp_fail', Date.now() - cycleStart);
        this.lastError = `send_otp: ${sendRes.reason || 'failed'}`.slice(0, 180);
        this._logNumberEvent({
          phone: lockedPhone,
          outcome: 'drop',
          reason: 'send_otp_failed',
          detail: `${sendRes.reason || 'Toing send_otp failed'}${sendRes.status ? ` (HTTP ${sendRes.status})` : ''}`,
          durationMs: Date.now() - cycleStart,
        });
        this._setStage('backoff', '');
        await this._sleepInterruptible(Math.min(4_000, 600 * this.consecutiveSendFails));
        return;
      }
      this.consecutiveSendFails = 0;
      this.consecutivePoolSkips = 0;

      // 4. Poll OTP from THIS slot's Telegram OTP bot (fast-fail budget default 20s)
      this._setStage('waiting_otp', lockedPhone);
      this.db.updateClaimStage(lockedPhone, this.account.id, 'waiting_otp');

      const otpRes = await this.client.waitForOtp(lockedPhone, {
        baseline: watermark,
        timeoutMs: cfg.otpTimeoutMs,
        refreshMs: cfg.otpRefreshMs,
        shouldAbort: () => this._isAborted(),
      });
      if (otpRes.aborted || this._isAborted()) return;

      if (!otpRes.ok || !/^\d{6}$/.test(String(otpRes.code || ''))) {
        const timedOutPhone = lockedPhone;
        this.db.incrementAccountAttempt(this.account.id, { failed: true });
        this.db.recordMetric(this.account.id, 'otp_timeout', Date.now() - cycleStart);
        this.lastError = `OTP timeout on ${timedOutPhone}`;
        const elapsedSec = ((otpRes.elapsedMs || cfg.otpTimeoutMs) / 1000).toFixed(1);
        const coolMin = Number(cfg.otpTimeoutCooldownMin ?? 10);
        if (coolMin > 0) {
          this.db.markNumberUsed(timedOutPhone, {
            status: 'otp_timeout_cool',
            slotId: this.account.id,
            cooldownMs: coolMin * 60_000,
            source: 'otp_timeout',
          });
          lockedPhone = '';
        }
        this._logNumberEvent({
          phone: timedOutPhone,
          outcome: 'drop',
          reason: 'otp_timeout',
          detail: `${elapsedSec}s me koi OTP nahi aaya (${otpRes.attempts || 0} refreshes, bot=${this.otpBotProfile}${coolMin > 0 ? `, ${coolMin}m cool` : ''})`,
          durationMs: Date.now() - cycleStart,
        });
        return;
      }

      // 5. Verify OTP on Toing Pro (stick to same x-user-key as send_otp!)
      this._setStage('verifying', lockedPhone);
      this.db.updateClaimStage(lockedPhone, this.account.id, 'verifying');

      const verifyRes = await this.toingClient.verifyOtp({
        mobile: lockedPhone,
        otp: otpRes.code,
        sid: sendRes.sid,
        tid: sendRes.tid,
        deviceId: sendRes.deviceId,
        isNew,
      }, {
        shouldAbort: () => this._isAborted(),
        preferredKey: sendRes.key || '',
      });
      if (verifyRes.aborted || this._isAborted()) return;

      if (!verifyRes.ok) {
        this.db.incrementAccountAttempt(this.account.id, { failed: true });
        this.db.recordMetric(this.account.id, 'verify_fail', Date.now() - cycleStart);
        this.lastError = `verify_otp: ${verifyRes.reason || 'failed'}`.slice(0, 180);
        this._logNumberEvent({
          phone: lockedPhone,
          outcome: 'drop',
          reason: 'verify_failed',
          detail: `OTP ${otpRes.code} rejected: ${verifyRes.reason || 'verify_otp failed'}`,
          durationMs: Date.now() - cycleStart,
        });
        return;
      }

      // 6. Export clean session JSON (3x automatic retry so verified account is NEVER lost)
      this._setStage('exporting', lockedPhone);
      this.db.updateClaimStage(lockedPhone, this.account.id, 'exporting');

      const exportRes = await this.toingClient.exportAccount(lockedPhone, {
        otpState: sendRes,
        preferredKey: sendRes.key || '',
      });

      const durationMs = Date.now() - cycleStart;

      // 7. Single atomic SQLite commit: saves session + 30d cooldown + delivery_queue + metrics
      const committed = this.db.commitCompletedSignup({
        phone: lockedPhone,
        slotId: this.account.id,
        otpBot: this.otpBotProfile,
        isNew,
        exportObj: exportRes.exportObj,
        fileName: `toing-${lockedPhone}.json`,
        deliveryChatId: cfg.deliveryChatId || cfg.primaryOwnerId,
        cooldownDays: cfg.usedCooldownDays,
        durationMs,
      });

      lockedPhone = ''; // already released inside commitCompletedSignup TX
      this.createdInRun += 1;
      this.lastError = '';
      this._logNumberEvent({
        phone: committed.exportObj.mobile,
        outcome: 'ok',
        reason: isNew ? 'created_new' : 'created_existing',
        detail: `${isNew ? 'NEW' : 'EXISTING'} created & queued in ${(durationMs / 1000).toFixed(1)}s`,
        durationMs,
        logConsole: false,
      });
      this.onSignupSuccess?.({
        slotNo: this.account.slotNo,
        phone: committed.exportObj.mobile,
        isNew,
        durationMs,
        sessionId: committed.sessionId,
      });
    } catch (err) {
      if (this._isAborted()) return;
      const action = this._handleTelegramError(err);
      // Only destroy & recreate TelegramClient on dead sessions or real connection errors —
      // NEVER tear down a healthy MTProto socket on FLOOD_WAIT or non-fatal bot UI errors!
      if (this.client && (action === 'dead' || isConnectionError(err))) {
        try { await this.client.disconnect(); } catch {}
        this.client = null;
      }
      if (action === 'dead') {
        this.stopRequested = true;
      } else if (action === 'cooldown') {
        this._wakeCooldown = false;
        const waitMs = Math.max(2_000, this.cooldownUntil - Date.now());
        await this._sleepInterruptible(waitMs, { wakeOnCooldownReset: true });
        if (!this.stopRequested) {
          this.healthStatus = 'ready';
          this.cooldownUntil = 0;
          this.db.updateAccountHealth(this.account.id, { healthStatus: 'ready', cooldownUntil: 0, lastError: '' });
        }
      } else {
        await this._sleepInterruptible(1_500);
      }
    } finally {
      if (lockedPhone) {
        this.db.releaseClaim(lockedPhone, this.account.id);
      }
      this.currentPhone = '';
    }
  }

  async _runLoop() {
    // Respect existing persisted cooldown on startup
    if (this.healthStatus === 'cooldown' && this.cooldownUntil > Date.now()) {
      this._wakeCooldown = false;
      this._setStage('cooldown', '');
      await this._sleepInterruptible(this.cooldownUntil - Date.now(), { wakeOnCooldownReset: true });
      if (this.stopRequested) return;
      this.healthStatus = 'ready';
      this.cooldownUntil = 0;
      this.db.updateAccountHealth(this.account.id, { healthStatus: 'ready', cooldownUntil: 0 });
    }

    while (!this.stopRequested && this.healthStatus !== 'dead') {
      this._cycleAborted = false;
      await this._runSingleCycle();
      if (this.stopRequested || this.healthStatus === 'dead') break;

      // Tiny randomized jitter keeps 50 slots desynchronized (smoother throughput, fewer 429 bursts)
      this._setStage('idle', '');
      const cfg = this.getRuntimeConfig();
      const minJ = Math.max(0, Number(cfg.slotJitterMinMs) || 200);
      const maxJ = Math.max(minJ, Number(cfg.slotJitterMaxMs) || 800);
      const jitter = this._lastCycleWasFastSkip
        ? Math.min(350, minJ)
        : (minJ + Math.floor(Math.random() * (maxJ - minJ + 1)));
      if (jitter > 0) await this._sleepInterruptible(jitter);
    }
  }

  getStatusSnapshot(now = Date.now()) {
    return {
      id: this.account.id,
      slotNo: this.account.slotNo,
      label: this.account.label,
      otpBot: this.otpBotProfile,
      running: this.running,
      stage: this.stage,
      stageAgeSec: Math.round(Math.max(0, now - this.stageStartedAt) / 1000),
      currentPhone: this.currentPhone,
      healthStatus: this.healthStatus,
      cooldownLeftSec: this.cooldownUntil > now ? Math.ceil((this.cooldownUntil - now) / 1000) : 0,
      lastError: this.lastError,
      createdInRun: this.createdInRun,
      attemptsInRun: this.attemptsInRun,
    };
  }
}
