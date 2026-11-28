import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptSecret, decryptSecret, resolveMasterKey, sessionFingerprint } from './crypto.js';
import { normalizePhone10 } from './otp-parser.js';
import { normalizeOtpBotProfileId } from './otp-profiles.js';
import {
  MAX_BULK_FIREBASE_SOURCES,
  builtinSourceName,
  normalizeSourceUrl,
  parseFirebaseSourceBulkInput,
  validateFirebaseSourceInput,
} from './firebase-client.js';
import {
  BUILTIN_FIREBASE_SEED_VERSION,
  BUILTIN_FIREBASE_SOURCE_URLS,
  DEFAULT_FIREBASE_URL,
} from './firebase-seed-urls.js';

export const FIREBASE_FAIL_THRESHOLD = 2;
export const FIREBASE_QUARANTINE_MS = 30 * 60_000;
// OTP delivery failures are weighted differently from pool-load failures:
// a source that loads pools fine but never delivers an OTP is the expensive
// case (every attempt burns 60s + a real OTP), so it demotes at 2 and rests
// longer than a plain read failure.
export const FIREBASE_OTP_FAIL_THRESHOLD = 2;
export const FIREBASE_OTP_QUARANTINE_MS = 45 * 60_000;
// A single device that never delivers is skipped after 2 misses; it comes back
// after 30m so a temporarily offline phone is not blacklisted forever.
export const FIREBASE_DEVICE_FAIL_THRESHOLD = 2;
export const FIREBASE_DEVICE_QUARANTINE_MS = 30 * 60_000;

export class ToingDb {
  constructor({ dbPath, dataDir, encryptionKey = '', sessionsDir = '' } = {}) {
    this.dataDir = dataDir || path.dirname(dbPath || ':memory:');
    this.dbPath = dbPath || ':memory:';
    this.sessionsDir = sessionsDir || (this.dbPath === ':memory:' ? '' : path.join(this.dataDir, 'sessions'));

    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    if (this.sessionsDir) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    const resolved = resolveMasterKey({
      envKey: encryptionKey,
      dataDir: this.dbPath === ':memory:' ? '' : this.dataDir,
    });
    this.masterKey = resolved.key;
    this.keySource = resolved.source;

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tg_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_no INTEGER UNIQUE NOT NULL,
        fingerprint TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        tg_user_label TEXT NOT NULL DEFAULT '',
        session_enc TEXT NOT NULL,
        api_id INTEGER NOT NULL DEFAULT 0,
        api_hash TEXT NOT NULL DEFAULT '',
        otp_bot_profile TEXT NOT NULL DEFAULT 'hathi',
        enabled INTEGER NOT NULL DEFAULT 1,
        health_status TEXT NOT NULL DEFAULT 'ready',
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_count INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS used_numbers (
        phone TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'extracted',
        account_key TEXT NOT NULL DEFAULT '',
        slot_id INTEGER NOT NULL DEFAULT 0,
        extracted_at INTEGER NOT NULL,
        cooldown_until INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'toing'
      );
      CREATE INDEX IF NOT EXISTS idx_used_numbers_cooldown ON used_numbers(cooldown_until);

      CREATE TABLE IF NOT EXISTS active_claims (
        phone TEXT PRIMARY KEY,
        slot_id INTEGER NOT NULL,
        stage TEXT NOT NULL DEFAULT 'claimed',
        claimed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_active_claims_expires ON active_claims(expires_at);

      CREATE TABLE IF NOT EXISTS toing_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mobile TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        token TEXT NOT NULL DEFAULT '',
        sid TEXT NOT NULL DEFAULT '',
        tid TEXT NOT NULL DEFAULT '',
        device_id TEXT NOT NULL DEFAULT '',
        customer_id TEXT NOT NULL DEFAULT '',
        is_new INTEGER NOT NULL DEFAULT 0,
        slot_id INTEGER NOT NULL DEFAULT 0,
        otp_bot TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL,
        file_name TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_toing_sessions_mobile ON toing_sessions(mobile);
      CREATE INDEX IF NOT EXISTS idx_toing_sessions_created ON toing_sessions(created_at DESC);

      CREATE TABLE IF NOT EXISTS delivery_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        phone TEXT NOT NULL,
        file_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        sent_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_queue_pending ON delivery_queue(status, next_retry_at, id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_events_created ON metrics_events(created_at);

      CREATE TABLE IF NOT EXISTS number_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_id INTEGER NOT NULL DEFAULT 0,
        slot_no INTEGER NOT NULL DEFAULT 0,
        phone TEXT NOT NULL DEFAULT '',
        otp_bot TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_number_events_created ON number_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS firebase_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT UNIQUE NOT NULL,
        auth_enc TEXT NOT NULL DEFAULT '',
        clients_path TEXT NOT NULL DEFAULT 'clients',
        messages_path TEXT NOT NULL DEFAULT 'messages',
        numbers_path TEXT NOT NULL DEFAULT '',
        sms_path TEXT NOT NULL DEFAULT 'sms',
        otp_path TEXT NOT NULL DEFAULT 'otp',
        is_primary INTEGER NOT NULL DEFAULT 0,
        builtin INTEGER NOT NULL DEFAULT 0,
        ok_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        fail_streak INTEGER NOT NULL DEFAULT 0,
        empty_streak INTEGER NOT NULL DEFAULT 0,
        last_ok_at INTEGER NOT NULL DEFAULT 0,
        last_fail_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        quarantined_until INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS firebase_deleted_urls (
        url_key TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );

      -- Per-device OTP delivery learning (the ONLY reliable proof that a panel
      -- actually forwards SMS to Firebase). A device whose inbox never gets the
      -- OTP is useless even if it shows "online" in clients/.
      CREATE TABLE IF NOT EXISTS firebase_devices (
        source_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        otp_ok INTEGER NOT NULL DEFAULT 0,
        otp_fail INTEGER NOT NULL DEFAULT 0,
        fail_streak INTEGER NOT NULL DEFAULT 0,
        last_ok_at INTEGER NOT NULL DEFAULT 0,
        last_fail_at INTEGER NOT NULL DEFAULT 0,
        last_ok_latency_ms INTEGER NOT NULL DEFAULT 0,
        quarantined_until INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_key, device_id)
      );
      CREATE INDEX IF NOT EXISTS idx_firebase_devices_quarantine
        ON firebase_devices(source_key, quarantined_until);
    `);

    // Additive column migrations for existing installs (older SQLite files).
    // Loading a pool successfully proves nothing about OTP delivery, so it gets
    // its own counters — otherwise a "pool loads but never delivers" source
    // keeps resetting fail_streak to 0 and is never demoted.
    const addColumn = (table, column, ddl) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    addColumn('firebase_sources', 'otp_ok_count', 'otp_ok_count INTEGER NOT NULL DEFAULT 0');
    addColumn('firebase_sources', 'otp_fail_count', 'otp_fail_count INTEGER NOT NULL DEFAULT 0');
    addColumn('firebase_sources', 'otp_fail_streak', 'otp_fail_streak INTEGER NOT NULL DEFAULT 0');
    addColumn('firebase_sources', 'otp_last_ok_at', 'otp_last_ok_at INTEGER NOT NULL DEFAULT 0');
    addColumn('firebase_sources', 'otp_quarantined_until', 'otp_quarantined_until INTEGER NOT NULL DEFAULT 0');
    addColumn('firebase_sources', 'otp_best_latency_ms', 'otp_best_latency_ms INTEGER NOT NULL DEFAULT 0');
    addColumn('firebase_devices', 'last_ok_latency_ms', 'last_ok_latency_ms INTEGER NOT NULL DEFAULT 0');
  }

  withTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}
    this.db.close();
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  getSetting(key, fallback = undefined) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  setSetting(key, value) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(key), JSON.stringify(value), now);
    return value;
  }

  getAllSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  }

  // ── Seed used numbers (idempotent) ─────────────────────────────────────────
  seedUsedNumbersFromFile(filePath, { defaultCooldownDays = 30 } = {}) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { present: false, added: 0, kept: 0, expired: 0 };
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      return { present: false, added: 0, kept: 0, expired: 0, error: err.message };
    }

    const numbers = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.numbers) ? parsed.numbers : []);
    const addedAtMap = (parsed && typeof parsed.addedAt === 'object' && parsed.addedAt) || {};
    const defaultSeededMs = Date.parse(parsed?.seededAt || '') || Date.now();
    const cooldownDays = Number(parsed?.cooldownDays) || defaultCooldownDays;
    const cooldownMs = Math.max(1, cooldownDays) * 24 * 60 * 60 * 1000;
    const now = Date.now();

    let added = 0;
    let kept = 0;
    let expired = 0;

    const selectStmt = this.db.prepare('SELECT phone FROM used_numbers WHERE phone = ?');
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO used_numbers (phone, status, account_key, slot_id, extracted_at, cooldown_until, source)
      VALUES (?, 'seed', '', 0, ?, ?, 'seed')
    `);

    const seen = new Set();
    this.withTransaction(() => {
      for (const raw of numbers) {
        const phone = normalizePhone10(raw);
        if (!phone || seen.has(phone)) continue;
        seen.add(phone);
        const tsRaw = addedAtMap[phone];
        const tsMs = tsRaw ? (Date.parse(tsRaw) || defaultSeededMs) : defaultSeededMs;
        const untilMs = tsMs + cooldownMs;
        if (untilMs <= now) {
          expired += 1;
          continue;
        }
        const exists = selectStmt.get(phone);
        if (exists) {
          kept += 1;
          continue;
        }
        insertStmt.run(phone, tsMs, untilMs);
        added += 1;
      }
    });

    return { present: true, added, kept, expired, totalInFile: numbers.length };
  }

