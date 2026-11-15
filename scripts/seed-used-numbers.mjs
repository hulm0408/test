#!/usr/bin/env node
// ============================================================================
// scripts/seed-used-numbers.mjs — 📋 Used-numbers blocklist manage karo
// ============================================================================
//
// Ye list woh numbers hai jinka OTP dobara NAHI lena hai (cooldown window
// tak — default 30 din). Numbers `seed/used-numbers.json` me rehti hain
// (repo ke andar, tracked) aur har instance boot par unhe ledger me import
// kar leta hai.
//
//   npm run seed:used-numbers -- <file.json> [file2.json ...]
//       Uploaded accounts file(s) se mobile numbers nikal kar list me add
//       karta hai (sirf numbers — token/cookie kabhi save nahi hote).
//
//   npm run seed:used-numbers -- --apply
//       Sirf list ko local db me apply karta hai (list change nahi).
//
//   npm run seed:used-numbers -- --show
//       List ka summary dikhata hai.
//
// File format (accounts export): [{ "mobile": "98xxxxxxxx", ... }, ...]
//   → sirf `mobile`/`phone` field padha jata hai.
//
// ⚠️ Session tokens/cookies KABHI list me nahi jaate — sirf mobile numbers.
//    (Is repo me tokens public ho sakte hain — safe rehna zaroori hai.)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED_FILE = path.join(ROOT, 'seed', 'used-numbers.json');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env') });
} catch {}

const { seedUsedNumbersFromSeedFile, getUsedNumbersSummary } = await import('../store.js');

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m',
};
const ok = (s) => console.log(`${C.green}✓${C.reset} ${s}`);
const warn = (s) => console.log(`${C.yellow}!${C.reset} ${s}`);
const bad = (s) => console.log(`${C.red}✗${C.reset} ${s}`);
const head = (s) => console.log(`${C.bold}${C.cyan}${s}${C.reset}`);
const dim = (s) => console.log(`${C.dim}${s}${C.reset}`);

function normalizeMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return digits.length === 10 ? digits : '';
}

// Accounts export file se numbers nikaalo (mobile/phone/msisdn).
function extractNumbers(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    bad(`${path.basename(file)} — JSON parse fail: ${err.message}`);
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.accounts) ? parsed.accounts : (Array.isArray(parsed?.numbers) ? parsed.numbers : []));
  if (!list.length) {
    bad(`${path.basename(file)} — koi list nahi mili (array ya {accounts:[...]} chahiye)`);
    return [];
  }
  const out = [];
  for (const item of list) {
    const raw = typeof item === 'string'
      ? item
      : (item?.mobile || item?.phone || item?.msisdn || item?.number || '');
    const m = normalizeMobile(raw);
    if (m) out.push(m);
  }
  return out;
}

const args = process.argv.slice(2);
const show = args.includes('--show');
const applyOnly = args.includes('--apply');
const files = args.filter((a) => !a.startsWith('--'));

head('📋 USED-NUMBERS BLOCKLIST');

// ── Seed file ka current state ─────────────────────────────────────────────
let seed = { version: 1, seededAt: new Date().toISOString(), cooldownDays: 30, numbers: [], sources: [] };
if (fs.existsSync(SEED_FILE)) {
  try {
    seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    if (!Array.isArray(seed.numbers)) seed.numbers = [];
    if (!Array.isArray(seed.sources)) seed.sources = [];
    if (!seed.addedAt || typeof seed.addedAt !== 'object') seed.addedAt = {};
  } catch (err) {
    bad(`seed file kharab hai: ${err.message}`);
    process.exit(1);
  }
}
const seedCreatedAt = seed.seededAt || new Date().toISOString();
seed.seededAt = seedCreatedAt;
const known = new Set(seed.numbers.map(normalizeMobile).filter(Boolean));
head('📋 SEED LIST');
dim(`   file: ${SEED_FILE}`);
dim(`   numbers: ${known.size} · seededAt: ${seed.seededAt || '—'}`);

// ── Naye files add karo ─────────────────────────────────────────────────────
if (files.length && !applyOnly) {
  head('➕ IMPORT');
  let addedTotal = 0;
  const addedAt = {};
  for (const file of files) {
    const abs = path.resolve(ROOT, file);
    if (!fs.existsSync(abs)) { bad(`file nahi mili: ${file}`); continue; }
    const nums = extractNumbers(abs);
    if (!nums.length) { warn(`${path.basename(file)} — koi valid mobile number nahi mila`); continue; }
    let added = 0;
    for (const m of nums) {
      if (known.has(m)) continue;
      known.add(m);
      added++;
    }
    addedTotal += added;
    const srcName = path.basename(file);
    if (!seed.sources.includes(srcName)) seed.sources.push(srcName);
    ok(`${srcName} → ${nums.length} numbers me se ${added} naye add hue`);
  }

  if (addedTotal > 0) {
    // Naye numbers ko APNA timestamp milta hai (addedAt) — purane numbers ka
    // 30-din window reset NAHI hota. Har number apne 30 din baad unlock hoga.
    const nowIso = new Date().toISOString();
    const previous = new Set(seed.numbers);
    for (const m of known) {
      if (!previous.has(m) && !seed.addedAt[m]) seed.addedAt[m] = nowIso;
    }
    seed.numbers = [...known].sort();
    seed.count = seed.numbers.length;
    seed.seededAt = seedCreatedAt; // pehli list ka timestamp — kabhi reset nahi
    seed.cooldownDays = 30;
    seed.note = 'Ye numbers ka OTP dobara nahi lena — cooldown window tak block. Sirf mobile numbers, koi session/token nahi.';
    fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
    fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2) + '\n', 'utf-8');
    ok(`seed file update: ab ${seed.numbers.length} numbers (${addedTotal} naye · 30-din cooldown unke apne add-date se)`);
    dim('   → git add/commit karo, taaki har instance par ye list aaye');
  }
} else if (files.length) {
  warn('--apply diya hai — list change nahi hui, sirf apply hoga');
}

// ── Local db me apply ───────────────────────────────────────────────────────
head('💾 APPLY (local db)');
const applied = seedUsedNumbersFromSeedFile(SEED_FILE);
if (applied?.present) {
  ok(`${applied.added} naye block · ${applied.kept} pehle se block · ${applied.skipped} skip`);
  dim(`   ledger ab ${applied.total} numbers · seed active: ${applied.seedActive ? 'haan' : 'nahi (window expire)'}`);
} else {
  bad(`apply fail: ${applied?.error || 'unknown'}`);
}

const summary = getUsedNumbersSummary();
head('📊 LEDGER');
dim(`   total ${summary.total} · blocked ${summary.blocked} · permanent ${summary.permanent} · cooldown ${summary.cooldownDays} din`);

if (show) {
  head('📄 LIST (pehle 20)');
  dim(`   ${seed.numbers.slice(0, 20).join(', ')} …`);
}

console.log('');
console.log(`${C.bold}Next:${C.reset} seed file commit karo → har instance (Render/Actions) boot par ye list lagayega.`);
