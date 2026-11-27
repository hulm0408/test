// ===== Per-OTP-Bot Priority Click Pacer =====
// Coordinates slots sharing a single OTP bot (e.g., 15 slots all on @Hathi_otp_bot)
// so idle NEW NUMBER scanning NEVER floods/starves active OTP REFRESH clicks.
//
// Priority tiers per botId:
//   - 'refresh' (VIP): slots actively waiting for a live Swiggy OTP go FIRST (120ms gap).
//   - 'claim' (normal): NEW NUMBER scanning yields to refreshes and adapts gap smoothly
//     when another slot is waiting for OTP or the OTP bot is experiencing lag.

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

export class BotClickPacer {
  constructor({
    claimGapMs = 240,
    busyClaimGapMs = 500,
    congestedClaimGapMs = 850,
    refreshGapMs = 120,
    congestionWindowMs = 15_000,
  } = {}) {
    this.claimGapMs = Math.max(0, Number(claimGapMs) || 0);
    this.busyClaimGapMs = Math.max(this.claimGapMs, Number(busyClaimGapMs) || 0);
    this.congestedClaimGapMs = Math.max(this.busyClaimGapMs, Number(congestedClaimGapMs) || 0);
    this.refreshGapMs = Math.max(0, Number(refreshGapMs) || 0);
    this.congestionWindowMs = Math.max(2_000, Number(congestionWindowMs) || 15_000);
    this._bots = new Map(); // botId -> state
  }

  _state(botId = 'default') {
    const key = String(botId || 'default').toLowerCase();
    let st = this._bots.get(key);
    if (!st) {
      st = {
        activeOtpWaits: 0,
        congestedUntil: 0,
        lastRefreshAt: 0,
        lastClaimAt: 0,
        refreshQueue: [],
        claimQueue: [],
        draining: false,
      };
      this._bots.set(key, st);
    }
    return st;
  }

  markOtpWaitStart(botId) {
    const st = this._state(botId);
    st.activeOtpWaits += 1;
  }

  markOtpWaitEnd(botId) {
    const st = this._state(botId);
    st.activeOtpWaits = Math.max(0, st.activeOtpWaits - 1);
  }

  noteBotSlow(botId) {
    const st = this._state(botId);
    st.congestedUntil = Math.max(st.congestedUntil, Date.now() + this.congestionWindowMs);
  }

  noteBotFast(botId) {
    const st = this._state(botId);
    if (st.congestedUntil > Date.now()) {
      // Gently decay congestion window on healthy fast replies
      st.congestedUntil = Math.max(0, st.congestedUntil - 3_000);
    }
  }

  getClaimGapMs(botId, now = Date.now()) {
    const st = this._state(botId);
    if (st.congestedUntil > now) return this.congestedClaimGapMs;
    if (st.activeOtpWaits > 0) return this.busyClaimGapMs;
    return this.claimGapMs;
  }

  async acquire(botId, { priority = 'claim', shouldAbort = null } = {}) {
    if (shouldAbort?.()) return false;
    const st = this._state(botId);
    const isRefresh = priority === 'refresh';

    return new Promise((resolve) => {
      const entry = {
        isRefresh,
        shouldAbort,
        settled: false,
        finish(granted) {
          if (this.settled) return;
          this.settled = true;
          resolve(granted);
        },
      };

      if (isRefresh) {
        st.refreshQueue.push(entry);
      } else {
        st.claimQueue.push(entry);
      }

      this._drain(botId, st);
    });
  }

  async _drain(botId, st) {
    if (st.draining) return;
    st.draining = true;

    try {
      while (st.refreshQueue.length > 0 || st.claimQueue.length > 0) {
        // Always prioritize OTP REFRESH clicks ahead of NEW NUMBER scans!
        const next = st.refreshQueue.length > 0
          ? st.refreshQueue.shift()
          : st.claimQueue.shift();

        if (!next || next.settled) continue;
        if (next.shouldAbort?.()) {
          next.finish(false);
          continue;
        }

        const now = Date.now();
        const waitMs = next.isRefresh
          ? Math.max(0, (st.lastRefreshAt + this.refreshGapMs) - now)
          : Math.max(0, (st.lastClaimAt + this.getClaimGapMs(botId, now)) - now);

        if (waitMs > 0) {
          const end = Date.now() + waitMs;
          while (Date.now() < end) {
            if (next.shouldAbort?.()) break;
            // If we were pacing a claim and a VIP refresh arrived, put claim back at front & serve refresh NOW!
            if (!next.isRefresh && st.refreshQueue.length > 0) {
              st.claimQueue.unshift(next);
              break;
            }
            await sleep(Math.min(50, end - Date.now()));
          }
          if (!next.isRefresh && st.claimQueue[0] === next) {
            continue; // Re-queued behind a VIP refresh
          }
          if (next.shouldAbort?.()) {
            next.finish(false);
            continue;
          }
        }

        const grantedAt = Date.now();
        if (next.isRefresh) {
          st.lastRefreshAt = grantedAt;
        } else {
          st.lastClaimAt = grantedAt;
        }
        next.finish(true);
      }
    } finally {
      st.draining = false;
      if (st.refreshQueue.length > 0 || st.claimQueue.length > 0) {
        this._drain(botId, st);
      }
    }
  }

  getStats(botId = null) {
    const now = Date.now();
    const snap = (st, id) => ({
      activeOtpWaits: st.activeOtpWaits,
      congestedSec: st.congestedUntil > now ? Math.ceil((st.congestedUntil - now) / 1000) : 0,
      claimGapMs: this.getClaimGapMs(id, now),
      refreshQueued: st.refreshQueue.length,
      claimQueued: st.claimQueue.length,
    });
    if (botId) return snap(this._state(botId), botId);
    const out = {};
    for (const [id, st] of this._bots.entries()) out[id] = snap(st, id);
    return out;
  }
}