  // ── TG Spare Accounts (up to 50+) ──────────────────────────────────────────
  _nextAvailableSlotNo(maxSlots = 100) {
    const used = new Set(
      this.db.prepare('SELECT slot_no FROM tg_accounts').all().map((r) => Number(r.slot_no))
    );
    for (let n = 1; n <= maxSlots; n++) {
      if (!used.has(n)) return n;
    }
    const maxRow = this.db.prepare('SELECT COALESCE(MAX(slot_no), 0) AS m FROM tg_accounts').get();
    return Number(maxRow?.m || 0) + 1;
  }

  _hydrateAccountRow(row, { includeSession = false } = {}) {
    if (!row) return null;
    const obj = {
      id: Number(row.id),
      slotNo: Number(row.slot_no),
      fingerprint: String(row.fingerprint),
      label: String(row.label),
      tgUserLabel: String(row.tg_user_label || ''),
      apiId: Number(row.api_id || 0),
      apiHash: String(row.api_hash || ''),
      otpBotProfile: normalizeOtpBotProfileId(row.otp_bot_profile),
      enabled: Boolean(row.enabled),
      healthStatus: String(row.health_status || 'ready'),
      cooldownUntil: Number(row.cooldown_until || 0),
      lastError: String(row.last_error || ''),
      createdCount: Number(row.created_count || 0),
      attemptCount: Number(row.attempt_count || 0),
      failCount: Number(row.fail_count || 0),
      lastSuccessAt: Number(row.last_success_at || 0),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
    if (includeSession) {
      let decrypted = '';
      try {
        decrypted = decryptSecret(row.session_enc, this.masterKey);
      } catch (err) {
        obj.decryptError = err.message;
      }
      Object.defineProperty(obj, 'session', {
        value: decrypted,
        enumerable: false,
        writable: false,
      });
    }
    return obj;
  }

  addAccount({
    session,
    label = '',
    tgUserLabel = '',
    apiId = 0,
    apiHash = '',
    otpBotProfile = 'hathi',
    enabled = true,
    maxSlots = 50,
  } = {}) {
    const cleanSession = String(session || '').trim();
    if (!cleanSession || cleanSession.length < 20) {
      return { ok: false, reason: 'invalid_session' };
    }
    const fp = sessionFingerprint(cleanSession);
    const existing = this.db.prepare('SELECT id, slot_no, label FROM tg_accounts WHERE fingerprint = ?').get(fp);
    if (existing) {
      return {
        ok: false,
        reason: 'duplicate',
        existingId: Number(existing.id),
        slotNo: Number(existing.slot_no),
        label: existing.label,
      };
    }

    const total = Number(this.db.prepare('SELECT COUNT(*) AS c FROM tg_accounts').get()?.c || 0);
    if (total >= maxSlots) {
      return { ok: false, reason: 'max_slots_reached', maxSlots };
    }

    const now = Date.now();
    const slotNo = this._nextAvailableSlotNo(maxSlots);
    const cleanLabel = String(label || '').trim() || `Slot-${String(slotNo).padStart(2, '0')}`;
    const cleanBot = normalizeOtpBotProfileId(otpBotProfile);
    const sessionEnc = encryptSecret(cleanSession, this.masterKey);

    const res = this.db.prepare(`
      INSERT INTO tg_accounts (
        slot_no, fingerprint, label, tg_user_label, session_enc,
        api_id, api_hash, otp_bot_profile, enabled,
        health_status, cooldown_until, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, '', ?, ?)
    `).run(
      slotNo,
      fp,
      cleanLabel,
      String(tgUserLabel || '').trim(),
      sessionEnc,
      Number(apiId) || 0,
      String(apiHash || '').trim(),
      cleanBot,
      enabled ? 1 : 0,
      now,
      now
    );

    return {
      ok: true,
      id: Number(res.lastInsertRowid),
      slotNo,
      label: cleanLabel,
      fingerprint: fp,
      otpBotProfile: cleanBot,
    };
  }

  importAccountsBulk(items = [], { defaultOtpBot = 'hathi', maxSlots = 50 } = {}) {
    const summary = { added: [], duplicates: [], invalid: [], capped: 0 };
    for (const item of Array.isArray(items) ? items : []) {
      const res = this.addAccount({
        session: item.session,
        label: item.label || '',
        tgUserLabel: item.tgUserLabel || '',
        apiId: item.apiId || 0,
        apiHash: item.apiHash || '',
        otpBotProfile: item.otpBot || item.otpBotProfile || defaultOtpBot,
        enabled: item.enabled !== false,
        maxSlots,
      });
      if (res.ok) summary.added.push(res);
      else if (res.reason === 'duplicate') summary.duplicates.push(res);
      else if (res.reason === 'max_slots_reached') summary.capped += 1;
      else summary.invalid.push(res);
    }
    return summary;
  }

  listAccounts({ includeSession = false, onlyEnabled = false } = {}) {
    const sql = onlyEnabled
      ? 'SELECT * FROM tg_accounts WHERE enabled = 1 ORDER BY slot_no ASC'
      : 'SELECT * FROM tg_accounts ORDER BY slot_no ASC';
    return this.db.prepare(sql).all().map((r) => this._hydrateAccountRow(r, { includeSession }));
  }

  getAccountById(id, { includeSession = false } = {}) {
    const row = this.db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(Number(id));
    return this._hydrateAccountRow(row, { includeSession });
  }

  getAccountBySlotNo(slotNo, { includeSession = false } = {}) {
    const row = this.db.prepare('SELECT * FROM tg_accounts WHERE slot_no = ?').get(Number(slotNo));
    return this._hydrateAccountRow(row, { includeSession });
  }

  updateAccountHealth(id, { healthStatus, cooldownUntil = 0, lastError = '', tgUserLabel = '' } = {}) {
    const now = Date.now();
    const sets = ['updated_at = ?'];
    const params = [now];
    if (healthStatus !== undefined) { sets.push('health_status = ?'); params.push(String(healthStatus)); }
    if (cooldownUntil !== undefined) { sets.push('cooldown_until = ?'); params.push(Number(cooldownUntil) || 0); }
    if (lastError !== undefined) { sets.push('last_error = ?'); params.push(String(lastError || '').slice(0, 220)); }
    if (tgUserLabel) { sets.push('tg_user_label = ?'); params.push(String(tgUserLabel).slice(0, 80)); }
    params.push(Number(id));
    this.db.prepare(`UPDATE tg_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  setAccountEnabled(id, enabled) {
    this.db.prepare('UPDATE tg_accounts SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), Number(id));
  }

  setAccountOtpBot(id, profileId) {
    const clean = normalizeOtpBotProfileId(profileId);
    this.db.prepare('UPDATE tg_accounts SET otp_bot_profile = ?, updated_at = ? WHERE id = ?')
      .run(clean, Date.now(), Number(id));
    return clean;
  }

  setAllAccountsOtpBot(profileId) {
    const clean = normalizeOtpBotProfileId(profileId);
    const res = this.db.prepare('UPDATE tg_accounts SET otp_bot_profile = ?, updated_at = ?')
      .run(clean, Date.now());
    return { profile: clean, updated: Number(res.changes || 0) };
  }

  spreadAccountsAcrossBots(profileIds = ['hathi', 'hermes', 'chauhan']) {
    const bots = (Array.isArray(profileIds) && profileIds.length ? profileIds : ['hathi', 'hermes', 'chauhan'])
      .map((p) => normalizeOtpBotProfileId(p));
    const uniqueBots = [...new Set(bots)];
    const rows = this.db.prepare('SELECT id, slot_no FROM tg_accounts ORDER BY slot_no ASC, id ASC').all();
    const now = Date.now();
    const distribution = {};
    const assignments = [];
    for (const b of uniqueBots) distribution[b] = 0;

    this.withTransaction(() => {
      const upd = this.db.prepare('UPDATE tg_accounts SET otp_bot_profile = ?, updated_at = ? WHERE id = ?');
      rows.forEach((row, idx) => {
        const bot = uniqueBots[idx % uniqueBots.length];
        upd.run(bot, now, Number(row.id));
        distribution[bot] = (distribution[bot] || 0) + 1;
        assignments.push({ id: Number(row.id), slotNo: Number(row.slot_no), profile: bot });
      });
    });
    return { updated: assignments.length, distribution, assignments };
  }

  resetAllAccountHealth() {
    const res = this.db.prepare(`
      UPDATE tg_accounts
      SET health_status = 'ready', cooldown_until = 0, last_error = '', updated_at = ?
    `).run(Date.now());
    return Number(res.changes || 0);
  }

  resetAccountHealth(id) {
    this.db.prepare(`
      UPDATE tg_accounts
      SET health_status = 'ready', cooldown_until = 0, last_error = '', updated_at = ?
      WHERE id = ?
    `).run(Date.now(), Number(id));
  }

  deleteAccount(id) {
    this.db.prepare('DELETE FROM active_claims WHERE slot_id = ?').run(Number(id));
    const res = this.db.prepare('DELETE FROM tg_accounts WHERE id = ?').run(Number(id));
    return Number(res.changes || 0) > 0;
  }

  incrementAccountAttempt(id, { failed = false } = {}) {
    if (failed) {
      this.db.prepare('UPDATE tg_accounts SET attempt_count = attempt_count + 1, fail_count = fail_count + 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), Number(id));
    } else {
      this.db.prepare('UPDATE tg_accounts SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), Number(id));
    }
  }

  // ── Atomic Phone Claim Guard (cross-slot deduplication) ────────────────────
  // Guarantees TWO slots out of 50 can NEVER process the same mobile number
  // simultaneously, and no number inside its cooldown is ever reused.
  tryClaimPhone(rawPhone, slotId, { ttlMs = 120_000, now = Date.now(), ignoreAlreadyRegistered = false } = {}) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return { ok: false, reason: 'invalid_phone' };

    return this.withTransaction(() => {
      // 1. Check used_numbers cooldown
      const used = this.db.prepare('SELECT cooldown_until, status FROM used_numbers WHERE phone = ?').get(phone);
      if (used && Number(used.cooldown_until) > now) {
        const allowBypass = Boolean(ignoreAlreadyRegistered) && used.status === 'already_registered';
        if (!allowBypass) {
          return {
            ok: false,
            reason: 'cooldown',
            phone,
            untilMs: Number(used.cooldown_until),
            remainingMs: Math.max(0, Number(used.cooldown_until) - now),
            status: used.status,
          };
        }
      }

      // 2. Clean expired claim for this phone if any
      const existing = this.db.prepare('SELECT slot_id, expires_at FROM active_claims WHERE phone = ?').get(phone);
      if (existing) {
        if (Number(existing.expires_at) > now && Number(existing.slot_id) !== Number(slotId)) {
          return {
            ok: false,
            reason: 'in_flight',
            phone,
            bySlot: Number(existing.slot_id),
            expiresAt: Number(existing.expires_at),
          };
        }
        this.db.prepare('DELETE FROM active_claims WHERE phone = ?').run(phone);
      }

      // 3. Acquire atomic lock
      this.db.prepare(`
        INSERT INTO active_claims (phone, slot_id, stage, claimed_at, expires_at)
        VALUES (?, ?, 'claimed', ?, ?)
      `).run(phone, Number(slotId), now, now + Math.max(15_000, Number(ttlMs) || 120_000));

      return { ok: true, phone };
    });
  }

  updateClaimStage(rawPhone, slotId, stage, { extendTtlMs = 90_000 } = {}) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return;
    this.db.prepare(`
      UPDATE active_claims
      SET stage = ?, expires_at = ?
      WHERE phone = ? AND slot_id = ?
    `).run(String(stage || ''), Date.now() + extendTtlMs, phone, Number(slotId));
  }

  releaseClaim(rawPhone, slotId = null) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return;
    if (slotId !== null && slotId !== undefined) {
      this.db.prepare('DELETE FROM active_claims WHERE phone = ? AND slot_id = ?').run(phone, Number(slotId));
    } else {
      this.db.prepare('DELETE FROM active_claims WHERE phone = ?').run(phone);
    }
  }

  cleanExpiredClaims(now = Date.now()) {
    const res = this.db.prepare('DELETE FROM active_claims WHERE expires_at <= ?').run(now);
    return Number(res.changes || 0);
  }

  clearAllActiveClaims() {
    const res = this.db.prepare('DELETE FROM active_claims').run();
    return Number(res.changes || 0);
  }

  clearTelegramActiveClaims() {
    const res = this.db.prepare('DELETE FROM active_claims WHERE slot_id > 0').run();
    return Number(res.changes || 0);
  }

  getUsedNumber(rawPhone) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return null;
    const row = this.db.prepare('SELECT phone, status, account_key, slot_id, extracted_at, cooldown_until, source FROM used_numbers WHERE phone = ?').get(phone);
    if (!row) return null;
    return {
      phone: row.phone,
      status: row.status || '',
      accountKey: row.account_key || '',
      slotId: Number(row.slot_id || 0),
      extractedAt: Number(row.extracted_at || 0),
      cooldownUntil: Number(row.cooldown_until || 0),
      source: row.source || '',
    };
  }

  isPhoneBlocked(rawPhone, now = Date.now(), { ignoreAlreadyRegistered = false } = {}) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return true;
    const used = this.db.prepare('SELECT cooldown_until, status FROM used_numbers WHERE phone = ?').get(phone);
    if (used && Number(used.cooldown_until) > now) {
      const allowBypass = Boolean(ignoreAlreadyRegistered) && used.status === 'already_registered';
      if (!allowBypass) return true;
    }
    const claim = this.db.prepare('SELECT expires_at FROM active_claims WHERE phone = ?').get(phone);
    if (claim && Number(claim.expires_at) > now) return true;
    return false;
  }

  // Persist a blocked/skipped phone (e.g. already_registered for 30d or otp_timeout_cool for 10m)
  // so none of the other 49 slots waste time or OTPs on it!
  markNumberUsed(rawPhone, {
    status = 'already_registered',
    slotId = 0,
    cooldownDays = 30,
    cooldownMs = 0,
    source = 'toing_check',
    accountKey = '',
    now = Date.now(),
  } = {}) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return { ok: false, reason: 'invalid_phone' };
    const effectiveCooldownMs = cooldownMs > 0
      ? Number(cooldownMs)
      : Math.max(1, Number(cooldownDays) || 30) * 24 * 60 * 60 * 1000;
    const cooldownUntil = now + effectiveCooldownMs;

    this.withTransaction(() => {
      this.db.prepare(`
        INSERT INTO used_numbers (phone, status, account_key, slot_id, extracted_at, cooldown_until, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          status = CASE
            WHEN used_numbers.status = 'extracted' AND used_numbers.cooldown_until > excluded.cooldown_until THEN used_numbers.status
            ELSE excluded.status
          END,
          slot_id = excluded.slot_id,
          extracted_at = excluded.extracted_at,
          cooldown_until = MAX(used_numbers.cooldown_until, excluded.cooldown_until),
          source = CASE
            WHEN used_numbers.status = 'extracted' AND used_numbers.cooldown_until > excluded.cooldown_until THEN used_numbers.source
            ELSE excluded.source
          END
      `).run(phone, String(status), String(accountKey || ''), Number(slotId) || 0, now, cooldownUntil, String(source));

      this.db.prepare('DELETE FROM active_claims WHERE phone = ?').run(phone);
    });

    return { ok: true, phone, status, cooldownUntil };
  }

  getCooldownBreakdown(now = Date.now()) {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS cnt
      FROM used_numbers
      WHERE cooldown_until > ?
      GROUP BY status
    `).all(now);

    const out = {
      extracted: 0,
      already_registered: 0,
      suspended: 0,
      seed: 0,
      otp_timeout_cool: 0,
      send_otp_blocked: 0,
      other: 0,
      total: 0,
    };
    for (const r of rows) {
      const k = String(r.status || 'other');
      const n = Number(r.cnt || 0);
      out.total += n;
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        out[k] += n;
      } else {
        out.other += n;
      }
    }
    return out;
  }

  clearCooldownsByStatus(statuses = []) {
    if (statuses === 'all' || (Array.isArray(statuses) && statuses.includes('all'))) {
      const res = this.db.prepare('DELETE FROM used_numbers').run();
      return Number(res.changes || 0);
    }
    const list = (Array.isArray(statuses) ? statuses : [statuses])
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    if (!list.length) return 0;
    const placeholders = list.map(() => '?').join(', ');
    const res = this.db.prepare(`DELETE FROM used_numbers WHERE status IN (${placeholders})`).run(...list);
    return Number(res.changes || 0);
  }

  // ── Atomic Signup Commit (session + cooldown + delivery_queue + metrics) ───
  commitCompletedSignup({
    phone,
    slotId = 0,
    otpBot = '',
    isNew = false,
    exportObj = {},
    fileName = '',
    deliveryChatId = '',
    cooldownDays = 30,
    durationMs = 0,
    now = Date.now(),
  } = {}) {
    const cleanPhone = normalizePhone10(phone || exportObj?.mobile);
    if (!cleanPhone) throw new Error('commitCompletedSignup requires valid 10-digit phone');

    const normalizedExport = {
      mobile: cleanPhone,
      name: String(exportObj?.name || '').trim(),
      token: String(exportObj?.token || '').trim(),
      sid: String(exportObj?.sid || '').trim(),
      tid: String(exportObj?.tid || '').trim(),
      deviceId: String(exportObj?.deviceId || '').trim(),
      customerId: String(exportObj?.customerId || '').trim(),
    };
    const rawJson = JSON.stringify(normalizedExport, null, 2);
    const safeFileName = String(fileName || '').trim() || `toing-${cleanPhone}.json`;
    const cooldownUntil = now + Math.max(1, Number(cooldownDays) || 30) * 24 * 60 * 60 * 1000;
    const accountKey = `toing_${cleanPhone}`;

    const result = this.withTransaction(() => {
      // 1. Save exported session
      const ins = this.db.prepare(`
        INSERT INTO toing_sessions (
          mobile, name, token, sid, tid, device_id, customer_id,
          is_new, slot_id, otp_bot, raw_json, file_name, delivered, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        normalizedExport.mobile,
        normalizedExport.name,
        normalizedExport.token,
        normalizedExport.sid,
        normalizedExport.tid,
        normalizedExport.deviceId,
        normalizedExport.customerId,
        isNew ? 1 : 0,
        Number(slotId) || 0,
        String(otpBot || ''),
        rawJson,
        safeFileName,
        now
      );
      const sessionId = Number(ins.lastInsertRowid);

      // 2. Lock phone in used_numbers for 30-day cooldown
      this.db.prepare(`
        INSERT INTO used_numbers (phone, status, account_key, slot_id, extracted_at, cooldown_until, source)
        VALUES (?, 'extracted', ?, ?, ?, ?, 'toing')
        ON CONFLICT(phone) DO UPDATE SET
          status = 'extracted',
          account_key = excluded.account_key,
          slot_id = excluded.slot_id,
          extracted_at = excluded.extracted_at,
          cooldown_until = excluded.cooldown_until,
          source = 'toing'
      `).run(cleanPhone, accountKey, Number(slotId) || 0, now, cooldownUntil);

      // 3. Release in-flight active claim
      this.db.prepare('DELETE FROM active_claims WHERE phone = ?').run(cleanPhone);

      // 4. Enqueue guaranteed .json delivery (if chatId configured)
      let deliveryId = 0;
      const targetChat = String(deliveryChatId || '').trim();
      if (targetChat) {
        const dq = this.db.prepare(`
          INSERT INTO delivery_queue (session_id, phone, file_name, chat_id, status, attempts, next_retry_at, last_error, created_at, sent_at)
          VALUES (?, ?, ?, ?, 'pending', 0, ?, '', ?, 0)
        `).run(sessionId, cleanPhone, safeFileName, targetChat, now, now);
        deliveryId = Number(dq.lastInsertRowid);
      }

      // 5. Update slot stats
      if (Number(slotId) > 0) {
        this.db.prepare(`
          UPDATE tg_accounts
          SET created_count = created_count + 1,
              attempt_count = attempt_count + 1,
              last_success_at = ?,
              health_status = 'ready',
              last_error = '',
              updated_at = ?
          WHERE id = ?
        `).run(now, now, Number(slotId));
      }

      // 6. Metrics event
      this.db.prepare(`
        INSERT INTO metrics_events (slot_id, kind, duration_ms, created_at)
        VALUES (?, 'success', ?, ?)
      `).run(Number(slotId) || 0, Math.max(0, Number(durationMs) || 0), now);

      return { sessionId, deliveryId, fileName: safeFileName, rawJson, exportObj: normalizedExport };
    });

    // Write local backup .json file on persistent volume (best-effort)
    if (this.sessionsDir) {
      try {
        const filePath = path.join(this.sessionsDir, result.fileName);
        fs.writeFileSync(filePath, `${result.rawJson}\n`, { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(filePath, 0o600); } catch {}
        result.diskPath = filePath;
      } catch {}
    }

    return result;
  }

  recordMetric(slotId, kind, durationMs = 0, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO metrics_events (slot_id, kind, duration_ms, created_at)
      VALUES (?, ?, ?, ?)
    `).run(Number(slotId) || 0, String(kind || 'unknown'), Math.max(0, Number(durationMs) || 0), now);
  }

  recordNumberEvent({
    slotId = 0,
    slotNo = 0,
    phone = '',
    otpBot = '',
    outcome = 'skip',
    reason = 'unknown',
    detail = '',
    durationMs = 0,
    now = Date.now(),
  } = {}) {
    this.db.prepare(`
      INSERT INTO number_events (slot_id, slot_no, phone, otp_bot, outcome, reason, detail, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(slotId) || 0,
      Number(slotNo) || 0,
      String(phone || '').slice(0, 20),
      String(otpBot || '').slice(0, 24),
      String(outcome || 'skip').slice(0, 24),
      String(reason || 'unknown').slice(0, 64),
      String(detail || '').slice(0, 220),
      Math.max(0, Number(durationMs) || 0),
      now
    );
  }

  getRecentNumberEvents(limit = 30) {
    return this.db.prepare(`
      SELECT id, slot_id, slot_no, phone, otp_bot, outcome, reason, detail, duration_ms, created_at
      FROM number_events
      ORDER BY id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit) || 30))).map((r) => ({ ...r }));
  }

