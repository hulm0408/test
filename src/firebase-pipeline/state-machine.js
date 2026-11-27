// ===== Firebase Phone-Registration Pipeline — State Machine (SQLite) =====
// Persistence: SQLite (persisted to SQLite so a crash resumes exactly where it stopped).
// States: pending → assigned → otp_sent → active → registering → registered | failed(code) → retry_queue

import Database from 'better-sqlite3';
import { ERR_DUPLICATE, ERR_INVALID_NUMBER } from './models.ts';
import { normalizeIndianMobileNumber } from '../../phone-utils.js';

export class StateMachine {
  constructor(dbPath = 'data/pipeline.db') {
    // Ensure directory exists
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS pipeline_numbers (
        id TEXT PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        assigned_key_id TEXT,
        otp_code TEXT,
        error TEXT,
        attempts INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_state ON pipeline_numbers(state);

      CREATE TABLE IF NOT EXISTS pipeline_keys (
        id TEXT PRIMARY KEY,
        score INTEGER DEFAULT 100,
        status TEXT DEFAULT 'healthy',
        last_used INTEGER DEFAULT 0,
        usage_count INTEGER DEFAULT 0,
        cap INTEGER DEFAULT 8,
        quarantine_until INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pipeline_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pipeline_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    
    // Check migration version
    const current = this.db.prepare('SELECT version FROM pipeline_migrations ORDER BY version DESC LIMIT 1').get();
    const version = current ? current.version : 0;
    if (version < 1) {
      this._applyMigration1();
    }
  }

  _applyMigration1() {
    const now = Date.now();
    this.db.exec(`
      INSERT INTO pipeline_migrations (version, applied_at) VALUES (1, ${now});
    `);
  }

  // --- Number Operations ---
  async ingestNumber(phoneRaw) {
    const phone = normalizeIndianMobileNumber(phoneRaw);
    if (!phone) return { ok: false, error: ERR_INVALID_NUMBER };

    const now = Date.now();
    const id = `num_${phone}_${now}`;
    
    try {
      this.db.prepare(`
        INSERT INTO pipeline_numbers (id, phone, state, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(id, phone, now, now);
      return { ok: true, id, phone };
    } catch (e) {
      // Duplicate phone check
      const existing = this.db.prepare('SELECT state FROM pipeline_numbers WHERE phone = ?').get(phone);
      if (existing) return { ok: false, error: ERR_DUPLICATE, state: existing.state };
      return { ok: false, error: e.message };
    }
  }

  async transitionState(id, newState, extra = {}) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE pipeline_numbers
      SET state = ?, assigned_key_id = ?, otp_code = ?, error = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      newState,
      extra.assignedKeyId || null,
      extra.otpCode || null,
      extra.error || null,
      now,
      id
    );
    const row = this.db.prepare('SELECT * FROM pipeline_numbers WHERE id = ?').get(id);
    return row ? { ok: true, row } : { ok: false, error: 'Not found' };
  }

  async getNumber(id) {
    const row = this.db.prepare('SELECT * FROM pipeline_numbers WHERE id = ?').get(id);
    return row ? { ok: true, row } : { ok: false, error: 'Not found' };
  }

  async getNumbersByState(state) {
    const rows = this.db.prepare('SELECT * FROM pipeline_numbers WHERE state = ?').all(state);
    return { ok: true, rows };
  }

  // --- Key Operations ---
  async addKey(keyData) {
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO pipeline_keys (id, score, status, last_used, usage_count, cap, quarantine_until, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        keyData.id,
        keyData.score || 100,
        keyData.status || 'healthy',
        keyData.lastUsed || 0,
        keyData.usageCount || 0,
        keyData.cap || 8,
        keyData.quarantineUntil || 0,
        now
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async getKey(id) {
    const row = this.db.prepare('SELECT * FROM pipeline_keys WHERE id = ?').get(id);
    return row ? { ok: true, row } : { ok: false, error: 'Not found' };
  }

  async getAllKeys() {
    const rows = this.db.prepare('SELECT * FROM pipeline_keys').all();
    return { ok: true, rows };
  }

  async updateKeyScore(id, score, status, quarantineUntil = 0) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE pipeline_keys
      SET score = ?, status = ?, last_used = ?, quarantine_until = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(score, status, now, quarantineUntil, now, id);
    return { ok: true };
  }

  // --- Config ---
  setConfig(key, value) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO pipeline_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run(key, JSON.stringify(value), now);
    return { ok: true };
  }

  getConfig(key) {
    const row = this.db.prepare('SELECT value FROM pipeline_config WHERE key = ?').get(key);
    if (!row) return { ok: false, error: 'Not found' };
    try {
      return { ok: true, value: JSON.parse(row.value) };
    } catch {
      return { ok: true, value: row.value };
    }
  }

  close() {
    this.db.close();
  }
}
