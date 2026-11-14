// ============================================================================
// test_db_link.mjs — 💾 Linked database tests (koi real network nahi; local
//                      mock KV server + pure merge functions)
//   node test_db_link.mjs   (ya npm test)
//
// Ye tests us "data loss" fix ko pakadte hain:
//   • remote ka data kabhi local empty push se wipe na ho
//   • delete (tombstone) permanent rahe
//   • re-login tombstone hata de
//   • number-ledger me naya timestamp jeete
//   • KV driver ka round trip (write → read → same payload)
//   • driver detection ka priority order
// ============================================================================

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-data-db');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const { mergeDbSnapshots, payloadFingerprint, normalizeDbPhone, isDbTombstoned } = await import('./db-payload.js');
const dbLink = await import('./db-link.js');
const vaultSync = await import('./vault-sync.js');

console.log('\n💾 Linked DB — merge rules (data loss protection)');

// ── 1) EMPTY local push remote data WIPE nahi kar sakta ────────────────────
{
  const remote = {
    version: 18,
    accounts: {
      acc_9876543210: { id: 'acc_9876543210', phone: '9876543210', isLoggedIn: true, cookies: 'tid=remote-1' },
    },
    sessionVault: { acc_9876543210: { phone: '9876543210', token: 'tok-remote' } },
    orders: { ord_1: { id: 'ord_1', total: 99 } },
    premiumFlow: { used: { '9876543210': { extractedAt: 1700000000000 } } },
    deletedAccounts: {},
    freshSettings: { target: 50 },
  };
  const emptyLocal = { version: 18, accounts: {}, sessionVault: {}, orders: {}, premiumFlow: { used: {} }, deletedAccounts: {}, freshSettings: {} };

  const { payload } = mergeDbSnapshots(emptyLocal, remote);
  ok(payload.accounts.acc_9876543210, 'merge: remote account empty push ke baad bhi bacha');
  ok(payload.accounts.acc_9876543210.cookies === 'tid=remote-1', 'merge: remote account ka data intact');
  ok(payload.sessionVault.acc_9876543210, 'merge: remote session vault bacha');
  ok(payload.orders.ord_1, 'merge: remote order bacha');
  ok(payload.premiumFlow.used['9876543210'], 'merge: remote number-ledger bacha');
  ok(payload.freshSettings.target === 50, 'merge: remote settings bache');
}

// ── 2) Local account jeeta, remote ka gap fill hua ─────────────────────────
{
  const local = {
    accounts: { acc_1: { id: 'acc_1', phone: '9000000001', isLoggedIn: true, cookies: '' } },
  };
  const remote = {
    accounts: { acc_1: { id: 'acc_1', phone: '9000000001', isLoggedIn: true, cookies: 'tid=remote; token=t', name: 'Remote Name' } },
  };
  const { payload } = mergeDbSnapshots(local, remote);
  ok(payload.accounts.acc_1.cookies === 'tid=remote; token=t', 'merge: khaali credential remote se bhar gaya');
  ok(payload.accounts.acc_1.name === 'Remote Name', 'merge: remote ka extra field bacha');
}

// ── 3) Delete permanent hai ────────────────────────────────────────────────
{
  const local = { accounts: {}, deletedAccounts: { acc_9876543210: true } };
  const remote = { accounts: { acc_9876543210: { id: 'acc_9876543210', phone: '9876543210', isLoggedIn: true } } };
  const { payload, stats } = mergeDbSnapshots(local, remote);
  ok(!payload.accounts.acc_9876543210, 'merge: delete ki hui account wapas nahi aayi');
  ok(stats.accountsRemoved === 1, 'merge: delete count report hua');
  ok(payload.deletedAccounts.acc_9876543210, 'merge: tombstone bacha');
}