  getNumberEventSummary(windowMs = 5 * 60_000, now = Date.now()) {
    const since = now - Math.max(1_000, Number(windowMs) || 5 * 60_000);
    const rows = this.db.prepare(`
      SELECT outcome, reason, COUNT(*) AS c
      FROM number_events
      WHERE created_at >= ?
      GROUP BY outcome, reason
      ORDER BY c DESC
    `).all(since);
    const byReason = {};
    let total = 0;
    for (const r of rows) {
      const c = Number(r.c || 0);
      total += c;
      byReason[String(r.reason)] = (byReason[String(r.reason)] || 0) + c;
    }
    return { total, windowSec: Math.round(windowMs / 1000), byReason, rows: rows.map((r) => ({ ...r })) };
  }

  pruneOldMetrics(maxAgeMs = 24 * 60 * 60_000) {
    const cutoff = Date.now() - maxAgeMs;
    this.db.prepare('DELETE FROM metrics_events WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM number_events WHERE created_at < ?').run(cutoff);
    // Keep number_events bounded to latest 5,000 rows even under heavy throughput
    this.db.prepare(`
      DELETE FROM number_events
      WHERE id NOT IN (SELECT id FROM number_events ORDER BY id DESC LIMIT 5000)
    `).run();
  }

  // ── Delivery Queue ─────────────────────────────────────────────────────────
  getNextPendingDelivery(now = Date.now()) {
    const row = this.db.prepare(`
      SELECT dq.id, dq.session_id, dq.phone, dq.file_name, dq.chat_id, dq.attempts,
             ts.raw_json, ts.is_new, ts.slot_id, ts.otp_bot, ts.name, ts.token, ts.customer_id,
             ta.slot_no
      FROM delivery_queue dq
      JOIN toing_sessions ts ON ts.id = dq.session_id
      LEFT JOIN tg_accounts ta ON ta.id = ts.slot_id
      WHERE dq.status = 'pending' AND dq.next_retry_at <= ?
      ORDER BY dq.id ASC
      LIMIT 1
    `).get(now);
    return row ? { ...row } : null;
  }

