// ===== Firebase Phone-Registration Pipeline — Retry Policy =====
// Exponential backoff (max 3 attempts, jitter).

import { ERR_MAX_ATTEMPTS } from './models.ts';

export class RetryPolicy {
  constructor(config) {
    this.floor = config.backoffFloor || 1000;
    this.ceiling = config.backoffCeiling || 30000;
    this.jitter = config.backoffJitter || 0.2;
    this.maxAttempts = config.maxAttempts || 3;
  }

  calculateDelay(attempt) {
    if (attempt >= this.maxAttempts) return { ok: false, error: ERR_MAX_ATTEMPTS };
    
    // Exponential backoff: floor * 2^(attempt-1)
    const base = this.floor * Math.pow(2, attempt - 1);
    const capped = Math.min(base, this.ceiling);
    
    // Jitter: +/- floor * jitter
    const jitterAmount = this.floor * this.jitter;
    const delay = capped + (Math.random() * jitterAmount * 2 - jitterAmount);
    
    return { ok: true, delay: Math.max(0, Math.round(delay)) };
  }

  shouldRetry(attempt) {
    return attempt < this.maxAttempts;
  }
}
