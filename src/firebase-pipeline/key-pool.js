// ===== Firebase Phone-Registration Pipeline — Key Pool =====
// Health scoring (0-100), weighted round-robin, quarantine (10m timer), rotation.

import { validateKey, probeKey, calculateWeightedRoundRobin, updateScore, isQuarantinedExpired } from './key-scoring.js';
import { ERR_KEY_QUARANTINED, ERR_KEY_FAILED } from './models.ts';

export class KeyPool {
  constructor(keys = [], fetchImpl = fetch) {
    this.keys = keys.map(k => ({
      ...k,
      score: k.score || 100,
      status: k.status || 'healthy',
      usageCount: k.usageCount || 0,
      cap: k.cap || 8,
      quarantineUntil: k.quarantineUntil || 0,
      createdAt: k.createdAt || Date.now(),
    }));
    this.fetchImpl = fetchImpl;
  }

  async addKey(rawKey) {
    const val = validateKey(rawKey);
    if (!val.ok) return val;
    
    // Check if already exists
    const exists = this.keys.find(k => k.id === rawKey);
    if (exists) return { ok: false, error: 'Key already exists' };

    const probe = await probeKey(rawKey, this.fetchImpl);
    const newKey = {
      id: rawKey,
      score: probe.score,
      status: probe.status,
      lastUsed: 0,
      usageCount: 0,
      cap: 8,
      quarantineUntil: probe.status === 'quarantined' ? Date.now() : 0,
      createdAt: Date.now(),
    };
    this.keys.push(newKey);
    return { ok: true, key: newKey };
  }

  async rotateAndScore(keyId) {
    const key = this.keys.find(k => k.id === keyId);
    if (!key) return { ok: false, error: 'Key not found' };

    // Check quarantine expiration
    if (key.status === 'quarantined' && isQuarantinedExpired(key)) {
      // Re-probe
      const probe = await probeKey(key.id, this.fetchImpl);
      const updated = updateScore(key, probe);
      const idx = this.keys.indexOf(key);
      if (idx !== -1) this.keys[idx] = updated;
      return { ok: true, key: updated };
    }

    // Normal probe
    const probe = await probeKey(key.id, this.fetchImpl);
    const updated = updateScore(key, probe);
    const idx = this.keys.indexOf(key);
    if (idx !== -1) this.keys[idx] = updated;
    
    return { ok: true, key: updated };
  }

  getNextKey() {
    // Check for expired quarantines first
    this.keys.forEach(k => {
      if (k.status === 'quarantined' && isQuarantinedExpired(k)) {
        k.status = 'healthy';
        k.score = 100;
        k.quarantineUntil = 0;
      }
    });

    const selected = calculateWeightedRoundRobin(this.keys);
    if (!selected) return { ok: false, error: 'No healthy keys available (all quarantined/failed/capped)' };

    // Increment usage
    selected.usageCount += 1;
    selected.lastUsed = Date.now();

    return { ok: true, key: selected };
  }

  getKeyStats() {
    return {
      total: this.keys.length,
      healthy: this.keys.filter(k => k.status === 'healthy').length,
      throttled: this.keys.filter(k => k.status === 'throttled').length,
      slow: this.keys.filter(k => k.status === 'slow').length,
      quarantined: this.keys.filter(k => k.status === 'quarantined').length,
      failed: this.keys.filter(k => k.status === 'failed').length,
    };
  }

  getAllKeys() {
    return this.keys;
  }
}
