import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptSecret, decryptSecret, resolveMasterKey, sessionFingerprint } from './crypto.js';
import { normalizePhone10 } from './otp-parser.js';
import { normalizeOtpBotProfileId } from './otp-profiles.js';

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
    `);
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
  // simultaneously, and no number inside its 30-day cooldown is ever reused.
  tryClaimPhone(rawPhone, slotId, { ttlMs = 120_000, now = Date.now() } = {}) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return { ok: false, reason: 'invalid_phone' };

    return this.withTransaction(() => {
      // 1. Check 30-day used_numbers cooldown
      const used = this.db.prepare('SELECT cooldown_until, status FROM used_numbers WHERE phone = ?').get(phone);
      if (used && Number(used.cooldown_until) > now) {
        return {
          ok: false,
          reason: 'cooldown',
          phone,
          untilMs: Number(used.cooldown_until),
          status: used.status,
        };
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

  isPhoneBlocked(rawPhone, now = Date.now()) {
    const phone = normalizePhone10(rawPhone);
    if (!phone) return true;
    const used = this.db.prepare('SELECT cooldown_until FROM used_numbers WHERE phone = ?').get(phone);
    if (used && Number(used.cooldown_until) > now) return true;
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
