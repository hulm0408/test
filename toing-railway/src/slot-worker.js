// ===== Single Independent Toing Slot Worker =====
// Runs one spare Telegram account in its own completely isolated loop:
//   claim number -> atomic SQLite lock -> parallel (check_mobile + watermark)
//   -> send_otp -> poll OTP -> verify_otp -> export -> atomic DB commit + delivery queue

import { classifyTelegramError } from './telegram-health.js';
import { nextFailoverProfileId } from './otp-profiles.js';
import { TelegramSlotClient } from './telegram-slot-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

export class SlotWorker {
  constructor({
    account,
    db,
    toingClient,
    getRuntimeConfig,
    clientFactory = null,
    onSignupSuccess = null,
    onSlotAlert = null,
  } = {}) {
    this.account = account; // { id, slotNo, label, session, apiId, apiHash, otpBotProfile, ... }
    this.db = db;
    this.toingClient = toingClient;
    this.getRuntimeConfig = getRuntimeConfig;
    this.clientFactory = clientFactory;
    this.onSignupSuccess = onSignupSuccess;
    this.onSlotAlert = onSlotAlert;

    this.client = null;
    this.running = false;
    this.stopRequested = false;
    this._cycleAborted = false;
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
    this.localExcludes = [];
    this.createdInRun = 0;
    this.attemptsInRun = 0;
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
      while (this.localExcludes.length > 40) this.localExcludes.shift();
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

  async _sleepInterruptible(ms) {
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < end) {
      if (this._isAborted()) return;
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  _handleTelegramError(err) {
    const classified = classifyTelegramError(err);
    const now = Date.now();
    this.lastError = `${classified.label}: ${classified.raw}`.slice(0, 200);

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
    const maxFastSkips = 6;

    for (let skip = 0; skip < maxFastSkips; skip++) {
      if (this._isAborted()) return { ok: false, aborted: true };
      this._setStage('claiming', '');

      const claimRes = await this.client.claimFreshNumber({
        forceNew: true,
        excludePhones: excludeSet,
        timeoutMs: cfg.claimTimeoutMs,
        shouldAbort: () => this._isAborted(),
      });

      if (claimRes.aborted || this._isAborted()) return { ok: false, aborted: true };
      if (!claimRes.ok || !claimRes.phone) {
        return { ok: false, reason: claimRes.reason || 'claim_empty' };
      }

      const phone = claimRes.phone;
      const lockRes = this.db.tryClaimPhone(phone, this.account.id, { ttlMs: cfg.claimLockTtlMs });
      if (lockRes.ok) {
        this._rememberExclude(phone);
        return { ok: true, phone, card: claimRes.card };
      }

      // Duplicate / cooldown / already in-flight on another slot -> instant fast-skip!
      excludeSet.add(phone);
      this._rememberExclude(phone);
      this.db.recordMetric(this.account.id, 'duplicate_skip', 0);
    }

    return { ok: false, reason: 'all_claimed_duplicates' };
  }

  async _runSingleCycle() {
    const cfg = this.getRuntimeConfig();
    const cycleStart = Date.now();
    let lockedPhone = '';

    try {
      await this._ensureClientConnected();
      if (this._isAborted()) return;

      // 1. Claim fresh phone + atomic cross-slot SQLite lock
      const claimed = await this._claimLockedPhone(cfg);
      if (claimed.aborted || this._isAborted()) return;

      if (!claimed.ok) {
        this.consecutiveClaimFails += 1;
        this.db.recordMetric(this.account.id, 'claim_fail', Date.now() - cycleStart);

        // Optional OTP bot auto-failover if current bot is empty/stuck
        if (cfg.autoFailoverBots && this.consecutiveClaimFails >= 5) {
          const nextBot = nextFailoverProfileId(this.otpBotProfile);
          console.log(`[Slot #${this.account.slotNo}] Failover OTP bot: ${this.otpBotProfile} -> ${nextBot}`);
          this.consecutiveClaimFails = 0;
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
      this._setStage('sending_otp', lockedPhone);
      this.db.updateClaimStage(lockedPhone, this.account.id, 'sending_otp');

      // 2. CRITICAL SPEED & CONSISTENCY FIX:
      // Run check_mobile + captureOtpWatermark IN PARALLEL *BEFORE* send_otp!
      // Saves 1-2s every signup AND guarantees fast 1s OTPs are NEVER ignored!
      const [checkRes, watermark] = await Promise.all([
        this.toingClient.checkMobile(lockedPhone, { shouldAbort: () => this._isAborted() }),
        this.client.captureOtpWatermark(lockedPhone),
      ]);
      if (this._isAborted()) return;

      const isNew = Boolean(checkRes?.isNew);

      // 3. Send OTP via Toing Pro
      const sendRes = await this.toingClient.sendOtp(lockedPhone, {
        shouldAbort: () => this._isAborted(),
        preferredKey: checkRes?.key || '',
      });
      if (sendRes.aborted || this._isAborted()) return;

      if (!sendRes.ok) {
        this.consecutiveSendFails += 1;
        this.db.incrementAccountAttempt(this.account.id, { failed: true });
        this.db.recordMetric(this.account.id, 'send_otp_fail', Date.now() - cycleStart);
        this.lastError = `send_otp: ${sendRes.reason || 'failed'}`.slice(0, 180);
        this._setStage('backoff', '');
        await this._sleepInterruptible(Math.min(4_000, 600 * this.consecutiveSendFails));
        return;
      }
      this.consecutiveSendFails = 0;

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
        this.db.incrementAccountAttempt(this.account.id, { failed: true });
        this.db.recordMetric(this.account.id, 'otp_timeout', Date.now() - cycleStart);
        this.lastError = `OTP timeout on ${lockedPhone}`;
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
      if (this.client && (action === 'dead' || action === 'cooldown')) {
        try { await this.client.disconnect(); } catch {}
        this.client = null;
      }
      if (action === 'dead') {
        this.stopRequested = true;
      } else if (action === 'cooldown') {
        const waitMs = Math.max(5_000, this.cooldownUntil - Date.now());
        await this._sleepInterruptible(waitMs);
        if (!this.stopRequested) {
          this.healthStatus = 'ready';
          this.cooldownUntil = 0;
          this.db.updateAccountHealth(this.account.id, { healthStatus: 'ready', cooldownUntil: 0, lastError: '' });
        }
      } else {
        await this._sleepInterruptible(2_000);
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
      this._setStage('cooldown', '');
      await this._sleepInterruptible(this.cooldownUntil - Date.now());
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
      const jitter = minJ + Math.floor(Math.random() * (maxJ - minJ + 1));
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
