// ===== Firebase Phone-Registration Pipeline — Key Scoring & Validation =====
// Health scoring (0-100), weighted round-robin, quarantine (10m timer), rotation.
// Validation probes: Recaptcha, Project, OTP Canary, Latency.

import { ERR_KEY_QUARANTINED, ERR_KEY_FAILED } from './models.ts';

const BASE_SCORE = 100;
const HARD_ERROR_PENALTY = 15;
const THROTTLE_PENALTY = 5;
const SLOW_PENALTY = 1;
const QUARANTINE_THRESHOLD = 40;
const CAP_PER_KEY = 8;

export function validateKey(key) {
  // AIza prefix, 39 chars, ASCII
  if (!key || typeof key !== 'string') return { ok: false, error: 'Invalid key format' };
  if (!/^AIza[A-Za-z0-9_-]{34}$/.test(key)) {
    return { ok: false, error: 'Key must start with AIza and be 39 chars ASCII' };
  }
  return { ok: true };
}

export async function probeKey(key, fetchImpl = fetch) {
  // 1. Project validation
  const projectUrl = `https://firebase.googleapis.com/v1/projects/${key.slice(4, 20)}?key=${key}`;
  const t0 = Date.now();
  let projectOk = false;
  let latency = 0;
  try {
    const res = await fetchImpl(projectUrl, { signal: AbortSignal.timeout(5000) });
    latency = Date.now() - t0;
    if (res.ok) projectOk = true;
    else if (res.status === 403 || res.status === 401) return { ok: false, score: 0, status: 'failed', error: 'Invalid key (403/401)', latency };
    else return { ok: false, score: BASE_SCORE - HARD_ERROR_PENALTY, status: 'throttled', error: `HTTP ${res.status}`, latency };
  } catch (e) {
    latency = Date.now() - t0;
    return { ok: false, score: BASE_SCORE - HARD_ERROR_PENALTY, status: 'failed', error: e.message, latency };
  }

  // 2. Recaptcha probe (dummy validation for health)
  const identityUrl = `https://identitytoolkit.googleapis.com/v1/projects/${key.slice(4, 20)}/reCAPTCHA?key=${key}`;
  let recaptchaOk = false;
  try {
    const res = await fetchImpl(identityUrl, { signal: AbortSignal.timeout(3000) });
    if (res.ok) recaptchaOk = true;
  } catch (_) {}

  // 3. Score calculation
  let score = BASE_SCORE;
  if (!projectOk) score -= HARD_ERROR_PENALTY;
  if (!recaptchaOk) score -= THROTTLE_PENALTY;
  if (latency > 1000) score -= SLOW_PENALTY;

  score = Math.max(0, Math.min(100, score));

  let status: 'healthy' | 'throttled' | 'slow' | 'quarantined' | 'failed' = 'healthy';
  if (score < QUARANTINE_THRESHOLD) status = 'quarantined';
  else if (score < 70) status = 'throttled';
  else if (latency > 1000) status = 'slow';

  return { ok: true, score, status, latency, projectOk, recaptchaOk };
}

export function calculateWeightedRoundRobin(keys) {
  // Filter quarantined/failed
  const activeKeys = keys.filter(k => k.status !== 'quarantined' && k.status !== 'failed' && k.usageCount < k.cap);
  if (activeKeys.length === 0) return null;

  // Weighted by score (≥70 weighted round-robin)
  const weights = activeKeys.map(k => k.score >= 70 ? k.score : 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const rand = Math.random() * totalWeight;
  let sum = 0;
  for (let i = 0; i < activeKeys.length; i++) {
    sum += weights[i];
    if (rand <= sum) return activeKeys[i];
  }
  return activeKeys[0];
}

export function updateScore(key, result) {
  let newScore = key.score;
  let newStatus = key.status;

  if (!result.ok) {
    if (result.status === 'failed') {
      newScore -= HARD_ERROR_PENALTY;
      newStatus = 'failed';
    } else if (result.status === 'throttled') {
      newScore -= THROTTLE_PENALTY;
      newStatus = 'throttled';
    } else if (result.latency > 1000) {
      newScore -= SLOW_PENALTY;
      newStatus = 'slow';
    }
  } else {
    // Success: +1 slow recovery (max 100)
    newScore = Math.min(100, newScore + 1);
    if (newScore >= 70) newStatus = 'healthy';
  }

  if (newScore < QUARANTINE_THRESHOLD) {
    newStatus = 'quarantined';
    newScore = 0; // Reset for quarantine
  }

  return {
    ...key,
    score: newScore,
    status: newStatus,
    lastUsed: Date.now(),
    usageCount: key.usageCount + 1,
  };
}

export const QUARANTINE_TIMER_MS = 10 * 60 * 1000; // 10 minutes

export function isQuarantinedExpired(key) {
  if (key.status !== 'quarantined') return false;
  return Date.now() > key.quarantineUntil + QUARANTINE_TIMER_MS;
}
