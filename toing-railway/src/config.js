import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const APP_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TOING_BASE_URL = 'https://storelex.store/toing_web';
export const DEFAULT_TOING_ACCESS_KEY = 'TNG-6BMI-SHBL-OOLY';
export const DEFAULT_MAX_SLOTS = 50;

function envInt(env, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envBool(env, key, fallback = false) {
  const raw = String(env?.[key] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export function parseCsvList(raw = '') {
  return String(raw || '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseOwnerIds(raw = '') {
  const ids = parseCsvList(raw)
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);
  return [...new Set(ids)];
}

export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR
    ? path.resolve(env.DATA_DIR)
    : path.join(APP_ROOT, 'data');

  const ownerIds = parseOwnerIds(env.OWNER_IDS || env.OWNER_ID || '6484999726');
  const toingKeys = parseCsvList(env.TOING_ACCESS_KEYS || env.TOING_ACCESS_KEY || DEFAULT_TOING_ACCESS_KEY);

  return {
    botToken: String(env.BOT_TOKEN || '').trim(),
    ownerIds,
    primaryOwnerId: ownerIds[0] || '',
    dataDir,
    dbPath: path.join(dataDir, 'toing.db'),
    sessionsDir: path.join(dataDir, 'sessions'),
    seedUsedNumbersFile: env.USED_NUMBERS_SEED_FILE
      ? path.resolve(env.USED_NUMBERS_SEED_FILE)
      : path.join(APP_ROOT, 'seed', 'used-numbers.json'),

    vaultEncryptionKey: String(env.VAULT_ENCRYPTION_KEY || '').trim(),

    telegramApiId: envInt(env, 'TELEGRAM_API_ID', 0, 0),
    telegramApiHash: String(env.TELEGRAM_API_HASH || '').trim(),

    toingBaseUrl: String(env.TOING_PRO_BASE_URL || DEFAULT_TOING_BASE_URL).trim().replace(/\/+$/, ''),
    toingAccessKeys: toingKeys.length ? toingKeys : [DEFAULT_TOING_ACCESS_KEY],
    toingHttpConcurrency: envInt(env, 'TOING_HTTP_CONCURRENCY', 20, 1, 100),

    defaultOtpBot: String(env.DEFAULT_OTP_BOT || 'hathi').trim().toLowerCase(),
    otpTimeoutMs: envInt(env, 'OTP_TIMEOUT_MS', 20_000, 5_000, 120_000),
    otpRefreshMs: envInt(env, 'OTP_REFRESH_MS', 1_800, 800, 10_000),
    claimTimeoutMs: envInt(env, 'CLAIM_TIMEOUT_MS', 16_000, 4_000, 60_000),
    autoFailoverBots: envBool(env, 'AUTO_FAILOVER_BOTS', false),
    skipRegistered: envBool(env, 'SKIP_REGISTERED', true),
    otpTimeoutCooldownMin: envInt(env, 'OTP_TIMEOUT_COOLDOWN_MIN', 10, 0, 1440),

    maxSlots: envInt(env, 'MAX_SLOTS', DEFAULT_MAX_SLOTS, 1, 100),
    bootBatchSize: envInt(env, 'BOOT_BATCH_SIZE', 5, 1, 25),
    bootBatchDelayMs: envInt(env, 'BOOT_BATCH_DELAY_MS', 1_500, 100, 15_000),
    slotStuckTimeoutMs: envInt(env, 'SLOT_STUCK_TIMEOUT_MS', 55_000, 20_000, 300_000),
    slotJitterMinMs: envInt(env, 'SLOT_JITTER_MIN_MS', 250, 0, 10_000),
    slotJitterMaxMs: envInt(env, 'SLOT_JITTER_MAX_MS', 900, 0, 20_000),

    deliveryChatId: String(env.DELIVERY_CHAT_ID || '').trim(),
    deliveryGapMs: envInt(env, 'DELIVERY_GAP_MS', 1_050, 250, 10_000),

    usedCooldownDays: envInt(env, 'USED_COOLDOWN_DAYS', 30, 1, 365),
    claimLockTtlMs: envInt(env, 'CLAIM_LOCK_TTL_MS', 120_000, 30_000, 600_000),
    autoResume: envBool(env, 'AUTO_RESUME', true),
    targetAccountsPerMin: envInt(env, 'TARGET_ACCOUNTS_PER_MIN', 20, 1, 500),

    port: envInt(env, 'PORT', 3000, 1, 65535),
  };
}