// ── 4) Re-login jeeta (tombstone hat gaya) ─────────────────────────────────
{
  const local = {
    accounts: { acc_9876543210: { id: 'acc_9876543210', phone: '9876543210', isLoggedIn: true, cookies: 'tid=fresh' } },
    deletedAccounts: {},
  };
  const remote = {
    accounts: { acc_9876543210: { id: 'acc_9876543210', phone: '9876543210', isLoggedIn: true, cookies: 'tid=old' } },
    deletedAccounts: { acc_9876543210: true },
  };
  const { payload } = mergeDbSnapshots(local, remote);
  ok(payload.accounts.acc_9876543210, 'merge: re-login ki hui account bachi');
  ok(payload.accounts.acc_9876543210.cookies === 'tid=fresh', 'merge: re-login ka fresh data jeeta');
  ok(!payload.deletedAccounts.acc_9876543210, 'merge: re-login par tombstone hat gaya');
}

// ── 5) Ledger: naya timestamp jeeta ────────────────────────────────────────
{
  const local = { premiumFlow: { used: { '9000000002': { extractedAt: 2000 } } } };
  const remote = { premiumFlow: { used: { '9000000002': { extractedAt: 5000 }, '9000000003': { extractedAt: 1000 } } } };
  const { payload } = mergeDbSnapshots(local, remote);
  ok(payload.premiumFlow.used['9000000002'].extractedAt === 5000, 'ledger: naya timestamp jeeta');
  ok(payload.premiumFlow.used['9000000003'], 'ledger: remote-only entry bachi');
}

// ── 6) Firebase sources: union + deleted respected ─────────────────────────
{
  const local = {
    firebaseSources: {
      list: [{ id: 'a1', url: 'https://one-default-rtdb.firebaseio.com' }],
      deleted: ['https://gone-default-rtdb.firebaseio.com'],
      health: {},
      cleared: false,
      activeId: 'a1',
      seedVersion: 1,
    },
  };
  const remote = {
    firebaseSources: {
      list: [
        { id: 'b1', url: 'https://two-default-rtdb.firebaseio.com' },
        { id: 'a1', url: 'https://one-default-rtdb.firebaseio.com' },
      ],
      deleted: ['https://gone-default-rtdb.firebaseio.com', 'https://old-default-rtdb.firebaseio.com'],
      health: {},
      cleared: false,
      activeId: 'b1',
      seedVersion: 2,
    },
  };
  const { payload } = mergeDbSnapshots(local, remote);
  const urls = payload.firebaseSources.list.map((s) => s.url);
  ok(urls.includes('https://one-default-rtdb.firebaseio.com'), 'sources: local source bacha');
  ok(urls.includes('https://two-default-rtdb.firebaseio.com'), 'sources: remote source bhi aaya');
  ok(payload.firebaseSources.deleted.includes('https://old-default-rtdb.firebaseio.com'), 'sources: remote deleted list bhi aayi');
  ok(!urls.includes('https://gone-default-rtdb.firebaseio.com'), 'sources: deleted source list me nahi');
  ok(payload.firebaseSources.seedVersion === 1, 'sources: local seedVersion jeeta');
}

// ── 7) Fingerprint — sirf updatedAt change se same ────────────────────────
{
  const a = { version: 18, updatedAt: '2026-01-01T00:00:00.000Z', accounts: { x: { id: 'x' } } };
  const b = { version: 18, updatedAt: '2026-02-02T00:00:00.000Z', accounts: { x: { id: 'x' } } };
  ok(payloadFingerprint(a) === payloadFingerprint(b), 'fingerprint: updatedAt change se same');
  const c = { ...b, accounts: { x: { id: 'x' }, y: { id: 'y' } } };
  ok(payloadFingerprint(a) !== payloadFingerprint(c), 'fingerprint: data change se alag');
}