  markDeliverySent(deliveryId, sessionId, now = Date.now()) {
    this.withTransaction(() => {
      this.db.prepare(`
        UPDATE delivery_queue SET status = 'sent', sent_at = ?, last_error = '' WHERE id = ?
      `).run(now, Number(deliveryId));
      this.db.prepare(`
        UPDATE toing_sessions SET delivered = 1 WHERE id = ?
      `).run(Number(sessionId));
    });
  }

  markDeliveryRetry(deliveryId, { delayMs = 5_000, error = '', maxAttempts = 12 } = {}) {
    const row = this.db.prepare('SELECT attempts FROM delivery_queue WHERE id = ?').get(Number(deliveryId));
    const attempts = Number(row?.attempts || 0) + 1;
    const status = attempts >= maxAttempts ? 'failed' : 'pending';
    const nextRetry = Date.now() + Math.max(1_000, Number(delayMs) || 5_000);
    this.db.prepare(`
      UPDATE delivery_queue
      SET status = ?, attempts = ?, next_retry_at = ?, last_error = ?
      WHERE id = ?
    `).run(status, attempts, nextRetry, String(error || '').slice(0, 220), Number(deliveryId));
    return { status, attempts };
  }

  requeueFailedDeliveries(chatId = '') {
    const now = Date.now();
    if (chatId) {
      const res = this.db.prepare(`
        UPDATE delivery_queue
        SET status = 'pending', attempts = 0, next_retry_at = ?, chat_id = ?
        WHERE status = 'failed'
      `).run(now, String(chatId));
      return Number(res.changes || 0);
    }
    const res = this.db.prepare(`
      UPDATE delivery_queue
      SET status = 'pending', attempts = 0, next_retry_at = ?
      WHERE status = 'failed'
    `).run(now);
    return Number(res.changes || 0);
  }

