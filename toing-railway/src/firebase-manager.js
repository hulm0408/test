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
    // Sources whose numbers all timed out stay eligible for a slower re-sweep
    // (a panel can be alive but slow / temporarily behind). This is what stops
    // the run from pinning itself to the same 10 sources forever.
    this._retrySources = [];
    this._retryPhoneNotBefore = new Map();

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
    this._retrySources = [];
    this._retryPhoneNotBefore = new Map();
    this.currentPoolSize = 0;
    this.currentUnseenSize = 0;
  }

  // OTP delivery is the only real proof a panel works. Persist it per source
  // AND per device so the next pass skips both (this survives restarts —
  // the old in-memory streak was lost on every redeploy).
  // A source that produced only timeouts is not "dead" — it may be slow, or its
  // other devices may still deliver. Queue it for the next pass so the rotation
  // keeps widening instead of looping over the same handful of sources.
  _queueSourceRetry(source) {
    if (!source?.id) return;
    if (!this._retrySources.some((s) => s.id === source.id)) {
      this._retrySources.push(source);
    }
  }

  _recordSourceOtpOutcome(source, receivedOtp, { deviceId = '', latencyMs = 0 } = {}) {
    const srcId = source?.id;
    if (!srcId) return;
    try {
      this.db.recordFirebaseOtpResult(srcId, {
        ok: Boolean(receivedOtp),
        sourceKey: source?.url || '',
        deviceId: deviceId || '',
        latencyMs: Number(latencyMs) || 0,
      });
    } catch {}
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
  // Lanes used to block on a single shared refill: when the hot queue ran dry
  // every lane parked until one source scan finished, so a run of 983 sources
  // advanced one scan at a time and lanes sat idle. Now a refill is kicked off
  // in the background as soon as the queue drops below a low-water mark, and a
  // lane that finds nothing waits at most one short slice before re-checking.
  _lowWaterMark() {
    const cfg = this.getRuntimeConfig();
    const lanes = Math.max(1, Math.min(30, Number(cfg.firebaseConcurrency) || 12));
    return Math.max(2, lanes);
  }

  _kickRefill() {
    if (this._refillPromise || this._isAborted()) return this._refillPromise;
    if (this._hotQueue.length >= this._lowWaterMark()) return null;
    this._refillPromise = this._refillHotQueue()
      .catch(() => {})
      .finally(() => {
        this._refillPromise = null;
        if (this._resetAfterRefill) {
          this._resetAfterRefill = false;
          this._resetCoordinator();
        }
        // Immediately top up again if the queue is still starved.
        if (!this._isAborted() && this._hotQueue.length === 0) {
          setTimeout(() => this._kickRefill(), 0);
        }
      });
    return this._refillPromise;
  }

  // A source demoted mid-pass (repeated OTP non-delivery) must stop feeding
  // numbers IMMEDIATELY. Without this the once-per-pass snapshot kept handing
  // out dead sources for hours, which is exactly the loop seen in production.
  _dropQuarantinedSources() {
    const now = Date.now();
    let dropped = 0;
    this._hotQueue = this._hotQueue.filter((c) => {
      const q = Number(c?.source?.otpQuarantinedUntil || 0);
      if (q > now) { dropped += 1; return false; }
      return true;
    });
    if (dropped) this.logger?.info?.(`[Firebase] ⛔ ${dropped} candidate(s) dropped — source OTP deliver nahi kar raha`);
    const deadIds = new Set(
      this._runSources.filter((s) => Number(s?.otpQuarantinedUntil || 0) > now).map((s) => s.id)
    );
    if (deadIds.size) {
      this._retrySources = (this._retrySources || []).filter((s) => !deadIds.has(s.id));
      if (this._currentSource && deadIds.has(this._currentSource.id)) {
        this._currentSource = null;
        this._currentPool = [];
      }
    }
    return dropped;
  }

  async _pullCandidate() {
    this._dropQuarantinedSources();
    if (this._hotQueue.length > 0) {
      this._kickRefill(); // keep the pipeline full behind us
      return this._hotQueue.shift();
    }
    if (this._isAborted()) return null;

    this._kickRefill();
    if (this._refillPromise) {
      // Wait for this refill, but never longer than a short slice: if it is
      // still scanning, the lane re-checks and the next pull may already see
      // candidates produced by the previous scan.
      await Promise.race([
        this._refillPromise,
        this._sleepInterruptible(750),
      ]);
    }
    if (this._hotQueue.length > 0) {
      this._kickRefill();
      return this._hotQueue.shift();
    }
    return null;
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
      // Re-sweep sources that only produced timeouts. Appended AFTER the fresh
      // rotation so healthy panels are still tried first, but the run keeps
      // moving instead of looping over the same narrow set.
      const retryPool = (this._retrySources || []).filter((s) => !freshSources.some((f) => f.id === s.id));
      this._retrySources = [];
      this._runSources = retryPool.length ? [...freshSources, ...retryPool] : freshSources;
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

      // Split device-backed entries vs legacy flat entries.
      // Devices that already failed to deliver an OTP are skipped entirely —
      // without this, one dead panel device blocks the whole source forever
      // (they stay "online" in clients/ but never forward the SMS).
      const deadDevices = this.db.listQuarantinedDevices(this._currentSource);
      const unprobedDeviceEntries = unseen.filter(
        (e) => e.deviceId && !this._probedDevices.has(e.deviceId) && !deadDevices.has(e.deviceId)
      );
      const legacyEntries = unseen.filter((e) => !e.deviceId);
      if (!unprobedDeviceEntries.length && unseen.some((e) => e.deviceId)) {
        // Every device on this source is quarantined for non-delivery.
        this.db.recordFirebaseOtpResult(this._currentSource.id, {
          ok: false,
          sourceKey: this._currentSource.url,
          deviceId: '',
        });
      }

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
        skipDevices: deadDevices,
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
      // Do NOT permanently mark every scanned device as "done": a device with
      // more numbers is re-scanned next pass, so a panel that stayed silent but
      // later starts forwarding still gets used. Only devices we actually have
      // no numbers left for are skipped for the rest of this pass.
      for (const devId of scanRes.probedDeviceIds || []) {
        this._probedDevices.add(devId);
      }

      if (scanRes.fresh && scanRes.fresh.length > 0) {
        // Only queue ONE number per device at a time. A panel either forwards
        // SMS for a device or it doesn't — testing three numbers from the same
        // silent device just burns three 60s waits. The rest of that device's
        // numbers stay unused and are re-read later (it is not marked probed
        // until the device has actually delivered or been quarantined).
        const queuedDevices = new Set();
        let queued = 0;
        let skippedSameDevice = false;
        for (const item of scanRes.fresh) {
          const phone = item?.entry?.phone;
          const devId = item?.entry?.deviceId || '';
          if (!phone || this._sessionQueuedPhones.has(phone)) continue;
          if (devId && queuedDevices.has(devId)) { skippedSameDevice = true; continue; }
          queuedDevices.add(devId);
          this._sessionQueuedPhones.add(phone);
          this._hotQueue.push({
            entry: item.entry,
            source: this._currentSource,
            lastActivityMs: item.lastActivityMs || null,
            onlineFallback: Boolean(item.onlineFallback),
          });
          queued += 1;
        }
        if (queued > 0) return;
        // Everything fresh was from a device we just queued — do NOT burn the
        // source, other devices still have untested numbers.
        if (skippedSameDevice) continue;
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
          await this._sleepInterruptible(400);
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
      // Adaptive budget, from cheapest evidence to strongest:
      //   • this source has delivered before  -> wait best latency + 20s
      //   • this DEVICE has delivered before  -> wait its latency + 20s
      //   • nothing proven yet                -> probe budget (short), and only
      //     a FULL budget once a code actually landed here at least once
      // Rationale: a panel that does not forward SMS never suddenly starts
      // after 60s. Waiting the full 60s on every unknown device is what made
      // the run look like "everything times out" while burning an hour per
      // handful of numbers.
      const baseOtpBudgetMs = Math.max(5_000, Number(cfg.firebaseOtpTimeoutMs) || 60_000);
      const sourceLatencyMs = Number(source?.otpBestLatencyMs) || 0;
      const deviceLatencyMs = entry?.deviceId
        ? Number(this.db.getFirebaseDeviceStat(source, entry.deviceId)?.lastOkLatencyMs) || 0
        : 0;
      const provenLatencyMs = sourceLatencyMs || deviceLatencyMs;
      const probeBudgetMs = Math.max(
        12_000,
        Math.min(baseOtpBudgetMs, Number(cfg.firebaseOtpProbeMs) || 25_000)
      );
      const otpBudgetMs = provenLatencyMs > 0
        ? Math.min(baseOtpBudgetMs, Math.max(probeBudgetMs, provenLatencyMs + 20_000))
        : probeBudgetMs;
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
          this._recordSourceOtpOutcome(source, false, { deviceId: entry?.deviceId || '' });
          this._queueSourceRetry(source);
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
          this._recordSourceOtpOutcome(source, false, { deviceId: entry?.deviceId || '' });
          this._queueSourceRetry(source);
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

        this._recordSourceOtpOutcome(source, true, {
          deviceId: entry?.deviceId || '',
          latencyMs: otpRes.ts ? otpRes.ts - otpStartedAt : Date.now() - otpStartedAt,
        });

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
