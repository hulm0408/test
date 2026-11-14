// ============================================================================
// test_used_numbers.mjs — 📋 Used-numbers blocklist tests (no network)
//   node test_used_numbers.mjs   (ya npm test)
//
// Ye tests owner ke rule ko pakadte hain:
//   • seed list ke numbers cooldown window tak BLOCKED hain (OTP nahi)
//   • re-apply karne par window EXTEND nahi hota (restart par reset nahi)
//   • 30 din baad number UNLOCK ho jata hai (dobara block nahi)
//   • baad me add hua number apna ALAG 30-din window rakhta hai
//   • ledger me 'skipped' entries hamesha block rehte hain
// ============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'used-numbers-test-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const store = await import('./store.js');
const pipeline = await import('./number-pipeline.js');

console.log('\n📋 Used-numbers blocklist');

// ── 1) Cooldown window 30 din ──────────────────────────────────────────────
{
  ok(pipeline.extractedNumberCooldownDays() === 30, 'cooldown: default 30 din');
  const saved = process.env.PREMIUM_USED_COOLDOWN_DAYS;
  process.env.PREMIUM_USED_COOLDOWN_DAYS = '45';
  ok(pipeline.extractedNumberCooldownDays() === 45, 'cooldown: env se badal sakta hai');
  process.env.PREMIUM_USED_COOLDOWN_DAYS = '0';
  ok(pipeline.extractedNumberCooldownDays() === 30, 'cooldown: 0/invalid env par default');
  if (saved === undefined) delete process.env.PREMIUM_USED_COOLDOWN_DAYS;
  else process.env.PREMIUM_USED_COOLDOWN_DAYS = saved;
}

