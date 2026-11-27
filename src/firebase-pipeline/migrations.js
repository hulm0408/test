// ===== Firebase Phone-Registration Pipeline — Migrations =====
// SQLite schema versioning.

export const MIGRATIONS = [
  {
    version: 1,
    name: 'Initial schema: pipeline_numbers, pipeline_keys, pipeline_config, pipeline_migrations',
    sql: `
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
    `
  }
];

export async function applyMigrations(db) {
  const current = db.prepare('SELECT version FROM pipeline_migrations ORDER BY version DESC LIMIT 1').get();
  const currentVersion = current ? current.version : 0;

  for (const mig of MIGRATIONS) {
    if (mig.version > currentVersion) {
      console.log(`🔄 Applying migration v${mig.version}: ${mig.name}`);
      db.exec(mig.sql);
      db.prepare('INSERT INTO pipeline_migrations (version, applied_at) VALUES (?, ?)').run(mig.version, Date.now());
    }
  }
}
