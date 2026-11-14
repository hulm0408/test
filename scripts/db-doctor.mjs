#!/usr/bin/env node
// ============================================================================
// scripts/db-doctor.mjs — 💾 Database ka health report
// ============================================================================
//
// Kaam: batata hai ki bot ka DB linked hai ya nahi, linked store reachable
// hai ya nahi, aur restart ke baad data bachega ya nahi.
//
//   npm run doctor            → report
//   npm run doctor -- --verify → report + live write/read-back probe
//   npm run doctor -- --push   → report + apna local db remote me push
//
// Exit code: 0 = data safe (linked + reachable), 1 = DATA LOSS RISK.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env') });
} catch {}

const { resolveDbLink, pullLinkedPayload, pushLinkedPayload, verifyDbLink, getDbLinkStatus } = await import('../db-link.js');
const { buildCloudVaultSnapshot, getDb, flushLinkedDbPush } = await import('../store.js');

const args = process.argv.slice(2);
const wantVerify = args.includes('--verify');
const wantPush = args.includes('--push');

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function line(s = '') { console.log(s); }
function ok(s) { line(`${C.green}✓${C.reset} ${s}`); }
function bad(s) { line(`${C.red}✗${C.reset} ${s}`); }
function warn(s) { line(`${C.yellow}!${C.reset} ${s}`); }
function head(s) { line(`${C.bold}${C.cyan}${s}${C.reset}`); }
function dim(s) { line(`${C.dim}${s}${C.reset}`); }

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function age(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s pehle`;
  if (s < 3600) return `${Math.round(s / 60)}m pehle`;
  if (s < 86400) return `${Math.round(s / 3600)}h pehle`;
  return `${Math.round(s / 86400)}d pehle`;
}

// ── 1) Local DB ────────────────────────────────────────────────────────────
head('💾 LOCAL DB');
const localExists = fs.existsSync(DB_FILE);
if (localExists) {
  const st = fs.statSync(DB_FILE);
  ok(`${DB_FILE}`);
  dim(`   size ${fmtBytes(st.size)} · modified ${age(Date.now() - st.mtimeMs)}`);
} else {
  warn(`${DB_FILE} — abhi banayi nahi hui (bot shuru hone par banegi)`);
}

let localCounts = { accounts: 0, ledger: 0, sources: 0, orders: 0 };
try {
  const db = getDb();
  localCounts = {
    accounts: Object.keys(db?.config?.accounts || {}).length,
    ledger: Object.keys(db?.premiumFlow?.used || {}).length,
    sources: Array.isArray(db?.firebaseSources?.list) ? db.firebaseSources.list.length : 0,
    orders: Object.keys(db?.orders || {}).length,
  };
  ok(`accounts ${localCounts.accounts} · number-ledger ${localCounts.ledger} · firebase sources ${localCounts.sources} · orders ${localCounts.orders}`);
} catch (e) {
  bad(`local db padhi nahi ja saki: ${e.message}`);
}
line();

// ── 2) Linked DB config ────────────────────────────────────────────────────
head('🔗 LINKED DB');
const link = resolveDbLink();
if (link.linked) {
  ok(`driver: ${link.driver}`);
  dim(`   target: ${link.target}`);
  dim(`   key   : ${link.key}`);
  if (link.pushBlocked) bad(`push blocked: ${link.blockedReason}`);
} else {
  bad('LINKED NAHI — DB sirf local file me hai (restart = data loss)');
  dim(`   wajah: ${link.blockedReason}`);
}
line();

// ── 3) Live reachability ───────────────────────────────────────────────────
let remote = null;
if (link.linked) {
  head('🌐 REACHABILITY');
  const t0 = Date.now();
  remote = await pullLinkedPayload();
  const ms = Date.now() - t0;
  if (remote) {
    ok(`remote snapshot mila (${ms}ms)`);
    dim(`   accounts ${Object.keys(remote.accounts || {}).length} · ledger ${Object.keys(remote?.premiumFlow?.used || {}).length} · sources ${Array.isArray(remote?.firebaseSources?.list) ? remote.firebaseSources.list.length : 0} · orders ${Object.keys(remote.orders || {}).length}`);
    dim(`   updatedAt ${remote.updatedAt || '—'}`);
    if (remote.accounts && Object.keys(remote.accounts).length > localCounts.accounts) {
      warn(`remote me ${Object.keys(remote.accounts).length} accounts hain, local me sirf ${localCounts.accounts} — boot par hydrate ye wapas laayega`);
    }
  } else {
    bad(`remote snapshot nahi mila (${ms}ms) — linked DB reachable nahi hai`);
  }

  if (wantVerify) {
    const v = await verifyDbLink();
    if (v.ok) ok(`verify: ${v.driver} — ${v.detail}`);
    else bad(`verify fail: ${v.driver} — ${v.detail}`);
  }

  if (wantPush) {
    const snapshot = buildCloudVaultSnapshot(getDb());
    const res = await pushLinkedPayload(snapshot);
    if (res?.ok) ok('push OK (local snapshot remote me likha — remote ke saath merge hua)');
    else bad(`push fail: ${res?.error || res?.reason || 'unknown'}`);
  }
  line();
}

// ── 4) Status + verdict ────────────────────────────────────────────────────
head('📋 STATUS');
const st = getDbLinkStatus();
dim(`   driver ${st.driver} · linked ${st.linked} · last push ${age(st.lastPushAt)} · ok ${st.lastPushOk}`);
if (st.lastError) {
  dim(`   last error: ${st.lastError}`);
  if (/\b403\b/.test(String(st.lastError))) {
    dim('   hint: 403 = token ki scope missing. Classic PAT chahiye (repo scope) — GitHub App/integration token se Contents API write nahi hota.');
  }
  if (/\b401\b/.test(String(st.lastError))) {
    dim('   hint: 401 = token galat ya expired. Naya PAT bana ke env me daalo.');
  }
}
if (st.pendingOutbox) warn('pending outbox hai — ek push abhi bacha hai (retry chal raha hai)');
line();

let risk = false;
if (!link.linked) {
  risk = true;
  bad('VERDICT: ⚠️ DATA LOSS RISK — restart par accounts/settings/ledger chale jayenge.');
  line();
  line('   Fix (Render → Environment, ya local .env):');
  line('     GITHUB_VAULT_TOKEN=<github PAT>     # repo me vault push/pull ke liye');
  line('     VAULT_ENCRYPTION_KEY=<random 32+ chars>  # accounts encrypt hote hain');
  line('   ya Vercel KV/Upstash use karna ho to:');
  line('     KV_REST_URL=<kv url>   KV_REST_TOKEN=<kv token>');
  line('   phir:  npm run doctor -- --verify');
} else if (link.pushBlocked) {
  risk = true;
  bad('VERDICT: ⚠️ DATA LOSS RISK — push block hai (encryption key missing).');
  line('     VAULT_ENCRYPTION_KEY=<random 32+ chars> set karo (same value har instance me).');
} else if (!remote) {
  risk = true;
  bad('VERDICT: ⚠️ DATA LOSS RISK — linked store reachable nahi hai.');
  line('     Token/URL check karo, ya network allowlist me apna Render IP daalo.');
} else {
  ok('VERDICT: ✅ DB linked + reachable — restart ke baad data wapas aayega.');
}

process.exit(risk ? 1 : 0);