  getDeliveryStats() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS c FROM delivery_queue GROUP BY status
    `).all();
    const out = { pending: 0, sent: 0, failed: 0 };
    for (const r of rows) out[r.status] = Number(r.c || 0);
    return out;
  }

  // ── Session Queries & Export ───────────────────────────────────────────────
  getRecentSessions(limit = 50) {
    return this.db.prepare(`
      SELECT id, mobile, name, token, sid, tid, device_id, customer_id,
             is_new, slot_id, otp_bot, raw_json, file_name, delivered, created_at
      FROM toing_sessions
      ORDER BY id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(5000, Number(limit) || 50))).map((r) => ({ ...r }));
  }

  getSessionByPhone(rawPhone) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return null;
    const row = this.db.prepare(`
      SELECT * FROM toing_sessions WHERE mobile = ? ORDER BY id DESC LIMIT 1
    `).get(phone);
    return row ? { ...row } : null;
  }

  getThroughputStats(now = Date.now()) {
    const m1 = now - 60_000;
    const m5 = now - 5 * 60_000;
    const m15 = now - 15 * 60_000;
    const h1 = now - 60 * 60_000;

    const countSince = (ts, kind = 'success') => Number(
      this.db.prepare('SELECT COUNT(*) AS c FROM metrics_events WHERE kind = ? AND created_at >= ?').get(kind, ts)?.c || 0
    );

    const last1m = countSince(m1, 'success');
    const last5m = countSince(m5, 'success');
    const last15m = countSince(m15, 'success');
    const last1h = countSince(h1, 'success');

    const timeouts5m = countSince(m5, 'otp_timeout');
    const sendFails5m = countSince(m5, 'send_otp_fail');
    const verifyFails5m = countSince(m5, 'verify_fail');
    const alreadyRegistered5m = countSince(m5, 'already_registered_skip');
    const duplicateSkips5m = countSince(m5, 'duplicate_skip');
    const checkFails5m = countSince(m5, 'check_mobile_fail');
    const totalAttempts5m = last5m + timeouts5m + sendFails5m + verifyFails5m;

    const avgRow = this.db.prepare(`
      SELECT AVG(duration_ms) AS avg_ms
      FROM metrics_events
      WHERE kind = 'success' AND created_at >= ? AND duration_ms > 0
    `).get(m15);

    const totalSessions = Number(this.db.prepare('SELECT COUNT(*) AS c FROM toing_sessions').get()?.c || 0);
    const usedActive = Number(this.db.prepare('SELECT COUNT(*) AS c FROM used_numbers WHERE cooldown_until > ?').get(now)?.c || 0);
    const activeClaims = Number(this.db.prepare('SELECT COUNT(*) AS c FROM active_claims WHERE expires_at > ?').get(now)?.c || 0);

    return {
      last1m,
      rate1m: last1m,
      rate5m: Number((last5m / 5).toFixed(1)),
      rate15m: Number((last15m / 15).toFixed(1)),
      last1h,
      hitRate5m: totalAttempts5m > 0 ? Math.round((last5m / totalAttempts5m) * 100) : 0,
      timeouts5m,
      sendFails5m,
      verifyFails5m,
      alreadyRegistered5m,
      duplicateSkips5m,
      checkFails5m,
      avgSignupSec: avgRow?.avg_ms ? Number((Number(avgRow.avg_ms) / 1000).toFixed(1)) : 0,
      totalSessions,
      usedActive,
      activeClaims,
    };
  }

  // ── Firebase Realtime DB Sources (Multi-Source Pool + Health Quarantine) ──
  _hydrateFirebaseRow(row) {
    if (!row) return null;
    let auth = '';
    if (row.auth_enc) {
      try {
        auth = decryptSecret(row.auth_enc, this.masterKey);
      } catch {
        auth = '';
      }
    }
    return {
      id: String(row.id),
      name: String(row.name || ''),
      url: String(row.url || ''),
      auth,
      hasAuth: Boolean(auth),
      clientsPath: String(row.clients_path || 'clients'),
      messagesPath: String(row.messages_path || 'messages'),
      numbersPath: String(row.numbers_path || ''),
      smsPath: String(row.sms_path || 'sms'),
      otpPath: String(row.otp_path || 'otp'),
      primary: Boolean(row.is_primary),
      builtin: Boolean(row.builtin),
      okCount: Number(row.ok_count || 0),
      failCount: Number(row.fail_count || 0),
      failStreak: Number(row.fail_streak || 0),
      emptyStreak: Number(row.empty_streak || 0),
      lastOkAt: Number(row.last_ok_at || 0),
      lastFailAt: Number(row.last_fail_at || 0),
      lastError: String(row.last_error || ''),
      latencyMs: Number(row.latency_ms || 0),
      quarantinedUntil: Number(row.quarantined_until || 0),
      addedAt: Number(row.added_at || 0),
      otpOkCount: Number(row.otp_ok_count || 0),
      otpFailCount: Number(row.otp_fail_count || 0),
      otpFailStreak: Number(row.otp_fail_streak || 0),
      otpLastOkAt: Number(row.otp_last_ok_at || 0),
      otpQuarantinedUntil: Number(row.otp_quarantined_until || 0),
      otpBestLatencyMs: Number(row.otp_best_latency_ms || 0),
    };
  }

  _newFirebaseSourceId() {
    for (let i = 0; i < 10; i++) {
      const id = crypto.randomUUID().slice(0, 8);
      const exists = this.db.prepare('SELECT 1 FROM firebase_sources WHERE id = ?').get(id);
      if (!exists) return id;
    }
    return crypto.randomUUID().slice(0, 12);
  }

  seedFirebaseSources({
    builtinUrls = BUILTIN_FIREBASE_SOURCE_URLS,
    envUrls = [],
    defaultUrl = DEFAULT_FIREBASE_URL,
    defaultAuth = '',
    seedVersion = BUILTIN_FIREBASE_SEED_VERSION,
  } = {}) {
    const cleared = Boolean(this.getSetting('firebaseSourcesCleared', false));
    const currentSeedVer = Number(this.getSetting('firebaseSeedVersion', 0)) || 0;
    const shouldSeedBuiltin = !cleared && currentSeedVer < seedVersion;

    const deletedRows = this.db.prepare('SELECT url_key FROM firebase_deleted_urls').all();
    const deletedSet = new Set(deletedRows.map((r) => String(r.url_key || '')));

    const existingRows = this.db.prepare('SELECT id, url, is_primary, builtin FROM firebase_sources').all();
    const existingKeys = new Set(existingRows.map((r) => normalizeSourceUrl(r.url)));
    let hasPrimary = existingRows.some((r) => Number(r.is_primary) === 1);

    const candidates = [];
    const builtinList = (builtinUrls || []).filter(Boolean);
    // Default (env FIREBASE_DB_URL) sirf tab use hota hai jab koi built-in
    // ranked list na ho. Warna purana default (vuvhbjbi) nayi list ke saath
    // wapas aa jaata — owner ne purane URLs erase karne ko kaha hai. Naye
    // custom URLs ke liye env FIREBASE_DB_URLS (envUrls) hai.
    if (defaultUrl && builtinList.length === 0 && !cleared && existingRows.length === 0) {
      candidates.push({ url: defaultUrl, auth: defaultAuth, builtin: true, preferredPrimary: true });
    }
    if (shouldSeedBuiltin) {
      for (const u of builtinList) {
        candidates.push({ url: u, auth: '', builtin: true, preferredPrimary: false });
      }
    }
    for (const item of envUrls || []) {
      if (typeof item === 'string') {
        candidates.push({ url: item, auth: '', builtin: false, preferredPrimary: false });
      } else if (item && item.url) {
        candidates.push({ url: item.url, auth: item.auth || '', builtin: false, preferredPrimary: false });
      }
    }

    // Naya seed version aane par PURANI built-in list ko hata do. Owner ne
    // bola tha: "purane Firebase URLs erase karke naye lagao". Sirf woh rows
    // hatate hain jo (a) builtin=1 hain (yaani khud code se seed hui thi) aur
    // (b) nayi list me nahi hain. Owner ke manually add kiye hue custom
    // sources safe rehte hain.
    const nextKeys = new Set();
    for (const c of candidates) {
      const v = validateFirebaseSourceInput(c);
      if (v.ok) nextKeys.add(normalizeSourceUrl(v.src.url));
    }
    const staleBuiltinIds = shouldSeedBuiltin
      ? existingRows
        .filter((r) => Number(r.builtin) === 1 && !nextKeys.has(normalizeSourceUrl(r.url)))
        .map((r) => r.id)
      : [];

    let added = 0;
    let removedBuiltin = 0;
    const now = Date.now();
    this.withTransaction(() => {
      if (staleBuiltinIds.length) {
        const del = this.db.prepare('DELETE FROM firebase_sources WHERE id = ? AND builtin = 1');
        for (const id of staleBuiltinIds) {
          const res = del.run(id);
          removedBuiltin += Number(res.changes || 0);
          existingKeys.delete(normalizeSourceUrl(existingRows.find((r) => r.id === id).url));
        }
        hasPrimary = Boolean(this.db.prepare('SELECT 1 FROM firebase_sources WHERE is_primary = 1 LIMIT 1').get());
      }

      const ins = this.db.prepare(`
        INSERT OR IGNORE INTO firebase_sources (
          id, name, url, auth_enc, clients_path, messages_path, numbers_path, sms_path, otp_path,
          is_primary, builtin, added_at
        ) VALUES (?, ?, ?, ?, 'clients', 'messages', '', 'sms', 'otp', ?, ?, ?)
      `);

      for (const c of candidates) {
        const v = validateFirebaseSourceInput(c);
        if (!v.ok) continue;
        const key = normalizeSourceUrl(v.src.url);
        if (!key || existingKeys.has(key) || deletedSet.has(key)) continue;
        const isPrimary = (!hasPrimary && (c.preferredPrimary || added === 0)) ? 1 : 0;
        if (isPrimary) hasPrimary = true;
        const authEnc = v.src.auth ? encryptSecret(v.src.auth, this.masterKey) : '';
        ins.run(
          this._newFirebaseSourceId(),
          v.src.name,
          v.src.url,
          authEnc,
          isPrimary,
          c.builtin ? 1 : 0,
          now
        );
        existingKeys.add(key);
        added += 1;
      }

      if (!hasPrimary) {
        const first = this.db.prepare('SELECT id FROM firebase_sources ORDER BY added_at ASC, rowid ASC LIMIT 1').get();
        if (first) {
          this.db.prepare('UPDATE firebase_sources SET is_primary = 1 WHERE id = ?').run(first.id);
        }
      }
    });

    if (shouldSeedBuiltin) {
      this.setSetting('firebaseSeedVersion', seedVersion);
    }

    const total = Number(this.db.prepare('SELECT COUNT(*) AS c FROM firebase_sources').get()?.c || 0);
    return { added, removedBuiltin, total, skippedByClear: cleared };
  }

  listFirebaseSources() {
    const rows = this.db.prepare(`
      SELECT * FROM firebase_sources
      ORDER BY is_primary DESC, rowid ASC
    `).all();
    return rows.map((r) => this._hydrateFirebaseRow(r));
  }

  // Health-ranked run order:
  //   tier 0 = proven OTP delivery (a real OTP landed in its inbox) — best
  //   tier 1 = proven readable but OTP never confirmed yet
  //   tier 2 = never tried / untested (not quarantined)
  //   tier 3 = quarantined (bad read OR repeated OTP non-delivery)
  // Primary source comes first within its tier!
  listFirebaseRunSources(now = Date.now()) {
    const all = this.listFirebaseSources();
    const rankOf = (s) => {
      const otpDead = Number(s.otpQuarantinedUntil) > now;
      const readDead = Number(s.quarantinedUntil) > now;
      if (otpDead || readDead) return 3;
      if (Number(s.otpLastOkAt) > 0) return 0;
      if (Number(s.lastOkAt) > 0) return 1;
      return 2;
    };
    return all
      .map((s, idx) => ({ s, idx, rank: rankOf(s) }))
      .sort((a, b) => (a.rank - b.rank) || ((b.s.primary ? 1 : 0) - (a.s.primary ? 1 : 0)) || (a.idx - b.idx))
      .map((x) => x.s);
  }

  getFirebaseSource(id) {
    const row = this.db.prepare('SELECT * FROM firebase_sources WHERE id = ?').get(String(id || ''));
    return this._hydrateFirebaseRow(row);
  }

  getFirebaseHealthSummary(now = Date.now()) {
    const rows = this.db.prepare(`
      SELECT ok_count, fail_count, last_ok_at, quarantined_until,
             otp_ok_count, otp_fail_count, otp_last_ok_at, otp_quarantined_until
      FROM firebase_sources
    `).all();
    let live = 0;
    let quarantined = 0;
    let failed = 0;
    let neverTried = 0;
    let otpProven = 0;
    let otpDead = 0;
    for (const r of rows) {
      const otpOk = Number(r.otp_ok_count || 0);
      const otpFail = Number(r.otp_fail_count || 0);
      if (otpOk > 0) otpProven += 1;
      if (Number(r.otp_quarantined_until) > now) {
        quarantined += 1;
        otpDead += 1;
        continue;
      }
      if (Number(r.quarantined_until) > now) quarantined += 1;
      else if (Number(r.fail_count) > 0 && !Number(r.ok_count)) failed += 1;
      else if (!Number(r.ok_count) && !Number(r.fail_count)) neverTried += 1;
      else live += 1;
      if (otpFail >= FIREBASE_OTP_FAIL_THRESHOLD && !otpOk) otpDead += 1;
    }
    return { total: rows.length, live, failed, quarantined, neverTried, otpProven, otpDead };
  }

  addFirebaseSourcesBulk(rawInput, { setFirstAsPrimary = false } = {}) {
    let parsed = { entries: [], invalid: [] };
    if (typeof rawInput === 'string') {
      parsed = parseFirebaseSourceBulkInput(rawInput);
    } else if (Array.isArray(rawInput)) {
      for (const item of rawInput) {
        if (typeof item === 'string') {
          const one = parseFirebaseSourceBulkInput(item);
          parsed.entries.push(...one.entries);
          parsed.invalid.push(...one.invalid);
        } else if (item && typeof item === 'object') {
          parsed.entries.push(item);
        }
      }
    }

    const requested = parsed.entries.length + parsed.invalid.length;
    const invalid = [...parsed.invalid];
    const candidates = parsed.entries.slice(0, MAX_BULK_FIREBASE_SOURCES);
    for (const extra of parsed.entries.slice(MAX_BULK_FIREBASE_SOURCES)) {
      invalid.push({
        input: String(extra?.url || '').slice(0, 100),
        error: `ek baar me max ${MAX_BULK_FIREBASE_SOURCES} Firebase add ho sakte hain`,
      });
    }

    const existingRows = this.db.prepare('SELECT id, url FROM firebase_sources').all();
    const byUrl = new Map(existingRows.map((r) => [normalizeSourceUrl(r.url), r]));
    const added = [];
    const duplicates = [];
    const now = Date.now();

    this.withTransaction(() => {
      const ins = this.db.prepare(`
        INSERT INTO firebase_sources (
          id, name, url, auth_enc, clients_path, messages_path, numbers_path, sms_path, otp_path,
          is_primary, builtin, added_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      `);
      const delRemoved = this.db.prepare('DELETE FROM firebase_deleted_urls WHERE url_key = ?');

      for (const c of candidates) {
        const v = validateFirebaseSourceInput(c || {});
        if (!v.ok) {
          invalid.push({ input: String(c?.url || '').slice(0, 100), error: v.error });
          continue;
        }
        const key = normalizeSourceUrl(v.src.url);
        if (byUrl.has(key)) {
          duplicates.push({ id: byUrl.get(key).id, url: v.src.url });
          continue;
        }
        const id = this._newFirebaseSourceId();
        const authEnc = v.src.auth ? encryptSecret(v.src.auth, this.masterKey) : '';
        ins.run(
          id,
          v.src.name,
          v.src.url,
          authEnc,
          v.src.clientsPath,
          v.src.messagesPath,
          v.src.numbersPath,
          v.src.smsPath,
          v.src.otpPath,
          now
        );
        delRemoved.run(key);
        byUrl.set(key, { id, url: v.src.url });
        added.push({ id, name: v.src.name, url: v.src.url });
      }

      if (added.length) {
        const hasPrimary = this.db.prepare('SELECT 1 FROM firebase_sources WHERE is_primary = 1 LIMIT 1').get();
        if (setFirstAsPrimary || !hasPrimary) {
          this.db.prepare('UPDATE firebase_sources SET is_primary = 0').run();
          this.db.prepare('UPDATE firebase_sources SET is_primary = 1 WHERE id = ?').run(added[0].id);
        }
      }
    });

    if (added.length) {
      this.setSetting('firebaseSourcesCleared', false);
    }

    const total = Number(this.db.prepare('SELECT COUNT(*) AS c FROM firebase_sources').get()?.c || 0);
    return {
      ok: added.length > 0,
      added,
      duplicates,
      invalid,
      requested,
      total,
    };
  }

  setPrimaryFirebaseSource(id) {
    const existing = this.db.prepare('SELECT id FROM firebase_sources WHERE id = ?').get(String(id || ''));
    if (!existing) return { ok: false, error: 'Source nahi mila.' };
    this.withTransaction(() => {
      this.db.prepare('UPDATE firebase_sources SET is_primary = 0').run();
      this.db.prepare('UPDATE firebase_sources SET is_primary = 1 WHERE id = ?').run(existing.id);
    });
    return { ok: true, source: this.getFirebaseSource(existing.id) };
  }

  removeFirebaseSource(id) {
    const row = this.db.prepare('SELECT id, url, is_primary FROM firebase_sources WHERE id = ?').get(String(id || ''));
    if (!row) return { ok: false, error: 'Source nahi mila.' };
    const now = Date.now();
    this.withTransaction(() => {
      this.db.prepare('DELETE FROM firebase_sources WHERE id = ?').run(row.id);
      const key = normalizeSourceUrl(row.url);
      if (key) {
        this.db.prepare('INSERT OR REPLACE INTO firebase_deleted_urls (url_key, deleted_at) VALUES (?, ?)').run(key, now);
      }
      if (Number(row.is_primary) === 1) {
        const next = this.db.prepare('SELECT id FROM firebase_sources ORDER BY added_at ASC, rowid ASC LIMIT 1').get();
        if (next) this.db.prepare('UPDATE firebase_sources SET is_primary = 1 WHERE id = ?').run(next.id);
      }
    });
    return { ok: true };
  }

  removeAllFirebaseSources(extraKnownUrls = BUILTIN_FIREBASE_SOURCE_URLS) {
    const existing = this.db.prepare('SELECT url FROM firebase_sources').all();
    const now = Date.now();
    const urls = new Set();
    for (const r of existing) urls.add(normalizeSourceUrl(r.url));
    for (const u of extraKnownUrls || []) urls.add(normalizeSourceUrl(u));
    urls.add(normalizeSourceUrl(DEFAULT_FIREBASE_URL));
    urls.delete('');

    this.withTransaction(() => {
      this.db.prepare('DELETE FROM firebase_sources').run();
      const insDel = this.db.prepare('INSERT OR REPLACE INTO firebase_deleted_urls (url_key, deleted_at) VALUES (?, ?)');
      for (const key of urls) insDel.run(key, now);
    });
    this.setSetting('firebaseSourcesCleared', true);
    this.setSetting('firebaseSeedVersion', BUILTIN_FIREBASE_SEED_VERSION);
    return { ok: true, removed: existing.length, remembered: urls.size };
  }

  recordFirebaseSourceResult(id, { ok = false, error = '', ms = 0, empty = false, now = Date.now() } = {}) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM firebase_sources WHERE id = ?').get(String(id));
    if (!row) return null;

    let okCount = Number(row.ok_count || 0);
    let failCount = Number(row.fail_count || 0);
    let failStreak = Number(row.fail_streak || 0);
    let emptyStreak = Number(row.empty_streak || 0);
    let lastOkAt = Number(row.last_ok_at || 0);
    let lastFailAt = Number(row.last_fail_at || 0);
    let lastError = String(row.last_error || '');
    let latencyMs = Number(row.latency_ms || 0);
    let quarantinedUntil = Number(row.quarantined_until || 0);

    if (ok) {
      okCount += 1;
      failStreak = 0;
      emptyStreak = 0;
      lastOkAt = now;
      lastError = '';
      if (Number(ms) > 0) latencyMs = Math.round(Number(ms));
      quarantinedUntil = 0;
    } else {
      failCount += 1;
      lastFailAt = now;
      lastError = String(error || (empty ? 'khali pool' : 'fail')).slice(0, 160);
      if (empty) {
        emptyStreak += 1;
        failStreak = 0;
        if (emptyStreak >= FIREBASE_FAIL_THRESHOLD) quarantinedUntil = now + FIREBASE_QUARANTINE_MS;
      } else {
        failStreak += 1;
        emptyStreak = 0;
        if (failStreak >= FIREBASE_FAIL_THRESHOLD) quarantinedUntil = now + FIREBASE_QUARANTINE_MS;
      }
    }

    this.db.prepare(`
      UPDATE firebase_sources
      SET ok_count = ?, fail_count = ?, fail_streak = ?, empty_streak = ?,
          last_ok_at = ?, last_fail_at = ?, last_error = ?, latency_ms = ?, quarantined_until = ?
      WHERE id = ?
    `).run(okCount, failCount, failStreak, emptyStreak, lastOkAt, lastFailAt, lastError, latencyMs, quarantinedUntil, row.id);

    return this.getFirebaseSource(row.id);
  }

  resetFirebaseSourceHealth(ids = null) {
    const clearDevices = () => this.db.prepare('DELETE FROM firebase_devices').run();
    if (!ids) {
      clearDevices();
      const res = this.db.prepare(`
        UPDATE firebase_sources
        SET fail_streak = 0, empty_streak = 0, fail_count = 0, last_error = '', quarantined_until = 0,
            otp_fail_streak = 0, otp_fail_count = 0, otp_ok_count = 0, otp_last_ok_at = 0,
            otp_quarantined_until = 0, otp_best_latency_ms = 0
      `).run();
      return Number(res.changes || 0);
    }
    const list = [].concat(ids).map((x) => String(x || '')).filter(Boolean);
    if (!list.length) return 0;
    const placeholders = list.map(() => '?').join(', ');
    const res = this.db.prepare(`
      UPDATE firebase_sources
      SET fail_streak = 0, empty_streak = 0, fail_count = 0, last_error = '', quarantined_until = 0,
          otp_fail_streak = 0, otp_fail_count = 0, otp_ok_count = 0, otp_last_ok_at = 0,
          otp_quarantined_until = 0, otp_best_latency_ms = 0
      WHERE id IN (${placeholders})
    `).run(...list);
    try {
      this.db.prepare(`DELETE FROM firebase_devices WHERE source_key IN (${placeholders})`).run(...list);
    } catch {}
    return Number(res.changes || 0);
  }

  // ── OTP delivery health (real proof a panel forwards SMS) ─────────────────
  // Loading a pool only proves the DB is readable. These counters answer the
  // only question that matters: "is an OTP actually arriving in its inbox?"
  recordFirebaseOtpResult(id, { ok = false, sourceKey = '', deviceId = '', latencyMs = 0, now = Date.now() } = {}) {
    if (!id && !sourceKey) return null;

    if (id) {
      const row = this.db.prepare('SELECT * FROM firebase_sources WHERE id = ?').get(String(id));
      if (row) {
        let otpOk = Number(row.otp_ok_count || 0);
        let otpFail = Number(row.otp_fail_count || 0);
        let otpStreak = Number(row.otp_fail_streak || 0);
        let otpLastOk = Number(row.otp_last_ok_at || 0);
        let otpQuar = Number(row.otp_quarantined_until || 0);
        let otpBest = Number(row.otp_best_latency_ms || 0);

        if (ok) {
          otpOk += 1;
          otpStreak = 0;
          otpLastOk = now;
          otpQuar = 0;
          if (Number(latencyMs) > 0 && (!otpBest || Number(latencyMs) < otpBest)) {
            otpBest = Math.round(Number(latencyMs));
          }
        } else {
          otpFail += 1;
          otpStreak += 1;
          if (otpStreak >= FIREBASE_OTP_FAIL_THRESHOLD) {
            otpQuar = now + FIREBASE_OTP_QUARANTINE_MS;
            otpStreak = 0;
          }
        }

        this.db.prepare(`
          UPDATE firebase_sources
          SET otp_ok_count = ?, otp_fail_count = ?, otp_fail_streak = ?,
              otp_last_ok_at = ?, otp_quarantined_until = ?, otp_best_latency_ms = ?
          WHERE id = ?
        `).run(otpOk, otpFail, otpStreak, otpLastOk, otpQuar, otpBest, row.id);
      }
    }

    const key = String(sourceKey || this.getFirebaseSource(id)?.url || '').trim().toLowerCase();
    if (key && deviceId) {
      const dev = this.db.prepare('SELECT * FROM firebase_devices WHERE source_key = ? AND device_id = ?')
        .get(key, String(deviceId));
      let okCount = Number(dev?.otp_ok || 0);
      let failCount = Number(dev?.otp_fail || 0);
      let streak = Number(dev?.fail_streak || 0);
      let lastOk = Number(dev?.last_ok_at || 0);
      let lastFail = Number(dev?.last_fail_at || 0);
      let quar = Number(dev?.quarantined_until || 0);
      let devLatency = Number(dev?.last_ok_latency_ms || 0);

      if (ok) {
        okCount += 1;
        streak = 0;
        lastOk = now;
        quar = 0;
        if (Number(latencyMs) > 0) devLatency = Math.round(Number(latencyMs));
      } else {
        failCount += 1;
        streak += 1;
        lastFail = now;
        if (streak >= FIREBASE_DEVICE_FAIL_THRESHOLD) {
          quar = now + FIREBASE_DEVICE_QUARANTINE_MS;
          streak = 0;
        }
      }

      this.db.prepare(`
        INSERT INTO firebase_devices
          (source_key, device_id, otp_ok, otp_fail, fail_streak, last_ok_at, last_fail_at,
           last_ok_latency_ms, quarantined_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key, device_id) DO UPDATE SET
          otp_ok = excluded.otp_ok, otp_fail = excluded.otp_fail, fail_streak = excluded.fail_streak,
          last_ok_at = excluded.last_ok_at, last_fail_at = excluded.last_fail_at,
          last_ok_latency_ms = excluded.last_ok_latency_ms,
          quarantined_until = excluded.quarantined_until
      `).run(key, String(deviceId), okCount, failCount, streak, lastOk, lastFail, devLatency, quar);
    }

    return id ? this.getFirebaseSource(id) : null;
  }

  getFirebaseDeviceStat(sourceOrUrl, deviceId) {
    const key = normalizeSourceUrl(typeof sourceOrUrl === 'string' ? sourceOrUrl : sourceOrUrl?.url);
    if (!key || !deviceId) return null;
    const row = this.db.prepare(
      'SELECT * FROM firebase_devices WHERE source_key = ? AND device_id = ?'
    ).get(key, String(deviceId));
    if (!row) return null;
    return {
      deviceId: String(row.device_id),
      otpOk: Number(row.otp_ok || 0),
      otpFail: Number(row.otp_fail || 0),
      failStreak: Number(row.fail_streak || 0),
      lastOkAt: Number(row.last_ok_at || 0),
      lastFailAt: Number(row.last_fail_at || 0),
      lastOkLatencyMs: Number(row.last_ok_latency_ms || 0),
      quarantinedUntil: Number(row.quarantined_until || 0),
    };
  }

  // Devices whose inbox has repeatedly failed to deliver -> skip them entirely.
  listQuarantinedDevices(sourceOrUrl, now = Date.now()) {
    const key = normalizeSourceUrl(typeof sourceOrUrl === 'string' ? sourceOrUrl : sourceOrUrl?.url);
    if (!key) return new Set();
    const rows = this.db.prepare(`
      SELECT device_id FROM firebase_devices
      WHERE source_key = ? AND quarantined_until > ?
    `).all(key, now);
    return new Set(rows.map((r) => String(r.device_id)));
  }

  listDeadDevices(sourceOrUrl) {
    const key = normalizeSourceUrl(typeof sourceOrUrl === 'string' ? sourceOrUrl : sourceOrUrl?.url);
    if (!key) return new Set();
    const rows = this.db.prepare(`
      SELECT device_id FROM firebase_devices
      WHERE source_key = ? AND fail_streak >= ?
    `).all(key, FIREBASE_DEVICE_FAIL_THRESHOLD);
    return new Set(rows.map((r) => String(r.device_id)));
  }

  getDeviceOtpStats(sourceOrUrl) {
    const key = normalizeSourceUrl(typeof sourceOrUrl === 'string' ? sourceOrUrl : sourceOrUrl?.url);
    if (!key) return { total: 0, ok: 0, fail: 0, quarantined: 0 };
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN otp_ok > 0 THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN otp_fail > 0 AND otp_ok = 0 THEN 1 ELSE 0 END) AS fail,
             SUM(CASE WHEN quarantined_until > ? THEN 1 ELSE 0 END) AS quarantined
      FROM firebase_devices WHERE source_key = ?
    `).get(Date.now(), key);
    return {
      total: Number(row?.total || 0),
      ok: Number(row?.ok || 0),
      fail: Number(row?.fail || 0),
      quarantined: Number(row?.quarantined || 0),
    };
  }
}

// Parse flexible bulk import text:
//   - JSON array: [{"label":"acc1","otpBot":"hathi","session":"1BV..."}]
//   - Line format:
//       1BVts...                      -> auto label, default bot
//       acc1|1BVts...                 -> label + session
//       acc1|hermes|1BVts...          -> label + otpBot + session
export function parseBulkSessionsInput(rawText = '', { defaultOtpBot = 'hathi' } = {}) {
  const text = String(rawText || '').trim();
  if (!text) return [];

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.accounts) ? parsed.accounts : [parsed]);
      return arr
        .map((item) => {
          if (typeof item === 'string') return { session: item.trim(), otpBot: defaultOtpBot };
          if (!item || typeof item !== 'object') return null;
          const session = String(item.session || item.stringSession || item.TELEGRAM_SESSION || '').trim();
          if (!session) return null;
          return {
            session,
            label: String(item.label || item.name || '').trim(),
            otpBot: normalizeOtpBotProfileId(item.otpBot || item.otp_bot || item.bot || defaultOtpBot),
            apiId: Number(item.apiId || item.api_id || 0) || 0,
            apiHash: String(item.apiHash || item.api_hash || '').trim(),
          };
        })
        .filter(Boolean);
    } catch {
      // fall through to line parser
    }
  }

  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length >= 3) {
      out.push({
        label: parts[0],
        otpBot: normalizeOtpBotProfileId(parts[1] || defaultOtpBot),
        session: parts.slice(2).join('|').trim(),
      });
    } else if (parts.length === 2) {
      // Could be label|session OR bot|session
      const maybeBot = parts[0].toLowerCase();
      if (['hathi', 'hermes', 'chauhan'].includes(maybeBot)) {
        out.push({ label: '', otpBot: maybeBot, session: parts[1] });
      } else {
        out.push({ label: parts[0], otpBot: defaultOtpBot, session: parts[1] });
      }
    } else {
      // Strip optional env prefix like TELEGRAM_SESSION_2=1BV...
      const eqIdx = line.indexOf('=');
      const session = eqIdx > 0 && /^[A-Z0-9_]+$/.test(line.slice(0, eqIdx).trim())
        ? line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
        : line;
      out.push({ label: '', otpBot: defaultOtpBot, session });
    }
  }
  return out;
}

export function bootstrapEnvSessions(db, env = process.env, { defaultOtpBot = 'hathi', maxSlots = 50 } = {}) {
  const candidates = [];
  const rawJson = String(env?.TG_SESSIONS_JSON || '').trim();
  if (rawJson) {
    candidates.push(...parseBulkSessionsInput(rawJson, { defaultOtpBot }));
  }
  for (let i = 0; i < maxSlots; i++) {
    const suffix = i === 0 ? '' : `_${i + 1}`;
    const session = String(env?.[`TELEGRAM_SESSION${suffix}`] || env?.[`TG_SESSION${suffix}`] || '').trim();
    if (!session) continue;
    const apiId = Number(env?.[`TELEGRAM_API_ID${suffix}`] || env?.[`TG_API_ID${suffix}`] || 0) || 0;
    const apiHash = String(env?.[`TELEGRAM_API_HASH${suffix}`] || env?.[`TG_API_HASH${suffix}`] || '').trim();
    const otpBot = String(env?.[`OTP_BOT${suffix}`] || defaultOtpBot).trim();
    candidates.push({
      session,
      label: `Env-${String(i + 1).padStart(2, '0')}`,
      apiId,
      apiHash,
      otpBot,
    });
  }
  if (!candidates.length) return { added: 0, duplicates: 0 };
  const res = db.importAccountsBulk(candidates, { defaultOtpBot, maxSlots });
  return { added: res.added.length, duplicates: res.duplicates.length };
}