// ── 8) Phone + tombstone helpers ──────────────────────────────────────────
{
  ok(normalizeDbPhone('+91 98765-43210') === '9876543210', 'phone: 91 prefix normalize');
  ok(normalizeDbPhone('09876543210') === '9876543210', 'phone: 0 prefix normalize');
  ok(isDbTombstoned({ acc_9876543210: true }, 'acc_9876543210', ''), 'tombstone: key se');
  ok(isDbTombstoned({ '9876543210': true }, 'acc_x', '9876543210'), 'tombstone: phone se');
  ok(!isDbTombstoned({}, 'acc_x', '9876543210'), 'tombstone: koi nahi');
}

console.log('\n🔗 Driver detection + branch isolation');

// ── 9) Driver priority: kv > http > vault > none ──────────────────────────
{
  const savedEnv = { ...process.env };
  delete process.env.KV_REST_URL;
  delete process.env.KV_REST_TOKEN;
  delete process.env.DB_STORE_URL;
  delete process.env.GITHUB_VAULT_TOKEN;
  delete process.env.GH_VAULT_TOKEN;

  ok(dbLink.resolveDbLink().driver === 'none', 'driver: koi config nahi → none');
  ok(dbLink.resolveDbLink().linked === false, 'driver: none me linked=false');

  process.env.GITHUB_VAULT_TOKEN = 'ghp_test';
  process.env.VAULT_ENCRYPTION_KEY = 'k';
  ok(dbLink.resolveDbLink().driver === 'vault', 'driver: vault token se');

  process.env.DB_STORE_URL = 'https://db.example.com/store';
  ok(dbLink.resolveDbLink().driver === 'http', 'driver: http vault se pehle');

  process.env.KV_REST_URL = 'https://kv.example.com';
  process.env.KV_REST_TOKEN = 'kv-token';
  ok(dbLink.resolveDbLink().driver === 'kv', 'driver: kv sabse pehle');

  for (const k of ['KV_REST_URL', 'KV_REST_TOKEN', 'DB_STORE_URL', 'DB_STORE_TOKEN', 'GITHUB_VAULT_TOKEN', 'GH_VAULT_TOKEN', 'VAULT_ENCRYPTION_KEY']) {
    delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
}

// ── 10) Vault branch per instance (data cross-contamination rokne ke liye) ─
{
  ok(vaultSync.resolveVaultBranch({}) === 'bot-vault', 'branch: default = bot-vault');
  ok(vaultSync.resolveVaultBranch({ INSTANCE_LABEL: 'bot2' }) === 'bot-vault-bot2', 'branch: bot2 alag');
  ok(vaultSync.resolveVaultBranch({ INSTANCE_LABEL: 'bot3' }) === 'bot-vault-bot3', 'branch: bot3 alag');
  ok(
    vaultSync.resolveVaultBranch({ INSTANCE_LABEL: 'bot2', GITHUB_VAULT_BRANCH: 'custom' }) === 'custom',
    'branch: explicit env hamesha jeeta'
  );
  ok(
    vaultSync.resolveVaultBranch({ INSTANCE_LABEL: 'bot2' }) !== vaultSync.resolveVaultBranch({ INSTANCE_LABEL: 'bot3' }),
    'branch: do instances ka branch alag (wipe nahi hoga)'
  );
}

console.log('\n🌐 KV driver round-trip (local mock server)');

// ── 11) Push → pull (encryption at rest + merge) ───────────────────────────
{
  const store = new Map();
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer kv-test-token') {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const key = decodeURIComponent(req.url.replace(/^\/(set|get)\//, ''));
    if (req.method === 'POST' && req.url.startsWith('/set/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        store.set(key, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'OK' }));
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/get/')) {
      const v = store.has(key) ? store.get(key) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: v }));
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const savedEnv = { ...process.env };
  process.env.KV_REST_URL = `http://127.0.0.1:${port}`;
  process.env.KV_REST_TOKEN = 'kv-test-token';
  process.env.VAULT_ENCRYPTION_KEY = 'unit-test-key-123';
  process.env.INSTANCE_LABEL = 'main';

  const payload = {
    version: 18,
    accounts: { acc_9000000009: { id: 'acc_9000000009', phone: '9000000009', isLoggedIn: true, cookies: 'tid=kv-secret' } },
    deletedAccounts: {},
    sessionVault: {},
    orders: {},
    premiumFlow: { used: {} },
    freshSettings: {},
  };

  const pushed = await dbLink.pushLinkedPayload(payload);
  ok(pushed.ok, 'kv: push OK');

  const raw = store.get('bot-db:main');
  ok(typeof raw === 'string' && raw.includes('__vaultEnc'), 'kv: payload ENCRYPTED at rest');
  ok(!raw.includes('kv-secret'), 'kv: secret ciphertext me hai (plaintext nahi)');

  const pulled = await dbLink.pullLinkedPayload();
  ok(pulled && pulled.accounts.acc_9000000009, 'kv: pull se account wapas mila');
  ok(pulled.accounts.acc_9000000009.cookies === 'tid=kv-secret', 'kv: pull ka data exact');

  // Doosra instance (khaali db) push kare → pehle ka account NAHI marna chahiye.
  const other = await dbLink.pushLinkedPayload({ version: 18, accounts: {}, deletedAccounts: {}, sessionVault: {}, orders: {}, premiumFlow: { used: {} }, freshSettings: {} });
  ok(other.ok, 'kv: doosra push OK');
  const after = await dbLink.pullLinkedPayload();
  ok(after.accounts.acc_9000000009, 'kv: khaali push se account WIPE nahi hua ✅');

  const v = await dbLink.verifyDbLink();
  ok(v.ok, 'kv: verify (write + read-back) OK');

  server.close();
  for (const k of ['KV_REST_URL', 'KV_REST_TOKEN', 'VAULT_ENCRYPTION_KEY']) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

console.log(`\n🧯 Outbox (push fail → retry)`);

// ── 12) Push fail hua to outbox me bacha, phir retry se chala gaya ────────
{
  let failWrites = true;
  const store = new Map();
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\/(set|get)\//, ''));
    if (req.method === 'POST' && req.url.startsWith('/set/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (failWrites) { res.writeHead(500).end('boom'); return; }
        store.set(key, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'OK' }));
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/get/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: store.has(key) ? store.get(key) : null }));
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const savedEnv = { ...process.env };
  process.env.KV_REST_URL = `http://127.0.0.1:${port}`;
  process.env.KV_REST_TOKEN = 'kv-test-token';
  process.env.VAULT_ENCRYPTION_KEY = 'unit-test-key-123';

  const payload = {
    version: 18,
    accounts: { acc_9111111111: { id: 'acc_9111111111', phone: '9111111111', isLoggedIn: true, cookies: 'tid=outbox' } },
    deletedAccounts: {}, sessionVault: {}, orders: {}, premiumFlow: { used: {} }, freshSettings: {},
  };

  const failed = await dbLink.pushLinkedPayload(payload);
  ok(!failed.ok, 'outbox: push fail hua to error return hua');
  const status = dbLink.getDbLinkStatus();
  ok(status.pendingOutbox === true, 'outbox: fail ke baad pending snapshot bacha');

  const outboxPayload = dbLink.readOutbox();
  ok(outboxPayload && outboxPayload.accounts?.acc_9111111111, 'outbox: snapshot wapas padha ja sakta hai');

  // Server theek hua → retry chalti hai → outbox khaali.
  failWrites = false;
  const retried = await dbLink.pushLinkedPayload(payload);
  ok(retried.ok, 'outbox: retry push OK');
  const after = dbLink.getDbLinkStatus();
  ok(after.pendingOutbox === false, 'outbox: successful push ke baad outbox khaali');

  server.close();
  for (const k of ['KV_REST_URL', 'KV_REST_TOKEN', 'VAULT_ENCRYPTION_KEY']) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

console.log(`\n✅ ALL PASSED — ${passed} checks`);
