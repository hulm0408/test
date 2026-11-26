// ===== 50-Slot Parallel Orchestrator + Watchdog + Graceful Drain =====
// Manages up to 50 independent SlotWorker instances concurrently:
//   - Staggered startup (bootBatchSize slots every bootBatchDelayMs)
//   - 10s Watchdog: detects hung sockets, recovers stuck slots, cleans expired claims
//   - Live account add/remove/bot-switch without disrupting other running slots

import { SlotWorker } from './slot-worker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

export class SlotManager {
  constructor({
    db,
    toingClient,
    getRuntimeConfig,
    clientFactory = null,
    onSignupSuccess = null,
    onSlotAlert = null,
  } = {}) {
    this.db = db;
    this.toingClient = toingClient;
    this.getRuntimeConfig = getRuntimeConfig;
    this.clientFactory = clientFactory;
    this.onSignupSuccess = onSignupSuccess;
    this.onSlotAlert = onSlotAlert;

    this.workers = new Map(); // accountId -> SlotWorker
    this.desiredRunning = false;
    this._watchdogTimer = null;
    this._startingAll = false;
  }

  _startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => {
      this._watchdogTick().catch((err) => {
        console.warn('[SlotManager] Watchdog tick error:', err?.message || err);
      });
    }, 10_000);
    if (typeof this._watchdogTimer.unref === 'function') this._watchdogTimer.unref();
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  async _watchdogTick() {
    const cfg = this.getRuntimeConfig();
    const now = Date.now();
    this.db.cleanExpiredClaims(now);

    // Prune metrics older than 24h occasionally
    if (Math.random() < 0.05) {
      try { this.db.pruneOldMetrics(); } catch {}
    }

    const activeStages = new Set(['connecting', 'claiming', 'checking', 'sending_otp', 'waiting_otp', 'verifying', 'exporting']);
    for (const worker of this.workers.values()) {
      if (!worker.running) continue;
      if (!activeStages.has(worker.stage)) continue;
      const ageMs = now - worker.stageStartedAt;
      if (ageMs > cfg.slotStuckTimeoutMs) {
        await worker.forceRecover(`stuck_${worker.stage}_${Math.round(ageMs / 1000)}s`);
      }
    }
  }

  async startAll() {
    if (this._startingAll) return { started: 0, alreadyStarting: true };
    this._startingAll = true;
    this.desiredRunning = true;
    this.db.setSetting('running', true);
    this._startWatchdog();

    try {
      const cfg = this.getRuntimeConfig();
      const accounts = this.db.listAccounts({ includeSession: true, onlyEnabled: true })
        .slice(0, cfg.maxSlots);

      let started = 0;
      let skippedDead = 0;
      const batchSize = Math.max(1, cfg.bootBatchSize || 5);
      const batchDelayMs = Math.max(0, cfg.bootBatchDelayMs || 1_500);

      for (let i = 0; i < accounts.length; i++) {
        if (!this.desiredRunning) break;
        const acc = accounts[i];
        if (acc.decryptError || !acc.session) continue;

        let worker = this.workers.get(acc.id);
        if (worker?.running) continue;

        if (acc.healthStatus === 'dead') {
          skippedDead += 1;
          continue;
        }

        worker = new SlotWorker({
          account: acc,
          db: this.db,
          toingClient: this.toingClient,
          getRuntimeConfig: this.getRuntimeConfig,
          clientFactory: this.clientFactory,
          onSignupSuccess: this.onSignupSuccess,
          onSlotAlert: this.onSlotAlert,
        });
        this.workers.set(acc.id, worker);
        worker.start();
        started += 1;

        // Stagger MTProto handshakes so 50 sockets connect smoothly without CPU/network spike
        if (started % batchSize === 0 && i + 1 < accounts.length && batchDelayMs > 0) {
          await sleep(batchDelayMs);
        }
      }

      return { started, totalEnabled: accounts.length, skippedDead };
    } finally {
      this._startingAll = false;
    }
  }

  async stopAll({ gracefulMs = 20_000, persistStopped = true } = {}) {
    this.desiredRunning = false;
    if (persistStopped) {
      this.db.setSetting('running', false);
    }
    this._stopWatchdog();

    const stops = [];
    for (const worker of this.workers.values()) {
      stops.push(worker.stop({ gracefulMs }).catch(() => {}));
    }
    await Promise.all(stops);
    this.workers.clear();
    this.db.clearAllActiveClaims();
    return { stopped: stops.length };
  }

  async startSlot(accountId) {
    const acc = this.db.getAccountById(accountId, { includeSession: true });
    if (!acc) return { ok: false, reason: 'not_found' };
    if (!acc.session) return { ok: false, reason: acc.decryptError || 'empty_session' };

    this.db.setAccountEnabled(acc.id, true);
    if (acc.healthStatus === 'dead' || acc.healthStatus === 'cooldown') {
      this.db.resetAccountHealth(acc.id);
      acc.healthStatus = 'ready';
      acc.cooldownUntil = 0;
    }

    const existing = this.workers.get(acc.id);
    if (existing?.running) return { ok: true, alreadyRunning: true, slotNo: acc.slotNo };

    this._startWatchdog();
    const worker = new SlotWorker({
      account: acc,
      db: this.db,
      toingClient: this.toingClient,
      getRuntimeConfig: this.getRuntimeConfig,
      clientFactory: this.clientFactory,
      onSignupSuccess: this.onSignupSuccess,
      onSlotAlert: this.onSlotAlert,
    });
    this.workers.set(acc.id, worker);
    worker.start();
    return { ok: true, slotNo: acc.slotNo };
  }

  async stopSlot(accountId, { disable = false } = {}) {
    if (disable) {
      this.db.setAccountEnabled(accountId, false);
    }
    const worker = this.workers.get(Number(accountId));
    if (worker) {
      await worker.stop({ gracefulMs: 10_000 });
      this.workers.delete(Number(accountId));
    }
    return { ok: true };
  }

  setSlotOtpBot(accountId, profileId) {
    const clean = this.db.setAccountOtpBot(accountId, profileId);
    const worker = this.workers.get(Number(accountId));
    if (worker) worker.setOtpBotProfile(clean);
    return clean;
  }

  setAllSlotsOtpBot(profileId) {
    const res = this.db.setAllAccountsOtpBot(profileId);
    for (const worker of this.workers.values()) {
      worker.setOtpBotProfile(res.profile);
    }
    return res;
  }

  spreadSlotsAcrossBots(profileIds = ['hathi', 'hermes', 'chauhan']) {
    const res = this.db.spreadAccountsAcrossBots(profileIds);
    for (const item of res.assignments) {
      const worker = this.workers.get(item.id);
      if (worker) worker.setOtpBotProfile(item.profile);
    }
    return res;
  }

  clearAllLocalExcludes() {
    for (const worker of this.workers.values()) {
      worker.clearLocalExcludes?.();
    }
  }

  wakeCooldownSlots() {
    for (const worker of this.workers.values()) {
      worker.wakeFromCooldown?.();
    }
  }

  async removeSlot(accountId) {
    await this.stopSlot(accountId, { disable: false });
    return this.db.deleteAccount(accountId);
  }

  async startNewEnabledSlots() {
    if (!this.desiredRunning) return { started: 0 };
    return this.startAll();
  }

  getDashboardSnapshot(now = Date.now()) {
    const accounts = this.db.listAccounts({ includeSession: false });
    const throughput = this.db.getThroughputStats(now);
    const delivery = this.db.getDeliveryStats();
    const toing = this.toingClient.getStats();

    const stages = {};
    let runningCount = 0;
    let readyCount = 0;
    let cooldownCount = 0;
    let deadCount = 0;
    let disabledCount = 0;

    const slots = accounts.map((acc) => {
      const w = this.workers.get(acc.id);
      const snap = w ? w.getStatusSnapshot(now) : {
        id: acc.id,
        slotNo: acc.slotNo,
        label: acc.label,
        otpBot: acc.otpBotProfile,
        running: false,
        stage: acc.enabled ? (acc.healthStatus === 'dead' ? 'dead' : 'stopped') : 'disabled',
        stageAgeSec: 0,
        currentPhone: '',
        healthStatus: acc.healthStatus,
        cooldownLeftSec: acc.cooldownUntil > now ? Math.ceil((acc.cooldownUntil - now) / 1000) : 0,
        lastError: acc.lastError,
        createdInRun: 0,
        attemptsInRun: 0,
      };
      snap.enabled = acc.enabled;
      snap.totalCreated = acc.createdCount;
      snap.totalAttempts = acc.attemptCount;
      snap.tgUserLabel = acc.tgUserLabel;

      if (!acc.enabled) disabledCount += 1;
      else if (snap.healthStatus === 'dead') deadCount += 1;
      else if (snap.stage === 'cooldown' || (snap.healthStatus === 'cooldown' && snap.cooldownLeftSec > 0)) cooldownCount += 1;
      else if (snap.running) readyCount += 1;

      if (snap.running) {
        runningCount += 1;
        stages[snap.stage] = (stages[snap.stage] || 0) + 1;
      }
      return snap;
    });

    return {
      desiredRunning: this.desiredRunning,
      totalSlots: accounts.length,
      runningCount,
      readyCount,
      cooldownCount,
      deadCount,
      disabledCount,
      stages,
      throughput,
      delivery,
      toing,
      slots,
    };
  }
}