// ── Helper: temp seed file banao ───────────────────────────────────────────
function writeSeed(numbers, { seededAt = new Date().toISOString(), addedAt = {} } = {}) {
  const file = path.join(tmpDir, `seed-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, seededAt, cooldownDays: 30, numbers, addedAt }), 'utf-8');
  return file;
}

// ── 2) Seed list ke numbers block hote hain ─────────────────────────────────
{
  const file = writeSeed(['9000000001', '9000000002']);
  const res = store.seedUsedNumbersFromSeedFile(file);
  ok(res.added === 2, 'seed: 2 numbers ledger me add hue');
  ok(pipeline.isPhoneBlockedByPremiumLedger('9000000001'), 'seed: number blocked (OTP nahi jayega)');
  ok(pipeline.isPhoneBlockedByPremiumLedger('9000000002'), 'seed: dono numbers blocked');
  ok(!pipeline.isPhoneBlockedByPremiumLedger('9000000009'), 'seed: list ka na-listed number block nahi');
  const cd = pipeline.getExtractedNumberCooldown('9000000001');
  ok(cd.blocked && cd.source === 'ledger', 'seed: cooldown ledger source se aata hai');
  ok(Math.round(cd.remainingMs / 86400000) === 30, 'seed: 30 din ka window');
}

// ── 3) Re-apply par window EXTEND nahi hota ────────────────────────────────
{
  const file = writeSeed(['9000000003']);
  const first = store.seedUsedNumbersFromSeedFile(file);
  const ts1 = store.getDb().premiumFlow.used['9000000003'].extractedAt;
  const second = store.seedUsedNumbersFromSeedFile(file);
  const ts2 = store.getDb().premiumFlow.used['9000000003'].extractedAt;
  ok(first.added === 1, 're-apply: pehli baar add hua');
  ok(second.added === 0 && second.kept === 1, 're-apply: dobara add nahi hua');
  ok(ts1 === ts2, 're-apply: timestamp unchanged (window reset nahi)');
}

// ── 4) 30 din baad UNLOCK ──────────────────────────────────────────────────
{
  const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const file = writeSeed(['9000000004'], { seededAt: past });
  const res = store.seedUsedNumbersFromSeedFile(file);
  ok(res.skipped === 1, 'expired seed: number add nahi hua (window khatam)');
  ok(!pipeline.isPhoneBlockedByPremiumLedger('9000000004'), 'expired seed: number unlock hai');
  ok(res.seedActive === false, 'expired seed: seedActive false');
}

// ── 5) Baad me add hua number apna ALAG window rakhta hai ──────────────────
{
  const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const file = writeSeed(['9000000005', '9000000006'], {
    seededAt: old,
    addedAt: { '9000000006': new Date().toISOString() },
  });
  const res = store.seedUsedNumbersFromSeedFile(file);
  ok(res.added === 2, 'per-number: dono add hue');
  const cd5 = pipeline.getExtractedNumberCooldown('9000000005');
  const cd6 = pipeline.getExtractedNumberCooldown('9000000006');
  ok(Math.round(cd5.remainingMs / 86400000) === 10, 'per-number: purana number 10 din me unlock (20 din ho chuke)');
  ok(Math.round(cd6.remainingMs / 86400000) === 30, 'per-number: naya number 30 din ka full window');
}

// ── 6) 'skipped' entry hamesha block ───────────────────────────────────────
{
  const db = store.getDb();
  db.premiumFlow.used['9000000007'] = { status: 'skipped', at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() };
  store.saveDb(db);
  const file = writeSeed(['9000000007']);
  const res = store.seedUsedNumbersFromSeedFile(file);
  ok(res.kept === 1, 'skipped: seed ne overwrite nahi kiya');
  ok(pipeline.isPhoneBlockedByPremiumLedger('9000000007'), 'skipped: number hamesha block (permanent)');
}

// ── 7) Summary ─────────────────────────────────────────────────────────────
{
  const summary = store.getUsedNumbersSummary();
  ok(summary.total >= 6, 'summary: ledger total');
  ok(summary.blocked >= 5, 'summary: blocked count');
  ok(summary.cooldownDays === 30, 'summary: cooldown days');
  ok(summary.permanent >= 1, 'summary: permanent (skipped) count');
}

// ── 8) Ledger me sirf number hai — koi session/token nahi ──────────────────
{
  const seedRaw = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'seed', 'used-numbers.json'), 'utf-8');
  ok(!/"token"/i.test(seedRaw), 'seed file: koi token nahi');
  ok(!/"cookies"/i.test(seedRaw), 'seed file: koi cookies nahi');
  ok(!/"tid"/i.test(seedRaw), 'seed file: koi tid nahi');
  const parsed = JSON.parse(seedRaw);
  ok(Array.isArray(parsed.numbers) && parsed.numbers.length > 1000, 'seed file: numbers ki list');
  ok(parsed.numbers.every((n) => /^[6-9]\d{9}$/.test(n)), 'seed file: sab numbers valid Indian mobile');
  ok(parsed.numbers.length === new Set(parsed.numbers).size, 'seed file: koi duplicate nahi');
}

// ── 9) Snapshot compact hai + expire entries trim hoti hain ─────────────────
{
  const db = store.getDb();
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  db.premiumFlow.used['9000000010'] = { status: 'success', at: past, extractedAt: past };   // expire
  db.premiumFlow.used['9000000011'] = { status: 'success', at: nowIso, extractedAt: nowIso }; // active
  db.premiumFlow.used['9000000012'] = { status: 'skipped', at: past };                     // permanent
  store.saveDb(db);

  const snap = store.buildCloudVaultSnapshot(db);
  const used = snap.premiumFlow.used;
  ok(!used['9000000010'], 'snapshot: expire entry nahi gayi (size chhoti)');
  ok(used['9000000011'], 'snapshot: active cooldown entry bachi');
  ok(used['9000000012'], 'snapshot: permanent block entry bachi');
  ok(typeof used['9000000011'].extractedAt === 'number', 'snapshot: compact form (epoch ms)');
  ok(!('seeded' in used['9000000011']), 'snapshot: extra metadata hataya (size)');

  // Compact form cooldown reader samajhta hai
  const cd = pipeline.getExtractedNumberCooldown('9000000011');
  ok(cd.blocked, 'snapshot: compact entry cooldown reader par block karti hai');

  // Trim local ledger se expire entries hatate hain, permanent nahi
  const trimmed = store.trimExpiredUsedNumbers();
  ok(trimmed.removed >= 1, 'trim: expire entry hata di');
  const after = store.getDb().premiumFlow.used;
  ok(!after['9000000010'], 'trim: expire entry local se gaya');
  ok(after['9000000012'], 'trim: permanent entry bachi');
  ok(after['9000000011'], 'trim: active entry bachi');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n✅ ALL PASSED — ${passed} checks`);
