// ===== Firebase Phone-Registration Pipeline — Core Engine =====
// Worker pool (100), FIFO queue, semaphores, registration flow (Android clientType), retry policy.

import { StateMachine } from './state-machine.js';
import { KeyPool } from './key-pool.js';
import { RetryPolicy } from './retry-policy.js';
import { ERR_KEY_QUARANTINED, ERR_KEY_FAILED, ERR_OTP_TIMEOUT, ERR_REGISTRATION_FAILED, ERR_MAX_ATTEMPTS } from './models.ts';
import { normalizeIndianMobileNumber } from '../../phone-utils.js';

// Semaphore implementation
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.count--;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      this.count++;
      resolve();
    }
  }
}

export class PipelineCore {
  constructor(config, stateMachine, keyPool, fetchImpl = fetch) {
    this.config = config;
    this.sm = stateMachine;
    this.kp = keyPool;
    this.fetchImpl = fetchImpl;
    
    this.globalSemaphore = new Semaphore(config.poolSize || 100);
    this.keySemaphores = new Map(); // keyId -> Semaphore(8)
    
    this.retryPolicy = new RetryPolicy(config);
    this.isRunning = false;
    this.queue = [];
    this.workers = [];
  }

  async start() {
    if (this.isRunning) return { ok: false, error: 'Already running' };
    this.isRunning = true;
    
    // Start worker pool
    for (let i = 0; i < (this.config.poolSize || 100); i++) {
      this.workers.push(this._workerLoop(i));
    }
    
    return { ok: true, workers: this.workers.length };
  }

  async stop() {
    this.isRunning = false;
    await Promise.all(this.workers);
    this.workers = [];
    return { ok: true };
  }

  async enqueueNumber(phoneRaw) {
    const phone = normalizeIndianMobileNumber(phoneRaw);
    if (!phone) return { ok: false, error: 'Invalid number' };
    
    const res = await this.sm.ingestNumber(phone);
    if (!res.ok) return res;
    
    this.queue.push(res.id);
    return { ok: true, id: res.id, phone };
  }

  async _workerLoop(workerId) {
    while (this.isRunning) {
      await this.globalSemaphore.acquire();
      
      try {
        // FIFO queue
        const id = this.queue.shift();
        if (!id) {
          // No work, release and sleep briefly
          this.globalSemaphore.release();
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        const numRes = await this.sm.getNumber(id);
        if (!numRes.ok) {
          this.globalSemaphore.release();
          continue;
        }

        const row = numRes.row;
        
        // Registration Flow: Assign key → sendVerificationCode → signInWithPhoneNumber → Success/PHONE_NUMBER_EXISTS → Fail/Retry
        await this._processRegistration(row);

      } catch (e) {
        console.error(`Worker ${workerId} error:`, e);
      } finally {
        this.globalSemaphore.release();
      }
    }
  }

  async _processRegistration(row) {
    const id = row.id;
    const phone = row.phone;
    const state = row.state;

    // State: pending → assigned
    if (state === 'pending' || state === 'retry_queue') {
      const keyRes = await this.kp.getNextKey();
      if (!keyRes.ok) {
        await this.sm.transitionState(id, 'failed', { error: keyRes.error });
        return;
      }

      const key = keyRes.key;
      const keySem = this.keySemaphores.get(key.id) || new Semaphore(key.cap || 8);
      if (!this.keySemaphores.has(key.id)) this.keySemaphores.set(key.id, keySem);

      await keySem.acquire();
      
      try {
        await this.sm.transitionState(id, 'assigned', { assignedKeyId: key.id });
        
        // 1. sendVerificationCode (Android clientType)
        const sendRes = await this._sendVerificationCode(phone, key.id);
        if (!sendRes.ok) {
          await this._handleFailure(id, sendRes.error, key.id);
          keySem.release();
          return;
        }

        await this.sm.transitionState(id, 'otp_sent');

        // 2. waitForOtpCode (polling)
        const otpRes = await this._waitForOtp(phone, sendRes.sid || '');
        if (!otpRes.ok) {
          await this._handleFailure(id, otpRes.error || ERR_OTP_TIMEOUT, key.id);
          keySem.release();
          return;
        }

        await this.sm.transitionState(id, 'active', { otpCode: otpRes.code });

        // 3. signInWithPhoneNumber → Success/PHONE_NUMBER_EXISTS → register → done
        const regRes = await this._signInAndRegister(phone, otpRes.code, key.id);
        if (!regRes.ok) {
          await this._handleFailure(id, regRes.error || ERR_REGISTRATION_FAILED, key.id);
          keySem.release();
          return;
        }

        await this.sm.transitionState(id, 'registered');
        
      } finally {
        keySem.release();
      }
    }
  }

  async _handleFailure(id, error, keyId) {
    const rowRes = await this.sm.getNumber(id);
    if (!rowRes.ok) return;
    
    const row = rowRes.row;
    const attempts = row.attempts + 1;
    
    const retryRes = this.retryPolicy.calculateDelay(attempts);
    if (!retryRes.ok) {
      await this.sm.transitionState(id, 'failed', { error: retryRes.error || error });
      return;
    }

    // Update key score (penalty)
    const keyRes = await this.kp.getKey(keyId);
    if (keyRes.ok) {
      // In real implementation, call kp.rotateAndScore(keyId)
      // For now, simulate penalty
      await this.sm.updateKeyScore(keyId, 0, 'quarantined', Date.now() + 10 * 60 * 1000);
    }

    await this.sm.transitionState(id, 'retry_queue', { error });
    
    // Schedule retry
    setTimeout(async () => {
      const current = await this.sm.getNumber(id);
      if (current.ok && current.row.state === 'retry_queue') {
        this.queue.push(id);
      }
    }, retryRes.delay);
  }

  // --- Firebase API Stubs (to be replaced with actual fetch calls) ---
  async _sendVerificationCode(phone, keyId) {
    // https://identitytoolkit.googleapis.com/v1/accounts:sendCode?key=AIza...
    // Android clientType
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendCode?key=${keyId}`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: `+91${phone}`, androidClientId: '...', clientType: 'ANDROID' })
      });
      if (!res.ok) {
        const txt = await res.text();
        return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 100)}` };
      }
      const data = await res.json();
      return { ok: true, sid: data.sessionInfo || '', tid: data.transactionId || '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async _waitForOtp(phone, sid) {
    // Poll logic (simulated for now, replace with actual Firebase SMS inbox poll)
    // In real implementation, use fetch against https://firebase.googleapis.com/v1/...
    const maxAttempts = 3;
    for (let i = 0; i < maxAttempts; i++) {
      // Simulate wait
      await new Promise(r => setTimeout(r, 2000));
      
      // Actual fetch would go here
      // const url = `https://firebase.googleapis.com/v1/projects/.../sms?sid=${sid}`;
      // ...
      
      // Mock success for demonstration (remove in production)
      if (Math.random() > 0.5) {
        return { ok: true, code: '123456' };
      }
    }
    return { ok: false, error: 'OTP timeout' };
  }

  async _signInAndRegister(phone, code, keyId) {
    // https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIza...
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=${keyId}`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: `+91${phone}`, code, androidClientId: '...' })
      });
      if (!res.ok) {
        const txt = await res.text();
        return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 100)}` };
      }
      const data = await res.json();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getStats() {
    // Fetch from state machine
    return {
      pending: 0, // TODO: query sm
      assigned: 0,
      otpSent: 0,
      active: 0,
      registering: 0,
      registered: 0,
      failed: 0,
      retryQueue: 0,
      throughput: 0,
      workers: this.workers.length,
      queueLength: this.queue.length
    };
  }
}
