import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveMasterKey, encryptSecret, decryptSecret } from '../src/crypto.js';
import { ToingDb, parseBulkSessionsInput, bootstrapEnvSessions } from '../src/db.js';
import {
  parseTelegramNumberCard,
  parseTelegramOtpMessage,
  candidateIsNew,
  selectLatestFreshNumberCard,
} from '../src/otp-parser.js';
import { selectOtpBotScreenAction, otpBotButtonRole } from '../src/otp-profiles.js';
import { classifyTelegramError, isConnectionError } from '../src/telegram-health.js';
import { ToingClient, sanitizeErrorText, parseSendOtpCooldownMs } from '../src/toing-client.js';
import { SlotWorker } from '../src/slot-worker.js';
import { SlotManager } from '../src/slot-manager.js';
import { DeliveryWorker } from '../src/delivery-worker.js';
import { startHealthServer } from '../src/health-server.js';
import { TelegramSlotClient, formatCodeDeliverySummary, qrLoginUrlFromToken } from '../src/telegram-slot-client.js';
import { BotClickPacer } from '../src/bot-pacer.js';
import {
  _parseClientsPool,
  _parsePool,
  parseForwarderDateTime,
  parseFirebaseSourceBulkInput,
  pickBestFirebaseOtpCandidate,
} from '../src/firebase-client.js';
import { BUILTIN_FIREBASE_SOURCE_URLS } from '../src/firebase-seed-urls.js';
import { FirebaseManager } from '../src/firebase-manager.js';
import QRCode from 'qrcode';

function makeTmpDir(prefix = 'toing-rail-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. Encryption & Non-Enumerable Session Protection
// ---------------------------------------------------------------------------
test('AES-256-GCM encryption roundtrip, tamper rejection & non-enumerable session', () => {
  const dir = makeTmpDir();
  try {
    const { key } = resolveMasterKey({ envKey: 'super-secret-railway-key-2026' });
    const raw = '1BVtsOHwBu9-example-telegram-string-session-0123456789abcdef';
    const enc = encryptSecret(raw, key);
    assert.ok(enc.startsWith('enc:v1:'));
    assert.notEqual(enc, raw);
    assert.equal(decryptSecret(enc, key), raw);

    // Wrong key must throw
    const { key: wrongKey } = resolveMasterKey({ envKey: 'different-key' });
    assert.throws(() => decryptSecret(enc, wrongKey));

    // Tampered ciphertext must throw
    const tampered = `${enc.slice(0, -2)}ff`;
    assert.throws(() => decryptSecret(tampered, key));

    // DB stores encrypted and returns session non-enumerable so JSON.stringify never leaks it
    const db = new ToingDb({ dbPath: path.join(dir, 'toing.db'), dataDir: dir, encryptionKey: 'test-key-1' });
    const add = db.addAccount({ session: raw, label: 'Spare1', otpBotProfile: 'hathi' });
    assert.equal(add.ok, true);
    const loaded = db.getAccountById(add.id, { includeSession: true });
    assert.equal(loaded.session, raw);
    assert.equal(JSON.stringify(loaded).includes(raw), false, 'session must never appear in JSON.stringify');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Bulk Parser, Deduplication, Max 50 Slots, Seed Import
// ---------------------------------------------------------------------------
test('Bulk session parser, duplicate prevention, 50-slot cap & seed import', () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({ dbPath: path.join(dir, 'toing.db'), dataDir: dir, encryptionKey: 'k1' });

    const lines = [
      '# comment line',
      '1BVtsSESSION_PLAIN_000000000000000001',
      'AccTwo|1BVtsSESSION_LABELED_000000000000002',
      'AccThree|hermes|1BVtsSESSION_WITHBOT_000000000003',
      'TELEGRAM_SESSION_4=1BVtsSESSION_ENVSTYLE_00000000004',
      '1BVtsSESSION_PLAIN_000000000000000001', // duplicate of #1!
    ].join('\n');

    const parsed = parseBulkSessionsInput(lines, { defaultOtpBot: 'hathi' });
    assert.equal(parsed.length, 5);
    const res = db.importAccountsBulk(parsed, { defaultOtpBot: 'hathi', maxSlots: 50 });
    assert.equal(res.added.length, 4);
    assert.equal(res.duplicates.length, 1);

    const accounts = db.listAccounts();
    assert.equal(accounts.length, 4);
    assert.equal(accounts[2].otpBotProfile, 'hermes');
    assert.equal(accounts[2].label, 'AccThree');

    // Env bootstrap
    const boot = bootstrapEnvSessions(db, {
      TELEGRAM_SESSION_5: '1BVtsSESSION_FROM_ENV_0000000000005',
      OTP_BOT_5: 'chauhan',
    }, { defaultOtpBot: 'hathi', maxSlots: 50 });
    assert.equal(boot.added, 1);

    // Seed file import (fresh timestamped test seed)
    const seedFile = path.join(dir, 'seed.json');
    fs.writeFileSync(seedFile, JSON.stringify({
      seededAt: new Date().toISOString(),
      cooldownDays: 30,
      numbers: ['9876543210', '+91 9876543211', '9876543210'],
    }));
    const seeded1 = db.seedUsedNumbersFromFile(seedFile);
    assert.equal(seeded1.present, true);
    assert.equal(seeded1.added, 2);
    // Idempotent second run
    const seeded2 = db.seedUsedNumbersFromFile(seedFile);
    assert.equal(seeded2.added, 0);
    assert.equal(seeded2.kept, 2);

    // Seeded numbers must be blocked by tryClaimPhone
    const blocked = db.tryClaimPhone('9876543210', 1);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'cooldown');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Atomic 50-Slot Phone Claim Lock (Zero Double Signups)
// ---------------------------------------------------------------------------
test('50 slots racing for same phone: exactly 1 acquires lock, 49 rejected as in_flight', () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({ dbPath: path.join(dir, 'toing.db'), dataDir: dir, encryptionKey: 'k2' });
    const phone = '9123456789';
    const results = [];
    for (let slotId = 1; slotId <= 50; slotId++) {
      results.push(db.tryClaimPhone(phone, slotId));
    }
    const winners = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok && r.reason === 'in_flight');
    assert.equal(winners.length, 1);
    assert.equal(rejected.length, 49);

    // Commit completed signup -> phone transitions to 30-day used_numbers cooldown
    const committed = db.commitCompletedSignup({
      phone,
      slotId: 1,
      otpBot: 'hathi',
      isNew: true,
      exportObj: { mobile: phone, name: 'Test', token: 'tok_abc', sid: 's1', tid: 't1', deviceId: 'd1', customerId: 'c1' },
      deliveryChatId: '6484999726',
      cooldownDays: 30,
      durationMs: 11_500,
    });
    assert.ok(committed.sessionId > 0);
    assert.ok(committed.deliveryId > 0);
    assert.ok(fs.existsSync(committed.diskPath));

    // Any slot trying same phone now gets cooldown
    const retryClaim = db.tryClaimPhone(phone, 2);
    assert.equal(retryClaim.ok, false);
    assert.equal(retryClaim.reason, 'cooldown');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. OTP Parser + Pre-send_otp Watermark Fix
// ---------------------------------------------------------------------------
test('OTP parser handles small-caps cards, ignores welcome IDs & accepts fast post-watermark OTPs', () => {
  // Welcome card with 10-digit Telegram ID must NOT be parsed as mobile number
  const welcomeText = 'ᴡᴇʟᴄᴏᴍᴇ!\nɪᴅ: 7458637854\nClick FIND NUMBER below';
  assert.equal(parseTelegramNumberCard(welcomeText), null);

  // Real Hathi/Hermes card
  const cardText = [
    '📱 ɴᴜᴍʙᴇʀ: +91 98765 43210',
    '📲 ᴅᴇᴠɪᴄᴇ: DEV-88',
    '🟢 ꜱᴛᴀᴛᴜꜱ: ACTIVE',
    '📩 LAST SMS [SWIGGY]: Your Swiggy OTP is 482910',
  ].join('\n');
  const card = parseTelegramNumberCard(cardText);
  assert.equal(card.phone, '9876543210');
  assert.equal(card.code, '482910');
  assert.equal(card.status, 'ACTIVE');

  // Button selector prefers NEW over FIND on latest screen
  const action = selectOtpBotScreenAction([
    { text: cardText, buttons: ['🔄 REFRESH', '⏭ NEW NUMBER', '🔍 FIND NUMBER'] },
  ], { mode: 'claim', profileId: 'hathi' });
  assert.equal(action.role, 'new');
  assert.equal(otpBotButtonRole('VIEW MESSAGES', 'chauhan'), 'view');

  // Fresh card detection skips baseline card
  const oldMsg = { id: 100, date: 1700000000, message: cardText };
  const newMsg = { id: 101, date: 1700000005, message: cardText.replace('98765 43210', '98765 43219') };
  const sel = selectLatestFreshNumberCard([newMsg, oldMsg], {
    afterMessageId: 100,
    afterPhone: '9876543210',
  });
  assert.equal(sel.status, 'fresh');
  assert.equal(sel.result.card.phone, '9876543219');

  // Watermark captured BEFORE send_otp -> OTP arriving 100ms later MUST be accepted!
  const beforeSendMs = Date.now();
  const baseline = {
    ids: new Set(['tg:200:1700000000000:']),
    codes: new Set(['111111']),
    ts: beforeSendMs,
    afterMs: beforeSendMs,
    messageId: 200,
  };
  const fastOtpMsg = {
    id: 201,
    date: Math.floor((beforeSendMs + 100) / 1000),
    message: '📱 Number: 9876543219\nOTP: 654321 (SWIGGY)',
  };
  const parsedOtp = parseTelegramOtpMessage(fastOtpMsg);
  assert.equal(parsedOtp.code, '654321');
  assert.equal(candidateIsNew({
    message: fastOtpMsg,
    parsed: parsedOtp,
    ts: beforeSendMs + 100,
    messageId: 201,
    idKey: `tg:201:${beforeSendMs + 100}:${parsedOtp.signature}`,
  }, baseline), true);

  // Old OTP from baseline must be rejected
  assert.equal(candidateIsNew({
    message: { id: 200 },
    parsed: { code: '111111', smsTimeMs: beforeSendMs - 60_000, signature: '' },
    ts: beforeSendMs - 60_000,
    messageId: 200,
    idKey: 'tg:200:1700000000000:',
  }, baseline), false);

  // Health classifier
  assert.equal(classifyTelegramError(new Error('FLOOD_WAIT_45')).kind, 'flood');
  assert.equal(classifyTelegramError(new Error('AUTH_KEY_UNREGISTERED')).healthStatus, 'dead');
  assert.equal(classifyTelegramError(new Error('PEER_FLOOD')).kind, 'peer-flood');
});

// ---------------------------------------------------------------------------
// 5. ToingClient Semaphore Cap + Multi-Key Rotation + Export 3x Retry
// ---------------------------------------------------------------------------
test('ToingClient enforces semaphore cap, rotates keys on 429 & retries export 3x', async () => {
  let active = 0;
  let maxObserved = 0;
  const seenKeys = [];
  let exportAttempts = 0;

  const mockFetch = async (url, opts) => {
    active += 1;
    maxObserved = Math.max(maxObserved, active);
    seenKeys.push(opts.headers['x-user-key']);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;

    if (url.includes('/export')) {
      exportAttempts += 1;
      if (exportAttempts < 3) {
        return new Response(JSON.stringify({ error: 'temporary lag' }), { status: 502 });
      }
      return new Response(JSON.stringify({
        success: true,
        export: { mobile: '9876543210', name: 'Asha', token: 'tok_999', sid: 's1', tid: 't1', deviceId: 'd1', customerId: 'c1' },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ registered: false }), { status: 200 });
  };

  const client = new ToingClient({
    getBaseUrl: () => 'https://storelex.store/toing_web',
    getAccessKeys: () => ['KEY-A', 'KEY-B'],
    concurrency: 8,
    fetchImpl: mockFetch,
  });

  // Fire 32 concurrent checkMobile calls -> concurrency must NEVER exceed 8
  await Promise.all(Array.from({ length: 32 }, (_, i) => client.checkMobile(`90000000${String(i).padStart(2, '0')}`)));
  assert.ok(maxObserved <= 8, `Expected max concurrency <= 8, got ${maxObserved}`);
  assert.ok(seenKeys.includes('KEY-A') && seenKeys.includes('KEY-B'), 'Expected round-robin across both keys');

  // Export retries transient 502s and succeeds on attempt #3
  const exp = await client.exportAccount('9876543210');
  assert.equal(exp.ok, true);
  assert.equal(exp.fallback, false);
  assert.equal(exp.exportObj.token, 'tok_999');
  assert.equal(exportAttempts, 3);
});

// ---------------------------------------------------------------------------
// 6. FULL 50-SLOT PARALLEL CLUSTER + WATCHDOG + DELIVERY + RESTART PERSISTENCE
// ---------------------------------------------------------------------------
test('50 parallel slots run concurrently with zero duplicates, error isolation, 429 delivery retry & restart persistence', async () => {
  const dir = makeTmpDir();
  const dbPath = path.join(dir, 'toing.db');

  try {
    const db = new ToingDb({
      dbPath,
      dataDir: dir,
      encryptionKey: 'cluster-secret-key',
      sessionsDir: path.join(dir, 'sessions'),
    });

    // Seed 50 spare Telegram accounts
    const bulk = Array.from({ length: 50 }, (_, i) => ({
      label: `TG-${String(i + 1).padStart(2, '0')}`,
      otpBot: 'hathi',
      session: `1BVtsMOCK_SESSION_SLOT_${String(i + 1).padStart(3, '0')}_ABCDEFGHIJKLMNOP`,
    }));
    const imp = db.importAccountsBulk(bulk, { defaultOtpBot: 'hathi', maxSlots: 50 });
    assert.equal(imp.added.length, 50);

    // Shared mock phone generator that intentionally injects occasional collisions
    // across slots to prove atomic SQLite locking prevents double signups!
    let nextPhoneSeq = 7000000000;
    const collisionPhone = '7999999999';
    const otpByPhone = new Map();
    const verifiedPhones = [];

    const mockFetch = async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      await new Promise((r) => setTimeout(r, 5));

      if (url.endsWith('/api/auth/check_mobile')) {
        return new Response(JSON.stringify({ registered: false }), { status: 200 });
      }
      if (url.endsWith('/api/auth/send_otp')) {
        const otp = String(100000 + Math.floor(Math.random() * 899999));
        otpByPhone.set(body.mobile, otp);
        return new Response(JSON.stringify({
          success: true,
          sid: `sid_${body.mobile}`,
          tid: `tid_${body.mobile}`,
          device_id: `dev_${body.mobile}`,
        }), { status: 200 });
      }
      if (url.endsWith('/api/auth/verify_otp')) {
        const expected = otpByPhone.get(body.mobile);
        if (expected && body.otp === expected) {
          verifiedPhones.push(body.mobile);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: false, error: 'bad otp' }), { status: 400 });
      }
      if (url.includes('/export')) {
        const m = url.match(/accounts\/(\d+)\/export/);
        const mobile = m ? m[1] : '0000000000';
        return new Response(JSON.stringify({
          success: true,
          export: {
            mobile,
            name: `User_${mobile.slice(-4)}`,
            token: `jwt_${mobile}`,
            sid: `sid_${mobile}`,
            tid: `tid_${mobile}`,
            deviceId: `dev_${mobile}`,
            customerId: `cust_${mobile}`,
          },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const toingClient = new ToingClient({
      getBaseUrl: () => 'https://storelex.store/toing_web',
      getAccessKeys: () => ['TNG-KEY-1', 'TNG-KEY-2'],
      concurrency: 20,
      fetchImpl: mockFetch,
    });

    const alerts = [];
    let slot50BotSwitched = false;
    let slot49Recovered = false;

    // Mock per-slot TelegramSlotClient factory
    const clientFactory = ({ slotNo, otpBotProfile }) => {
      let currentBot = otpBotProfile;
      let claimCalls = 0;
      let connected = false;
      let floodThrown = false;
      return {
        get connected() { return connected; },
        setBotProfile(p) {
          currentBot = p;
          if (slotNo === 50 && p !== 'hathi') slot50BotSwitched = true;
        },
        async connect() {
          if (slotNo === 48) {
            throw new Error('AUTH_KEY_UNREGISTERED: revoked session');
          }
          connected = true;
          return { ok: true, me: `@spare_${slotNo}`, botUsername: `${currentBot}_bot` };
        },
        async disconnect() {
          connected = false;
        },
        async claimFreshNumber({ shouldAbort }) {
          claimCalls += 1;
          // Slot 47 gets a brief FLOOD_WAIT once
          if (slotNo === 47 && !floodThrown) {
            floodThrown = true;
            throw new Error('FLOOD_WAIT_30');
          }
          // Slot 49 hangs on first claim until watchdog recovers it
          if (slotNo === 49 && claimCalls === 1) {
            while (!shouldAbort?.()) {
              await new Promise((r) => setTimeout(r, 20));
            }
            slot49Recovered = true;
            return { ok: false, aborted: true };
          }
          // Slot 50 fails claims on hathi -> triggers auto-failover to hermes
          if (slotNo === 50 && currentBot === 'hathi') {
            return { ok: false, reason: 'claim_empty' };
          }
          // Inject deliberate cross-slot collision on first call of slots 1..10
          if (slotNo <= 10 && claimCalls === 1) {
            return { ok: true, phone: collisionPhone, card: { phone: collisionPhone } };
          }
          const phone = String(++nextPhoneSeq);
          return { ok: true, phone, card: { phone } };
        },
        async captureOtpWatermark() {
          return { ids: [], codes: [], ts: Date.now(), afterMs: Date.now(), messageId: 10 };
        },
        async waitForOtp(phone) {
          await new Promise((r) => setTimeout(r, 10));
          // Simulate ~15% OTP timeout rate on real pool
          if (Number(phone) % 7 === 0) {
            return { ok: false, code: '', timeout: true };
          }
          const code = otpByPhone.get(phone) || '';
          return code ? { ok: true, code, sender: 'SWIGGY' } : { ok: false, code: '', timeout: true };
        },
      };
    };

    const runtimeCfg = {
      telegramApiId: 12345,
      telegramApiHash: 'mockhash',
      maxSlots: 50,
      bootBatchSize: 25,
      bootBatchDelayMs: 20,
      claimTimeoutMs: 5_000,
      claimLockTtlMs: 30_000,
      otpTimeoutMs: 5_000,
      otpRefreshMs: 500,
      slotStuckTimeoutMs: 120, // fast watchdog threshold for test
      slotJitterMinMs: 5,
      slotJitterMaxMs: 15,
      claimFailBackoffMs: 25,
      autoFailoverBots: true,
      usedCooldownDays: 30,
      deliveryChatId: '6484999726',
      primaryOwnerId: '6484999726',
      deliveryGapMs: 5,
    };

    const manager = new SlotManager({
      db,
      toingClient,
      getRuntimeConfig: () => runtimeCfg,
      clientFactory,
      onSlotAlert: (a) => alerts.push(a),
    });

    // Mock DeliveryWorker with simulated Telegram 429 on 3rd document
    const deliveredDocs = [];
    let sendAttempts = 0;
    const delivery = new DeliveryWorker({
      db,
      getGapMs: () => 5,
      pollIntervalMs: 15,
      sendDocument: async ({ chatId, buffer, filename }) => {
        sendAttempts += 1;
        if (sendAttempts === 3) {
          const err = new Error('Too Many Requests: retry after 1');
          err.parameters = { retry_after: 0 };
          throw err;
        }
        const parsed = JSON.parse(buffer.toString('utf8'));
        deliveredDocs.push({ chatId, filename, mobile: parsed.mobile, token: parsed.token });
      },
    });
    delivery.start();

    // Start all 50 parallel slots!
    const startRes = await manager.startAll();
    assert.equal(startRes.started, 50);

    // Let cluster churn until >= 60 accounts created AND trigger watchdog tick for Slot 49
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await manager._watchdogTick();
      const total = db.getThroughputStats().totalSessions;
      if (total >= 60 && slot49Recovered && slot50BotSwitched) break;
      await new Promise((r) => setTimeout(r, 60));
    }

    const snap = manager.getDashboardSnapshot();
    assert.ok(snap.throughput.totalSessions >= 60, `Expected >= 60 sessions, got ${snap.throughput.totalSessions}`);
    assert.ok(snap.deadCount >= 1, 'Slot 48 must be marked dead');
    assert.ok(alerts.some((a) => a.slotNo === 48 && a.severity === 'dead'), 'Owner alert must fire for dead slot 48');
    assert.equal(slot49Recovered, true, 'Watchdog must recover stuck slot 49');
    assert.equal(slot50BotSwitched, true, 'Slot 50 must auto-failover from hathi to hermes');

    // Stop cluster cleanly
    await manager.stopAll({ gracefulMs: 5_000, persistStopped: false });

    // Verify ZERO duplicate phone numbers across all 50 parallel workers!
    const uniqueVerified = new Set(verifiedPhones);
    assert.equal(uniqueVerified.size, verifiedPhones.length, 'ZERO duplicate signups allowed across 50 slots');
    // Collision phone should have been verified AT MOST once
    assert.ok(verifiedPhones.filter((p) => p === collisionPhone).length <= 1);

    // Wait briefly for DeliveryWorker to drain most items, then simulate mid-drain restart!
    await new Promise((r) => setTimeout(r, 250));
    await delivery.stop({ drainMs: 2_000 });

    const createdTotal = db.getThroughputStats().totalSessions;
    db.close();

    // ── RESTART PERSISTENCE CHECK ────────────────────────────────────────────
    // Reopen fresh ToingDb from same disk file (simulates Railway container restart!)
    const db2 = new ToingDb({
      dbPath,
      dataDir: dir,
      encryptionKey: 'cluster-secret-key',
      sessionsDir: path.join(dir, 'sessions'),
    });

    assert.equal(db2.listAccounts({ includeSession: true }).length, 50);
    assert.equal(db2.getAccountBySlotNo(1, { includeSession: true }).session, bulk[0].session);
    assert.equal(db2.getAccountBySlotNo(48).healthStatus, 'dead');
    assert.equal(db2.getThroughputStats().totalSessions, createdTotal);
    assert.equal(db2.isPhoneBlocked(collisionPhone), true, 'Used phone cooldown must survive restart');

    // Re-start DeliveryWorker on reopened DB -> drains any remaining pending .json files!
    const delivery2 = new DeliveryWorker({
      db: db2,
      getGapMs: () => 2,
      pollIntervalMs: 10,
      sendDocument: async ({ chatId, buffer, filename }) => {
        const parsed = JSON.parse(buffer.toString('utf8'));
        deliveredDocs.push({ chatId, filename, mobile: parsed.mobile, token: parsed.token });
      },
    });
    delivery2.start();
    const drainDeadline = Date.now() + 5_000;
    while (Date.now() < drainDeadline) {
      const ds = db2.getDeliveryStats();
      if (ds.pending === 0 && ds.sent >= createdTotal) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await delivery2.stop({ drainMs: 2_000 });

    const finalDeliveryStats = db2.getDeliveryStats();
    assert.equal(finalDeliveryStats.pending, 0, 'All pending deliveries must drain after restart');
    assert.equal(finalDeliveryStats.failed, 0, 'Zero failed deliveries');
    assert.equal(finalDeliveryStats.sent, createdTotal, '100% of created accounts must be delivered as .json');
    assert.equal(deliveredDocs.length, createdTotal);

    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Health HTTP Server
// ---------------------------------------------------------------------------
test('Health server serves /health and /metrics JSON', async () => {
  const server = await startHealthServer({
    port: 0,
    getHealthSnapshot: () => ({
      desiredRunning: true,
      totalSlots: 30,
      runningCount: 28,
      readyCount: 27,
      cooldownCount: 1,
      deadCount: 2,
      throughput: { rate1m: 26, rate5m: 24.4, rate15m: 22.1, hitRate5m: 62, totalSessions: 412 },
      delivery: { pending: 2, sent: 410, failed: 0 },
    }),
  });
  try {
    const addr = server.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.slots.total, 30);
    assert.equal(json.throughput.rate1m, 26);

    const mRes = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
    assert.equal(mRes.status, 200);
    const mJson = await mRes.json();
    assert.equal(mJson.delivery.sent, 410);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// 8. Phone Login Delivery Formatter & QR Code Generation
// ---------------------------------------------------------------------------
test('Login delivery formatter distinguishes App vs SMS & QR token encodes cleanly to PNG', async () => {
  const appInfo = formatCodeDeliverySummary({ type: 'app', nextType: 'sms', length: 5 });
  assert.equal(appInfo.type, 'app');
  assert.equal(appInfo.nextType, 'sms');
  assert.match(appInfo.channelLine, /Telegram App/i);

  const smsInfo = formatCodeDeliverySummary({ type: 'sms', nextType: 'call', length: 5 });
  assert.equal(smsInfo.type, 'sms');
  assert.match(smsInfo.channelLine, /SMS/i);
  assert.match(smsInfo.tipLine, /\/addqr/i);

  const token = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 250, 251, 252]);
  const qrUrl = qrLoginUrlFromToken(token);
  assert.ok(qrUrl.startsWith('tg://login?token='));
  const encodedToken = qrUrl.slice('tg://login?token='.length);
  assert.equal(encodedToken.includes('+'), false);
  assert.equal(encodedToken.includes('/'), false);
  assert.equal(encodedToken.includes('='), false);

  const png = await QRCode.toBuffer(qrUrl, { width: 256, margin: 2 });
  assert.ok(Buffer.isBuffer(png) && png.length > 200);
  assert.equal(png[0], 0x89); // PNG magic byte
  assert.equal(png[1], 0x50); // 'P'
});

// ---------------------------------------------------------------------------
// 9. Already-Registered Immediate Skip (Zero OTP Sent) + Per-Number Reason Log
// ---------------------------------------------------------------------------
test('Already-registered numbers are skipped BEFORE send_otp, persisted in cooldown & every number logs exact reason', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({
      dbPath: path.join(dir, 'toing.db'),
      dataDir: dir,
      encryptionKey: 'skip-reg-key',
      sessionsDir: path.join(dir, 'sessions'),
    });

    // Pre-seed one used number to verify used_cooldown reason logging
    db.markNumberUsed('9111111111', { status: 'seed', cooldownDays: 30, source: 'seed' });

    const added = db.addAccount({
      session: '1BVtsMOCK_SKIP_REGISTERED_TEST_SESSION_00001',
      label: 'SkipTest-1',
      otpBotProfile: 'hathi',
    });
    assert.equal(added.ok, true);
    const acc = db.getAccountById(added.id, { includeSession: true });

    // Queue of numbers returned by the mock OTP bot:
    //   1) 9111111111 -> already in seed used_numbers (must skip: used_cooldown, 0 check_mobile, 0 send_otp)
    //   2) 9222222222 -> check_mobile returns { registered: true } (must skip: already_registered, 0 send_otp!)
    //   3) 9333333333 -> check_mobile returns HTTP 409 "Already Registered! This mobile number is already registered." (must skip: already_registered, 0 send_otp!)
    //   4) 9444444444 -> check_mobile fails with 502 (must safe-skip: check_mobile_failed, 0 send_otp!)
    //   5) 9555555555 -> FRESH (registered: false) -> send_otp -> OTP timeout (must drop: otp_timeout + short cooldown)
    //   6) 9666666666 -> FRESH (registered: false) -> send_otp -> verify -> export -> created_new!
    const phoneQueue = [
      '9111111111',
      '9222222222',
      '9333333333',
      '9444444444',
      '9555555555',
      '9666666666',
    ];
    const sendOtpCalls = [];
    const watermarkCalls = [];
    const forceNewArgs = [];

    const mockFetch = async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (url.endsWith('/api/auth/check_mobile')) {
        if (body.mobile === '9222222222') {
          return new Response(JSON.stringify({ registered: true, message: 'Already Registered! This mobile number is already registered.' }), { status: 200 });
        }
        if (body.mobile === '9333333333') {
          return new Response(JSON.stringify({ error: 'Already Registered! This mobile number is already registered.' }), { status: 409 });
        }
        if (body.mobile === '9444444444') {
          return new Response(JSON.stringify({ error: 'upstream 502' }), { status: 502 });
        }
        return new Response(JSON.stringify({ registered: false }), { status: 200 });
      }
      if (url.endsWith('/api/auth/send_otp')) {
        sendOtpCalls.push(body.mobile);
        return new Response(JSON.stringify({ success: true, sid: `sid_${body.mobile}`, tid: `tid_${body.mobile}`, device_id: 'dev1' }), { status: 200 });
      }
      if (url.endsWith('/api/auth/verify_otp')) {
        return new Response(JSON.stringify({ success: body.otp === '777888' }), { status: 200 });
      }
      if (url.includes('/export')) {
        return new Response(JSON.stringify({
          success: true,
          export: { mobile: '9666666666', name: 'FreshUser', token: 'tok_fresh', sid: 'sid_9666666666', tid: 'tid_9666666666', deviceId: 'dev1', customerId: 'c_fresh' },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const toingClient = new ToingClient({
      getBaseUrl: () => 'https://storelex.store/toing_web',
      getAccessKeys: () => ['TEST-KEY'],
      concurrency: 10,
      fetchImpl: mockFetch,
    });

    let clientCreateCount = 0;
    const worker = new SlotWorker({
      account: acc,
      db,
      toingClient,
      getRuntimeConfig: () => ({
        telegramApiId: 12345,
        telegramApiHash: 'hash',
        claimTimeoutMs: 2_000,
        claimLockTtlMs: 60_000,
        otpTimeoutMs: 500,
        otpRefreshMs: 100,
        usedCooldownDays: 30,
        deliveryChatId: '6484999726',
        skipRegistered: true,
        otpTimeoutCooldownMin: 10,
        slotJitterMinMs: 0,
        slotJitterMaxMs: 0,
        claimFailBackoffMs: 10,
      }),
      clientFactory: () => {
        clientCreateCount += 1;
        return {
          connected: false,
          async connect() { this.connected = true; return { ok: true, me: 'SkipTest' }; },
          async disconnect() { this.connected = false; },
          setBotProfile() {},
          async claimFreshNumber({ forceNew }) {
            forceNewArgs.push(forceNew);
            const next = phoneQueue.shift();
            if (!next) return { ok: false, reason: 'queue_empty' };
            return { ok: true, phone: next, card: { phone: next }, reusedOnScreen: !forceNew };
          },
          async captureOtpWatermark(phone) {
            watermarkCalls.push(phone);
            return { ids: [], codes: [], ts: Date.now(), afterMs: Date.now(), messageId: 1 };
          },
          async waitForOtp(phone) {
            if (phone === '9555555555') {
              return { ok: false, code: '', timeout: true, attempts: 3, elapsedMs: 500 };
            }
            return { ok: true, code: '777888', sender: 'SWIGGY', elapsedMs: 120 };
          },
        };
      },
    });

    // Run 5 cycles covering all 6 numbers (cycle 1 fast-skips 9111111111 then checks 9222222222)
    for (let i = 0; i < 5; i++) {
      await worker._runSingleCycle();
    }

    // CRITICAL ASSERTION 1: send_otp was NEVER called on registered or failed-check numbers!
    assert.deepEqual(sendOtpCalls, ['9555555555', '9666666666']);
    assert.deepEqual(watermarkCalls, ['9555555555', '9666666666'], 'Watermark TG RPC must not be wasted on registered numbers');

    // CRITICAL ASSERTION 2: First claim uses forceNew=false (reuses untouched card on screen!)
    assert.equal(forceNewArgs[0], false);
    assert.equal(forceNewArgs[1], true);

    // CRITICAL ASSERTION 3: Client was created ONCE and reused across all 5 cycles (zero churn!)
    assert.equal(clientCreateCount, 1);

    // CRITICAL ASSERTION 4: Already-registered & otp_timeout numbers are persisted in used_numbers!
    assert.equal(db.isPhoneBlocked('9222222222'), true, 'registered=true must be persisted in used_numbers');
    assert.equal(db.isPhoneBlocked('9333333333'), true, '409 Already Registered must be persisted in used_numbers');
    assert.equal(db.isPhoneBlocked('9444444444'), false, 'transient check_mobile 502 must NOT 30d-ban phone');
    assert.equal(db.isPhoneBlocked('9555555555'), true, 'otp_timeout must put dead SIM in short cooldown');
    assert.equal(db.isPhoneBlocked('9666666666'), true, 'created account must be in 30d cooldown');

    // CRITICAL ASSERTION 5: Every single number has an explicit persisted reason in number_events!
    const events = db.getRecentNumberEvents(20);
    const byPhone = new Map(events.map((e) => [e.phone, e]));
    assert.equal(byPhone.get('9111111111')?.reason, 'used_cooldown');
    assert.equal(byPhone.get('9222222222')?.reason, 'already_registered');
    assert.equal(byPhone.get('9333333333')?.reason, 'already_registered');
    assert.equal(byPhone.get('9444444444')?.reason, 'check_mobile_failed');
    assert.equal(byPhone.get('9555555555')?.reason, 'otp_timeout');
    assert.equal(byPhone.get('9666666666')?.reason, 'created_new');

    const summary = db.getNumberEventSummary(60_000);
    assert.equal(summary.byReason.already_registered, 2);
    assert.equal(summary.byReason.used_cooldown, 1);
    assert.equal(summary.byReason.check_mobile_failed, 1);
    assert.equal(summary.byReason.otp_timeout, 1);
    assert.equal(summary.byReason.created_new, 1);

    const stats = db.getThroughputStats();
    assert.equal(stats.alreadyRegistered5m, 2);
    assert.equal(stats.totalSessions, 1);

    await worker.stop();
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. BOT_RESPONSE_TIMEOUT & FLOOD_WAIT Do NOT Destroy Healthy MTProto Clients
// ---------------------------------------------------------------------------
test('BOT_RESPONSE_TIMEOUT is non-fatal bot-ui (never a connection error) & FLOOD_WAIT preserves client', () => {
  const botTimeoutErr = new Error('400: BOT_RESPONSE_TIMEOUT');
  const classified = classifyTelegramError(botTimeoutErr);
  assert.equal(classified.code, 'BOT_RESPONSE_TIMEOUT');
  assert.equal(classified.kind, 'bot-ui');
  assert.equal(classified.cooldownMs, 0);
  assert.equal(isConnectionError(botTimeoutErr), false, 'BOT_RESPONSE_TIMEOUT must NOT disconnect TelegramClient!');

  const queryErr = new Error('400: QUERY_ID_INVALID');
  assert.equal(classifyTelegramError(queryErr).kind, 'bot-ui');
  assert.equal(isConnectionError(queryErr), false);

  const notModErr = new Error('400: MESSAGE_NOT_MODIFIED');
  assert.equal(classifyTelegramError(notModErr).kind, 'bot-ui');
  assert.equal(isConnectionError(notModErr), false);

  // Real socket errors still trigger reconnect
  assert.equal(isConnectionError(new Error('ECONNRESET: socket hang up')), true);
  assert.equal(isConnectionError(new Error('TIMEOUT: MTProto connect timed out (20s)')), true);
  assert.equal(isConnectionError(new Error('FLOOD_WAIT_30')), false, 'FLOOD_WAIT is rate-limit, NOT a dead TCP socket');
});

// ---------------------------------------------------------------------------
// 11. Short FLOOD_WAIT Proportional Cooldown, HTML Error Sanitizer & check_mobile Retry
// ---------------------------------------------------------------------------
test('Short FLOOD_WAIT scales proportionally, HTML 502 is sanitized & transient check_mobile retries once', async () => {
  // Proportional FLOOD_WAIT cooldowns (NO artificial 30s penalty on FLOOD_WAIT_3!)
  const fw3 = classifyTelegramError(new Error('420: FLOOD_WAIT_3 (caused by messages.GetHistory)'));
  assert.equal(fw3.kind, 'flood');
  assert.equal(fw3.seconds, 3);
  assert.equal(fw3.cooldownMs, 5_000);

  const fw10 = classifyTelegramError(new Error('420: FLOOD_WAIT_10'));
  assert.equal(fw10.cooldownMs, 12_000);

  const fw45 = classifyTelegramError(new Error('420: FLOOD_WAIT_45'));
  assert.equal(fw45.cooldownMs, 47_000);

  // HTML error sanitization (nginx 502 page -> clean 1-line title)
  const html502 = `<html>\n<head><title>502 Bad Gateway</title></head>\n<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body>\n</html>`;
  assert.equal(sanitizeErrorText(html502), '502 Bad Gateway');

  // Swiggy send_otp block duration parser
  assert.equal(parseSendOtpCooldownMs('Number of login attempts exceeded. Please retry after 2 hours.'), 2 * 60 * 60_000);
  assert.equal(parseSendOtpCooldownMs('Swiggy is blocking OTPs for this number right now. Try again in 5 min.'), 10 * 60_000);
  assert.equal(parseSendOtpCooldownMs('Swiggy is blocking OTPs for this number right now. Try again in 25 min.'), 25 * 60_000);
  assert.equal(parseSendOtpCooldownMs('Too many attempts, temporarily blocked'), 30 * 60_000);
  assert.equal(parseSendOtpCooldownMs('Network connection reset'), 0);

  // checkMobile automatically retries once on HTTP 200 upstream "Expecting value: line 1 column 1"
  let checkCalls = 0;
  const toing = new ToingClient({
    getBaseUrl: () => 'https://storelex.store/toing_web',
    getAccessKeys: () => ['K1'],
    fetchImpl: async () => {
      checkCalls += 1;
      if (checkCalls === 1) {
        return new Response(JSON.stringify({ error: 'Expecting value: line 1 column 1 (char 0)' }), { status: 200 });
      }
      return new Response(JSON.stringify({ registered: false }), { status: 200 });
    },
  });
  const res = await toing.checkMobile('9876543210');
  assert.equal(res.ok, true);
  assert.equal(res.registered, false);
  assert.equal(res.isNew, true);
  assert.equal(checkCalls, 2);
});

// ---------------------------------------------------------------------------
// 12. Swiggy send_otp_blocked Persists Cooldown So Other Slots Never Retry It
// ---------------------------------------------------------------------------
test('Swiggy send_otp_blocked saves cooldown to used_numbers so a second slot skips immediately', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({
      dbPath: path.join(dir, 'toing.db'),
      dataDir: dir,
      encryptionKey: 'swiggy-block-key',
      sessionsDir: path.join(dir, 'sessions'),
    });

    const a1 = db.addAccount({ session: '1BVtsBLOCK_TEST_SLOT_1_AAAAAAAAAAAAAAAAAAAA', label: 'S1', otpBotProfile: 'hathi' });
    const a2 = db.addAccount({ session: '1BVtsBLOCK_TEST_SLOT_2_BBBBBBBBBBBBBBBBBBBB', label: 'S2', otpBotProfile: 'hathi' });
    const acc1 = db.getAccountById(a1.id, { includeSession: true });
    const acc2 = db.getAccountById(a2.id, { includeSession: true });

    const sendOtpLog = [];
    const toingClient = new ToingClient({
      getBaseUrl: () => 'https://storelex.store/toing_web',
      getAccessKeys: () => ['KEY1'],
      fetchImpl: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url.endsWith('/api/auth/check_mobile')) {
          return new Response(JSON.stringify({ registered: false }), { status: 200 });
        }
        if (url.endsWith('/api/auth/send_otp')) {
          sendOtpLog.push(body.mobile);
          return new Response(JSON.stringify({
            error: 'Number of login attempts exceeded. Please retry after 2 hours.',
          }), { status: 400 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    const runtimeCfg = () => ({
      telegramApiId: 123,
      telegramApiHash: 'abc',
      claimTimeoutMs: 5_000,
      claimLockTtlMs: 30_000,
      otpTimeoutMs: 5_000,
      otpRefreshMs: 1_000,
      skipRegistered: true,
      usedCooldownDays: 30,
      autoFailoverBots: false,
      deliveryChatId: '1',
      primaryOwnerId: '1',
    });

    const makeMockClient = (phones) => {
      let i = 0;
      return {
        connected: true,
        async connect() { return { ok: true, me: 'mock' }; },
        async disconnect() {},
        setBotProfile() {},
        async claimFreshNumber() {
          const p = phones[i++];
          return p ? { ok: true, phone: p, card: { phone: p } } : { ok: false, reason: 'empty' };
        },
        async captureOtpWatermark() { return { ids: [], codes: [], ts: Date.now() }; },
        async waitForOtp() { return { ok: false, timeout: true }; },
      };
    };

    const w1 = new SlotWorker({
      account: acc1,
      db,
      toingClient,
      getRuntimeConfig: runtimeCfg,
      clientFactory: () => makeMockClient(['9411551427']),
    });
    await w1._runSingleCycle();

    assert.deepEqual(sendOtpLog, ['9411551427']);
    assert.equal(db.isPhoneBlocked('9411551427'), true, 'Swiggy-blocked phone must enter cooldown in used_numbers');
    const usedRow = db.getUsedNumber('9411551427');
    assert.equal(usedRow?.status, 'send_otp_blocked');
    assert.ok(usedRow.cooldownUntil - Date.now() > 110 * 60_000, 'Cooldown must reflect ~2 hour retry window');

    // Slot #2 gets the exact same phone -> must skip via used_cooldown with ZERO send_otp calls!
    const w2 = new SlotWorker({
      account: acc2,
      db,
      toingClient,
      getRuntimeConfig: runtimeCfg,
      clientFactory: () => makeMockClient(['9411551427']),
    });
    await w2._runSingleCycle();

    assert.deepEqual(sendOtpLog, ['9411551427'], 'Slot #2 must NEVER retry a Swiggy-blocked phone!');
    const events = db.getRecentNumberEvents(10);
    assert.ok(events.some((e) => e.phone === '9411551427' && e.reason === 'send_otp_blocked'));
    assert.ok(events.some((e) => e.phone === '9411551427' && e.reason === 'used_cooldown' && Number(e.slot_no) === 2));

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 13. Pool-Exhaustion Auto-Rotation & Spread Across All 3 OTP Bots
// ---------------------------------------------------------------------------
test('Pool-exhaustion auto-rotation switches bots after threshold & spreadSlotsAcrossBots balances all 3 bots', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({
      dbPath: path.join(dir, 'toing.db'),
      dataDir: dir,
      encryptionKey: 'spread-rotate-key',
      sessionsDir: path.join(dir, 'sessions'),
    });

    for (let i = 1; i <= 6; i++) {
      db.addAccount({
        session: `1BVtsSPREAD_TEST_SESSION_00000000000000000_${i}`,
        label: `Slot-${i}`,
        otpBotProfile: 'hathi',
      });
    }

    const toingClient = new ToingClient({
      getBaseUrl: () => 'https://storelex.store/toing_web',
      getAccessKeys: () => ['K1'],
      fetchImpl: async () => new Response(JSON.stringify({ registered: true }), { status: 200 }),
    });

    const mgr = new SlotManager({
      db,
      toingClient,
      getRuntimeConfig: () => ({ maxSlots: 50 }),
    });

    const spread = mgr.spreadSlotsAcrossBots();
    assert.equal(spread.updated, 6);
    assert.deepEqual(spread.distribution, { hathi: 2, hermes: 2, chauhan: 2 });

    // Now test pool-exhaustion auto-rotation on Slot #1 (starts on hathi -> rotates to hermes after 3 consecutive skips)
    db.markNumberUsed('9000000001', { status: 'seed', cooldownDays: 30 });
    db.markNumberUsed('9000000002', { status: 'seed', cooldownDays: 30 });
    db.markNumberUsed('9000000003', { status: 'seed', cooldownDays: 30 });

    const acc1 = db.getAccountBySlotNo(1, { includeSession: true });
    assert.equal(acc1.otpBotProfile, 'hathi');

    const switchedProfiles = [];
    const queue = ['9000000001', '9000000002', '9000000003'];
    let idx = 0;

    const worker = new SlotWorker({
      account: acc1,
      db,
      toingClient,
      getRuntimeConfig: () => ({
        telegramApiId: 123,
        telegramApiHash: 'abc',
        claimTimeoutMs: 5_000,
        claimLockTtlMs: 30_000,
        autoFailoverBots: true,
        poolRotateThreshold: 3,
        skipRegistered: true,
        usedCooldownDays: 30,
      }),
      clientFactory: () => ({
        connected: true,
        async connect() { return { ok: true, me: 'mock' }; },
        async disconnect() {},
        setBotProfile(pid) { switchedProfiles.push(pid); },
        async claimFreshNumber() {
          const p = queue[idx++];
          return p ? { ok: true, phone: p, card: { phone: p } } : { ok: false, reason: 'empty' };
        },
        async captureOtpWatermark() { return { ids: [], codes: [], ts: Date.now() }; },
        async waitForOtp() { return { ok: false, timeout: true }; },
      }),
    });

    await worker._runSingleCycle();
    assert.equal(worker.otpBotProfile, 'hermes', 'Worker must rotate from hathi -> hermes after 3 consecutive pool skips');
    assert.deepEqual(switchedProfiles, ['hermes']);
    assert.equal(db.getAccountBySlotNo(1).otpBotProfile, 'hermes');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 14. Push-Driven TelegramSlotClient Eliminates Polling messages.GetHistory RPCs
// ---------------------------------------------------------------------------
test('Push-driven TelegramSlotClient claims fresh cards and catches OTP edits with zero polling GetHistory calls', async () => {
  const slotClient = new TelegramSlotClient({
    slotId: 1,
    slotNo: 1,
    label: 'PushSlot',
    session: '1BVtsMOCK_PUSH_SESSION_12345678901234567890',
    apiId: 12345,
    apiHash: 'hash123',
    otpBotProfile: 'hathi',
  });

  const botId = '777000111';
  const handlers = [];
  let getMessagesCalls = 0;
  let newNumberClicks = 0;
  let refreshClicks = 0;

  const makeCardMessage = ({ id, phone, editDate = 0, otpText = '' }) => ({
    id,
    out: false,
    date: Math.floor(Date.now() / 1000),
    editDate,
    peerId: { userId: botId },
    chatId: botId,
    message: otpText
      ? `📱 Number: +91 ${phone}\n\n💬 SMS from SWIGGY: Your Toing OTP is ${otpText}`
      : `📱 Number: +91 ${phone}\n🇮🇳 India — Waiting for SMS...`,
    buttons: [[
      {
        text: '🔄 REFRESH',
        async click() {
          refreshClicks += 1;
          return { message: 'Refreshed' };
        },
      },
      {
        text: '📞 NEW NUMBER',
        async click() {
          newNumberClicks += 1;
          // Simulate real @Hathi_otp_bot editing the card 40ms later via Telegram MTProto push!
          setTimeout(() => {
            const edited = makeCardMessage({
              id: 101,
              phone: '9888777666',
              editDate: Math.floor(Date.now() / 1000) + 1,
            });
            for (const h of handlers) h({ message: edited });
          }, 40);
          return { message: 'New number assigned' };
        },
      },
    ]],
  });

  const mockMtClient = {
    connected: true,
    disconnected: false,
    _destroyed: false,
    addEventHandler(fn) {
      handlers.push(fn);
    },
    async getEntity() {
      return { id: botId, username: 'Hathi_otp_bot' };
    },
    async getInputEntity(e) {
      return e;
    },
    async getMessages() {
      getMessagesCalls += 1;
      return [makeCardMessage({ id: 101, phone: '9111222333', editDate: Math.floor(Date.now() / 1000) - 5 })];
    },
    async sendMessage() {},
    async disconnect() {},
  };

  // Wire mock client directly & enable push handlers
  slotClient.client = mockMtClient;
  slotClient.connected = true;
  slotClient.entity = { id: botId, username: 'Hathi_otp_bot' };
  slotClient.inputEntity = slotClient.entity;
  slotClient.entityUsername = 'Hathi_otp_bot';
  slotClient._attachPushHandlers(mockMtClient, {
    NewMessage: class MockNewMessage {},
    EditedMessage: class MockEditedMessage {},
  });
  assert.equal(slotClient._pushActive, true);

  // 1. Seed initial cache with 1 fetch, then claim a NEW number (forceNew=true) -> must catch push with 0 extra GetHistory!
  const claim = await slotClient.claimFreshNumber({
    forceNew: true,
    excludePhones: new Set(['9111222333']),
    timeoutMs: 5_000,
  });
  assert.equal(claim.ok, true);
  assert.equal(claim.phone, '9888777666');
  assert.equal(newNumberClicks, 1);
  assert.equal(getMessagesCalls, 1, 'Initial bootstrap fetch ONLY — zero GetHistory polling after clicking NEW NUMBER!');

  // 2. Capture watermark from warm push cache -> 0 GetHistory RPCs!
  const wm = await slotClient.captureOtpWatermark('9888777666');
  assert.equal(getMessagesCalls, 1, 'captureOtpWatermark must read warm push cache with 0 GetHistory RPCs!');

  // 3. Wait for OTP -> bot pushes edited card with OTP 60ms later -> caught instantly with 0 GetHistory RPCs!
  setTimeout(() => {
    const otpEdit = makeCardMessage({
      id: 101,
      phone: '9888777666',
      editDate: Math.floor(Date.now() / 1000) + 5,
      otpText: '482913',
    });
    for (const h of handlers) h({ message: otpEdit });
  }, 60);

  const otpRes = await slotClient.waitForOtp('9888777666', {
    baseline: wm,
    timeoutMs: 5_000,
    refreshMs: 2_000,
  });
  assert.equal(otpRes.ok, true);
  assert.equal(otpRes.code, '482913');
  assert.equal(getMessagesCalls, 1, 'waitForOtp must catch pushed OTP with ZERO polling GetHistory RPCs!');
  assert.ok(otpRes.elapsedMs < 1_000, `Expected instant push delivery (<1s), got ${otpRes.elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// 15. Single-Bot Pool Duplicates Do NOT Trigger False CLAIM_FAIL or 5s Backoff
// ---------------------------------------------------------------------------
test('Single-bot bot_returned_excluded / pool duplicates fast-yield without CLAIM_FAIL backoff', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({
      dbPath: path.join(dir, 'toing.db'),
      dataDir: dir,
      encryptionKey: 'single-bot-key',
      sessionsDir: path.join(dir, 'sessions'),
    });
    const added = db.addAccount({
      session: '1BVtsMOCK_SINGLE_BOT_POOL_DUPLICATE_TEST_00001',
      label: 'HathiOnly',
      otpBotProfile: 'hathi',
    });
    const acc = db.getAccountById(added.id, { includeSession: true });

    const toingClient = new ToingClient({
      getBaseUrl: () => 'https://storelex.store/toing_web',
      getAccessKeys: () => ['TEST-KEY'],
      fetchImpl: async () => new Response(JSON.stringify({ registered: false }), { status: 200 }),
    });

    const worker = new SlotWorker({
      account: acc,
      db,
      toingClient,
      getRuntimeConfig: () => ({
        telegramApiId: 12345,
        telegramApiHash: 'hash',
        claimTimeoutMs: 2_000,
        claimLockTtlMs: 60_000,
        autoFailoverBots: false,
        skipRegistered: true,
        claimFailBackoffMs: 2_500, // Would sleep 2.5s+ if falsely treated as CLAIM_FAIL!
      }),
      clientFactory: () => ({
        connected: false,
        async connect() { this.connected = true; return { ok: true, me: 'HathiOnly' }; },
        async disconnect() { this.connected = false; },
        async claimFreshNumber() {
          return { ok: false, reason: 'bot_returned_excluded', excludedPhonesSeen: ['9811111111'] };
        },
      }),
    });

    const t0 = Date.now();
    await worker._runSingleCycle();
    const elapsedMs = Date.now() - t0;

    assert.equal(worker.consecutiveClaimFails, 0, 'bot_returned_excluded must NOT increment consecutiveClaimFails');
    assert.equal(worker._lastCycleWasFastSkip, true, 'must mark fast skip for quick next scan');
    assert.ok(elapsedMs < 800, `Expected immediate yield (<800ms), got ${elapsedMs}ms`);
    const summary = db.getNumberEventSummary(60_000);
    assert.equal(summary.byReason.bot_duplicate || 0, 1);
    assert.equal(summary.byOutcome?.claim_fail || 0, 0, 'must NOT record a fake claim_fail event');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 16. Cooldown Breakdown, Selective Clear & Skip-Registered-OFF Bypass
// ---------------------------------------------------------------------------
test('getCooldownBreakdown, clearCooldownsByStatus & tryClaimPhone(ignoreAlreadyRegistered) work accurately', () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({
      dbPath: path.join(dir, 'toing.db'),
      dataDir: dir,
      encryptionKey: 'cool-ctrl-key',
      sessionsDir: path.join(dir, 'sessions'),
    });

    db.markNumberUsed('9000000001', { status: 'extracted', cooldownDays: 30, source: 'toing' });
    db.markNumberUsed('9000000002', { status: 'already_registered', cooldownDays: 30, source: 'toing_check' });
    db.markNumberUsed('9000000003', { status: 'seed', cooldownDays: 30, source: 'seed' });
    db.markNumberUsed('9000000004', { status: 'otp_timeout_cool', cooldownMs: 10 * 60_000, source: 'otp_timeout' });
    db.markNumberUsed('9000000005', { status: 'send_otp_blocked', cooldownMs: 2 * 3600_000, source: 'swiggy_block' });

    const bd = db.getCooldownBreakdown();
    assert.equal(bd.extracted, 1);
    assert.equal(bd.already_registered, 1);
    assert.equal(bd.seed, 1);
    assert.equal(bd.otp_timeout_cool, 1);
    assert.equal(bd.send_otp_blocked, 1);
    assert.equal(bd.total, 5);

    // Default tryClaimPhone blocks already_registered with remainingMs > 0
    const blocked = db.tryClaimPhone('9000000002', 1);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'cooldown');
    assert.equal(blocked.status, 'already_registered');
    assert.ok(blocked.remainingMs > 20 * 24 * 3600_000);

    // When Skip Registered is OFF (ignoreAlreadyRegistered=true), already_registered is claimable
    // while extracted/seed remain protected!
    const allowed = db.tryClaimPhone('9000000002', 1, { ignoreAlreadyRegistered: true });
    assert.equal(allowed.ok, true);
    db.releaseClaim('9000000002', 1);

    const stillBlockedExtracted = db.tryClaimPhone('9000000001', 1, { ignoreAlreadyRegistered: true });
    assert.equal(stillBlockedExtracted.ok, false);
    assert.equal(stillBlockedExtracted.status, 'extracted');

    // Selective clear temp (otp_timeout_cool + send_otp_blocked)
    const clearedTemp = db.clearCooldownsByStatus(['otp_timeout_cool', 'send_otp_blocked']);
    assert.equal(clearedTemp, 2);
    const bd2 = db.getCooldownBreakdown();
    assert.equal(bd2.otp_timeout_cool, 0);
    assert.equal(bd2.send_otp_blocked, 0);
    assert.equal(bd2.total, 3);

    // Selective clear seed only
    const clearedSeed = db.clearCooldownsByStatus(['seed']);
    assert.equal(clearedSeed, 1);
    assert.equal(db.getCooldownBreakdown().seed, 0);
    assert.equal(db.getCooldownBreakdown().total, 2);

    // Clear all remaining
    const clearedAll = db.clearCooldownsByStatus('all');
    assert.equal(clearedAll, 2);
    assert.equal(db.getCooldownBreakdown().total, 0);

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('17. BotClickPacer gives OTP REFRESH VIP priority over queued NEW NUMBER claims and widens claim gap under load', async () => {
  const pacer = new BotClickPacer({
    claimGapMs: 60,
    busyClaimGapMs: 140,
    congestedClaimGapMs: 220,
    refreshGapMs: 15,
    congestionWindowMs: 5_000,
  });

  // Base claim gap
  assert.equal(pacer.getClaimGapMs('hathi'), 60);

  // When a slot is waiting for OTP, claim gap widens automatically
  pacer.markOtpWaitStart('hathi');
  assert.equal(pacer.getClaimGapMs('hathi'), 140);

  // Congestion widens claim gap even further
  pacer.noteBotSlow('hathi');
  assert.equal(pacer.getClaimGapMs('hathi'), 220);

  pacer.markOtpWaitEnd('hathi');

  // Verify VIP priority: queue 2 claims, then immediately queue a refresh — refresh MUST jump ahead of claim #2!
  const order = [];
  const pacer2 = new BotClickPacer({ claimGapMs: 120, busyClaimGapMs: 120, congestedClaimGapMs: 120, refreshGapMs: 5 });
  const c1 = pacer2.acquire('hathi', { priority: 'claim' }).then((ok) => { order.push(`claim1:${ok}`); });
  const c2 = pacer2.acquire('hathi', { priority: 'claim' }).then((ok) => { order.push(`claim2:${ok}`); });
  // Slight tick so c1 executes immediately, c2 is waiting its 120ms gap, then VIP refresh arrives!
  await new Promise((r) => setTimeout(r, 15));
  const r1 = pacer2.acquire('hathi', { priority: 'refresh' }).then((ok) => { order.push(`refresh1:${ok}`); });

  await Promise.all([c1, c2, r1]);
  assert.deepEqual(order, ['claim1:true', 'refresh1:true', 'claim2:true']);
});

test('18. _safeClickButton soft timeout prevents 10s hangs on slow OTP bot callbacks and records congestion', async () => {
  const pacer = new BotClickPacer({
    claimGapMs: 350,
    busyClaimGapMs: 750,
    congestedClaimGapMs: 950,
    refreshGapMs: 120,
    congestionWindowMs: 10_000,
  });
  const client = new TelegramSlotClient({
    slotId: 1,
    slotNo: 1,
    label: 'SlowClick',
    session: 'dummy',
    apiId: 123,
    apiHash: 'abc',
    otpBotProfile: 'hathi',
    botPacer: pacer,
  });

  // Simulate a hung Telegram callback that rejects 5 seconds later
  const hungEntry = {
    button: {
      click() {
        return new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('BOT_RESPONSE_TIMEOUT')), 5_000);
          if (typeof t.unref === 'function') t.unref();
        });
      },
    },
  };

  const t0 = Date.now();
  const res = await client._safeClickButton(hungEntry, { timeoutMs: 1_500 });
  const elapsed = Date.now() - t0;

  assert.equal(res.clicked, true);
  assert.equal(res.softTimeout, true);
  assert.ok(elapsed < 2_500, `Expected soft timeout around 1.5s, got ${elapsed}ms`);
  // Must have flagged the bot as congested on the shared pacer
  assert.equal(pacer.getClaimGapMs('hathi'), 950);
});

test('19. Strict single-click on NEW NUMBER: never re-clicks while waiting across calls & returns immediately when any new card arrives', async () => {
  const handlers = [];
  let newNumberClicks = 0;

  const baseDateSec = Math.floor(Date.now() / 1000) - 5;
  const makeMsg = (id, text, editSec = 0) => ({
    id,
    out: false,
    date: baseDateSec,
    editDate: editSec || baseDateSec,
    peerId: { userId: 777001n },
    message: text,
    buttons: [[
      {
        text: '⏭ NEW NUMBER',
        async click() {
          newNumberClicks += 1;
          return { message: '🔍 Finding new number...' };
        },
      },
      { text: '🔄 REFRESH', async click() { return { message: 'ok' }; } },
    ]],
  });

  const emitPush = (msg) => {
    for (const h of handlers) h({ message: msg });
  };

  let historyMsgs = [makeMsg(200, '📱 Number: +91 9111222333\nStatus: Active')];
  const mockMtClient = {
    connected: true,
    disconnected: false,
    _destroyed: false,
    addEventHandler(fn) { handlers.push(fn); },
    async getMessages() { return historyMsgs; },
  };

  const client = new TelegramSlotClient({
    slotId: 1,
    slotNo: 1,
    label: 'StrictSingleClick',
    session: 'dummy',
    apiId: 123,
    apiHash: 'abc',
    otpBotProfile: 'hathi',
  });
  client.client = mockMtClient;
  client.connected = true;
  client.entity = { id: 777001n, username: 'Hathi_otp_bot' };
  client.inputEntity = client.entity;
  client.entityUsername = 'Hathi_otp_bot';
  client._attachPushHandlers(mockMtClient, {
    NewMessage: class MockNew {},
    EditedMessage: class MockEdit {},
  });

  // 1. Click NEW NUMBER once -> bot only sends a loading text, no phone yet -> returns pendingWait without re-clicking!
  setTimeout(() => {
    emitPush(makeMsg(201, '🔍 Searching for an active Indian number...', baseDateSec + 1));
  }, 40);

  const wait1 = await client.claimFreshNumber({
    forceNew: true,
    excludePhones: new Set(['9111222333']),
    timeoutMs: 300,
    pendingMaxWaitMs: 5_000,
  });
  assert.equal(wait1.ok, false);
  assert.equal(wait1.reason, 'claim_waiting');
  assert.equal(wait1.pendingWait, true);
  assert.equal(newNumberClicks, 1, 'Must click NEW NUMBER ONLY ONCE while waiting!');

  // 2. Next call MUST resume waiting for the SAME click (ZERO second click!) and catch the delayed new number!
  setTimeout(() => {
    const arrivedMsg = makeMsg(202, '📱 Number: +91 9777888999\nStatus: Active', baseDateSec + 2);
    historyMsgs = [arrivedMsg, ...historyMsgs];
    emitPush(arrivedMsg);
  }, 80);

  const wait2 = await client.claimFreshNumber({
    forceNew: true,
    excludePhones: new Set(['9111222333']),
    timeoutMs: 1_500,
    pendingMaxWaitMs: 5_000,
  });
  assert.equal(wait2.ok, true);
  assert.equal(wait2.phone, '9777888999');
  assert.equal(newNumberClicks, 1, 'Second call MUST NOT click NEW NUMBER again while previous click is pending!');

  // 3. After decision, next click returns an excluded number -> must return immediately for SlotWorker to decide (NO inner re-click!)
  setTimeout(() => {
    const dupMsg = makeMsg(203, '📱 Number: +91 9111222333\nStatus: Active', baseDateSec + 3);
    historyMsgs = [dupMsg, ...historyMsgs];
    emitPush(dupMsg);
  }, 60);

  const wait3 = await client.claimFreshNumber({
    forceNew: true,
    excludePhones: new Set(['9111222333', '9777888999']),
    timeoutMs: 1_500,
    pendingMaxWaitMs: 5_000,
  });
  assert.equal(wait3.ok, false);
  assert.equal(wait3.reason, 'bot_returned_excluded');
  assert.equal(wait3.arrivedNewCard, true);
  assert.deepEqual(wait3.excludedPhonesSeen, ['9111222333']);
  assert.equal(newNumberClicks, 2, 'Excluded arrival must return immediately with exactly 1 click (never double-click inside claimFreshNumber)');
});

test('20. selectLatestFreshNumberCard finds brand-new card id > cursorId even if old card was edited later and sits first', () => {
  const oldEditedCard = {
    id: 100,
    date: 1700000000,
    editDate: 1700000010, // edited AFTER new card arrived!
    message: '📱 Number: +91 98765 43210\nStatus: Active',
  };
  const brandNewCard = {
    id: 101,
    date: 1700000005,
    editDate: 1700000005,
    message: '📱 Number: +91 98765 43219\nStatus: Active',
  };

  // Even with oldEditedCard at index 0, brandNewCard (id=101 > cursorId=100) MUST be detected!
  const sel = selectLatestFreshNumberCard([oldEditedCard, brandNewCard], {
    afterMessageId: 100,
    afterPhone: '9876543210',
    afterSignature: '100|1700000000000|📱 Number: +91 98765 43210\nStatus: Active',
  });
  assert.equal(sel.status, 'fresh');
  assert.equal(sel.result.card.phone, '9876543219');
});

test('21. Default config (filter OFF) sends OTP & exports BOTH new and already-registered numbers', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({
      dbPath: path.join(dir, 'toing.db'),
      dataDir: dir,
      encryptionKey: 'all-num-filter-off-key',
      sessionsDir: path.join(dir, 'sessions'),
    });
    const added = db.addAccount({
      label: 'AllNumSlot',
      session: '1BVtsMOCK_ALL_NUMBERS_FILTER_OFF_SESSION_00001',
      otpBotProfile: 'hathi',
    });
    const acc = db.getAccountById(added.id, { includeSession: true });

    // Pre-populate one old already_registered row AND one extracted row
    db.markNumberUsed('9111111111', { status: 'already_registered', slotId: 99, cooldownDays: 30, source: 'old_filter' });
    db.markNumberUsed('9000000000', { status: 'extracted', slotId: 99, cooldownDays: 30, source: 'signup' });

    const sentPhones = [];
    const verifyPayloads = [];
    const phoneQueue = [
      '9000000000', // already extracted -> still skipped so we don't duplicate an already-exported session
      '9111111111', // previously marked already_registered + check_mobile registered=true -> MUST STILL GET OTP (is_new=false)!
      '9222222222', // brand new (registered=false) -> MUST GET OTP (is_new=true)!
      '9333333333', // check_mobile returns 502 error -> MUST STILL GET OTP (defaults is_new=false)!
    ];

    const toingClient = {
      async checkMobile(mobile) {
        if (mobile === '9111111111') return { ok: true, registered: true, isNew: false, key: 'K1' };
        if (mobile === '9222222222') return { ok: true, registered: false, isNew: true, key: 'K1' };
        return { ok: false, registered: null, isNew: false, error: 'HTTP 502 Bad Gateway' };
      },
      async sendOtp(mobile) {
        sentPhones.push(mobile);
        return { ok: true, sid: `sid-${mobile}`, tid: `tid-${mobile}`, deviceId: `dev-${mobile}`, key: 'K1', mobile };
      },
      async verifyOtp(payload) {
        verifyPayloads.push(payload);
        return { ok: true, key: 'K1', data: { success: true } };
      },
      async exportAccount(mobile, { otpState }) {
        return {
          ok: true,
          fallback: false,
          exportObj: { mobile, name: 'Test', token: `tok-${mobile}`, sid: otpState.sid, tid: otpState.tid, deviceId: otpState.deviceId, customerId: '1' },
        };
      },
    };

    const worker = new SlotWorker({
      account: acc,
      db,
      toingClient,
      // skipRegistered omitted (default OFF!)
      getRuntimeConfig: () => ({
        telegramApiId: 12345,
        telegramApiHash: 'hash',
        claimTimeoutMs: 2_000,
        claimLockTtlMs: 60_000,
        otpTimeoutMs: 500,
        otpRefreshMs: 100,
        usedCooldownDays: 30,
        deliveryChatId: '6484999726',
        slotJitterMinMs: 0,
        slotJitterMaxMs: 0,
      }),
      clientFactory: () => ({
        connected: false,
        async connect() { this.connected = true; return { ok: true, me: 'AllNum' }; },
        async disconnect() { this.connected = false; },
        setBotProfile() {},
        async claimFreshNumber() {
          const next = phoneQueue.shift();
          return next ? { ok: true, phone: next, card: { phone: next } } : { ok: false, reason: 'queue_empty' };
        },
        async captureOtpWatermark() { return { ids: [], codes: [], ts: Date.now(), afterMs: Date.now(), messageId: 1 }; },
        async waitForOtp() { return { ok: true, code: '654321', sender: 'SWIGGY', elapsedMs: 100 }; },
      }),
    });

    await worker._runSingleCycle(); // skips 9000000000 (extracted), processes 9111111111 (registered=true)
    await worker._runSingleCycle(); // processes 9222222222 (registered=false)
    await worker._runSingleCycle(); // processes 9333333333 (check_mobile failed)

    assert.deepEqual(sentPhones, ['9111111111', '9222222222', '9333333333']);
    assert.deepEqual(
      verifyPayloads.map((p) => ({ mobile: p.mobile, isNew: p.isNew })),
      [
        { mobile: '9111111111', isNew: false },
        { mobile: '9222222222', isNew: true },
        { mobile: '9333333333', isNew: false },
      ]
    );
    assert.equal(db.getThroughputStats().totalSessions, 3);

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('22. Suspended Swiggy account is persisted to used_numbers (30d) so no other slot retries it', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({
      dbPath: path.join(dir, 'toing.db'),
      dataDir: dir,
      encryptionKey: 'suspended-acct-key',
      sessionsDir: path.join(dir, 'sessions'),
    });
    const a1 = db.addAccount({ label: 'Susp1', session: '1BVtsMOCK_SUSPENDED_ACCOUNT_SLOT_1_000001', otpBotProfile: 'hathi' });
    const a2 = db.addAccount({ label: 'Susp2', session: '1BVtsMOCK_SUSPENDED_ACCOUNT_SLOT_2_000002', otpBotProfile: 'hathi' });
    const acc1 = db.getAccountById(a1.id, { includeSession: true });
    const acc2 = db.getAccountById(a2.id, { includeSession: true });

    const sendOtpCalls = [];
    const toingClient = new ToingClient({
      getBaseUrl: () => 'https://storelex.store/toing_web',
      getAccessKeys: () => ['K1'],
      fetchImpl: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url.endsWith('/api/auth/check_mobile')) {
          return new Response(JSON.stringify({ registered: true }), { status: 200 });
        }
        if (url.endsWith('/api/auth/send_otp')) {
          sendOtpCalls.push(body.mobile);
          return new Response(JSON.stringify({
            error: 'Your account is suspended. Please contact us through support@swiggy.in for further assistance',
          }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    const runtimeCfg = () => ({
      telegramApiId: 12345,
      telegramApiHash: 'hash',
      claimTimeoutMs: 2_000,
      claimLockTtlMs: 60_000,
      otpTimeoutMs: 10_000,
      otpRefreshMs: 500,
      cooldownDays: 30,
      deliveryChatId: '6484999726',
    });

    const makeWorker = (acc, queue) => new SlotWorker({
      account: acc,
      db,
      toingClient,
      getRuntimeConfig: runtimeCfg,
      clientFactory: () => ({
        connected: true,
        async connect() { return { ok: true, me: acc.label }; },
        async disconnect() {},
        setBotProfile() {},
        async claimFreshNumber() {
          const next = queue.shift();
          return next ? { ok: true, phone: next, card: { phone: next } } : { ok: false, reason: 'queue_empty' };
        },
        async captureOtpWatermark() { return { ids: [], codes: [], ts: Date.now(), afterMs: Date.now(), messageId: 1 }; },
        async waitForOtp() { return { ok: false, timeout: true, attempts: 0 }; },
      }),
    });

    const w1 = makeWorker(acc1, ['9905466527']);
    await w1._runSingleCycle();

    // Must have called send_otp exactly once and persisted suspended cooldown
    assert.deepEqual(sendOtpCalls, ['9905466527']);
    const bd = db.getCooldownBreakdown();
    assert.equal(bd.suspended, 1);

    // Slot #2 seeing the exact same suspended phone MUST skip at claim stage without hitting Toing send_otp again!
    const claimCheck = db.tryClaimPhone('9905466527', acc2.id, { ignoreAlreadyRegistered: true });
    assert.equal(claimCheck.ok, false);
    assert.equal(claimCheck.reason, 'cooldown');
    assert.equal(claimCheck.status, 'suspended');

    const w2 = makeWorker(acc2, ['9905466527']);
    await w2._runSingleCycle();
    assert.deepEqual(sendOtpCalls, ['9905466527'], 'second slot must NOT re-call send_otp on a suspended number');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('23. Stray/invalid OTP rejected by verify_otp keeps waiting on same sid/tid until real Swiggy OTP arrives', async () => {
  // First verify candidateIsNew ignores explicitly rejected codes even on newer message IDs
  assert.equal(
    candidateIsNew(
      { messageId: 500, idKey: '500|341401', ts: Date.now(), parsed: { code: '341401' } },
      { messageId: 400, ids: new Set(), codes: new Set(), rejectedCodes: new Set(['341401']) }
    ),
    false,
    'candidateIsNew must reject codes in baseline.rejectedCodes even if messageId > baseline.messageId'
  );
  assert.equal(
    candidateIsNew(
      { messageId: 501, idKey: '501|778899', ts: Date.now(), parsed: { code: '778899' } },
      { messageId: 400, ids: new Set(), codes: new Set(), rejectedCodes: new Set(['341401']) }
    ),
    true,
    'candidateIsNew must accept a different fresh Swiggy OTP code'
  );

  const dir = makeTmpDir();
  try {
    const db = new ToingDb({
      dbPath: path.join(dir, 'toing.db'),
      dataDir: dir,
      encryptionKey: 'wrong-otp-retry-key',
      sessionsDir: path.join(dir, 'sessions'),
    });
    const added = db.addAccount({ label: 'RetrySlot', session: '1BVtsMOCK_WRONG_OTP_RETRY_SLOT_000001', otpBotProfile: 'hathi' });
    const acc = db.getAccountById(added.id, { includeSession: true });

    let sendCount = 0;
    const verifyAttempts = [];
    const waitBaselines = [];

    const toingClient = {
      async checkMobile() { return { ok: true, registered: true, isNew: false, key: 'K1' }; },
      async sendOtp(mobile) {
        sendCount += 1;
        return { ok: true, sid: 'sid-keep-me', tid: 'tid-keep-me', deviceId: 'dev-1', key: 'K1', mobile };
      },
      async verifyOtp(payload) {
        verifyAttempts.push({ otp: payload.otp, sid: payload.sid, tid: payload.tid });
        if (payload.otp === '341401') {
          return { ok: false, reason: 'Invalid OTP. Please try again.' };
        }
        return { ok: true, key: 'K1', data: { success: true } };
      },
      async exportAccount(mobile, { otpState }) {
        return {
          ok: true,
          fallback: false,
          exportObj: { mobile, token: 'tok-ok', sid: otpState.sid, tid: otpState.tid, deviceId: otpState.deviceId, customerId: '9' },
        };
      },
    };

    const otps = ['341401', '778899'];
    const worker = new SlotWorker({
      account: acc,
      db,
      toingClient,
      getRuntimeConfig: () => ({
        telegramApiId: 12345,
        telegramApiHash: 'hash',
        claimTimeoutMs: 2_000,
        claimLockTtlMs: 60_000,
        otpTimeoutMs: 20_000,
        otpRefreshMs: 500,
        deliveryChatId: '6484999726',
      }),
      clientFactory: () => ({
        connected: true,
        async connect() { return { ok: true, me: 'RetrySlot' }; },
        async disconnect() {},
        setBotProfile() {},
        async claimFreshNumber() { return { ok: true, phone: '8709730860', card: { phone: '8709730860' } }; },
        async captureOtpWatermark() { return { ids: [], codes: [], ts: Date.now(), afterMs: Date.now(), messageId: 10 }; },
        async waitForOtp(_phone, opts) {
          waitBaselines.push(new Set(opts?.baseline?.rejectedCodes || []));
          const next = otps.shift();
          return next ? { ok: true, code: next, sender: next === '778899' ? 'SWIGGY' : '', elapsedMs: 200, attempts: 1 } : { ok: false, timeout: true };
        },
      }),
    });

    await worker._runSingleCycle();

    assert.equal(sendCount, 1, 'must reuse the SAME send_otp session without resending');
    assert.deepEqual(verifyAttempts, [
      { otp: '341401', sid: 'sid-keep-me', tid: 'tid-keep-me' },
      { otp: '778899', sid: 'sid-keep-me', tid: 'tid-keep-me' },
    ]);
    assert.equal(waitBaselines[0].has('341401'), false);
    assert.equal(waitBaselines[1].has('341401'), true, 'second waitForOtp must pass rejected stray code in baseline.rejectedCodes');
    assert.equal(db.getThroughputStats().totalSessions, 1, 'account must commit cleanly after real Swiggy OTP succeeds');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});





test('24. Firebase parsers support both pool schemas, bulk sources and fresh OTP selection', () => {
  const clients = _parseClientsPool({ device1: { mobNo: '+919111111111', online: true, sims: [{ phoneNumber: '9222222222' }] } });
  assert.deepEqual(clients.map((x) => x.phone), ['9111111111', '9222222222']);
  assert.equal(clients[0].deviceId, 'device1');
  assert.equal(clients[0].online, true);
  assert.deepEqual(_parsePool({ first: '9333333333', second: { mobile: '9444444444' } }).map((x) => x.phone), ['9333333333', '9444444444']);
  assert.equal(parseForwarderDateTime('23-10-2026 | 04:48 AM'), Date.UTC(2026, 9, 22, 23, 18));
  const parsed = parseFirebaseSourceBulkInput('https://alpha.firebaseio.com|secret\nbeta.firebasedatabase.app?auth=token\nnot-a-url');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].auth, 'secret');
  assert.equal(parsed.entries[1].auth, 'token');
  assert.equal(parsed.invalid.length, 1);
  const now = Date.now();
  const cands = [
    { idKey: 'old', code: '111111', ts: now, body: 'Swiggy' },
    { idKey: 'other', code: '222222', ts: now, body: 'Other service' },
    { idKey: 'new', code: '333333', ts: now - 1, body: 'Swiggy OTP' },
  ];
  const exclude = { ids: new Set(['old']), codes: new Set(['111111']), rejectedCodes: new Set() };
  assert.equal(pickBestFirebaseOtpCandidate(cands, exclude, now - 1000, now + 10000, now).code, '333333');
  exclude.rejectedCodes.add('333333');
  assert.equal(pickBestFirebaseOtpCandidate(cands, exclude, now - 1000, now + 10000, now), null);
  assert.equal(pickBestFirebaseOtpCandidate(cands, exclude, now - 1000, now - 1, now).code, '222222');
});

test('25. Firebase source seeding, encrypted auth, ranking, quarantine and deletion persist', () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({ dbPath: path.join(dir, 'db.sqlite'), dataDir: dir, encryptionKey: 'firebase-source-test-key' });
    assert.equal(BUILTIN_FIREBASE_SOURCE_URLS.length, 965);
    assert.equal(db.seedFirebaseSources().total, 965);
    // Ranked list: sabse zyada online devices wala DB primary + sabse pehle.
    assert.equal(db.listFirebaseSources()[0].url, 'https://tata-1d605-default-rtdb.firebaseio.com');
    const deadUrls = ['https://hospital-17-default-rtdb.firebaseio.com', 'https://b.firebaseio.com', 'https://n-ka-land-default-rtdb.firebaseio.com', 'https://8c69-default-rtdb.firebaseio.com', 'https://-default-rtdb.firebaseio.com'];
    assert.ok(BUILTIN_FIREBASE_SOURCE_URLS.every((u) => !deadUrls.includes(u.toLowerCase())), 'dead URLs seed list me nahi');
    const added = db.addFirebaseSourcesBulk('https://custom-source.firebaseio.com|secret-auth', { setFirstAsPrimary: true });
    assert.equal(added.added.length, 1);
    const id = added.added[0].id;
    assert.equal(db.getFirebaseSource(id).auth, 'secret-auth');
    const stored = db.db.prepare('SELECT auth_enc FROM firebase_sources WHERE id = ?').get(id);
    assert.ok(stored.auth_enc.startsWith('enc:v1:'));
    assert.ok(!stored.auth_enc.includes('secret-auth'));
    assert.equal(db.listFirebaseSources()[0].id, id);
    const now = Date.now();
    const other = db.listFirebaseSources()[1];
    db.recordFirebaseSourceResult(other.id, { ok: true, now });
    db.recordFirebaseSourceResult(id, { ok: false, now });
    db.recordFirebaseSourceResult(id, { ok: false, now: now + 1 });
    assert.equal(db.getFirebaseSource(id).quarantinedUntil, now + 1 + 30 * 60_000);
    const ranked = db.listFirebaseRunSources(now + 2);
    assert.equal(ranked[0].id, other.id);
    assert.equal(ranked.at(-1).id, id);
    assert.equal(db.setPrimaryFirebaseSource(other.id).ok, true);
    assert.equal(db.removeFirebaseSource(other.id).ok, true);
    db.seedFirebaseSources({ seedVersion: 5 });
    assert.equal(db.listFirebaseSources().some((s) => s.url === other.url), false);
    db.removeAllFirebaseSources();
    db.seedFirebaseSources({ seedVersion: 6 });
    assert.equal(db.listFirebaseSources().length, 0);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('25b. Naya seed version purani built-in list ERASE karta hai, custom sources safe rehte hain', () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({ dbPath: path.join(dir, 'db.sqlite'), dataDir: dir, encryptionKey: 'firebase-erase-test-key' });
    const oldList = ['https://old-a.firebaseio.com', 'https://old-b.firebaseio.com'];
    assert.equal(db.seedFirebaseSources({ builtinUrls: oldList, defaultUrl: '' }).total, 2);
    assert.equal(db.addFirebaseSourcesBulk('https://my-own.firebaseio.com').added.length, 1);
    assert.equal(db.listFirebaseSources().length, 3);

    const res = db.seedFirebaseSources({ builtinUrls: ['https://new-a.firebaseio.com'], defaultUrl: '', seedVersion: 9 });
    assert.equal(res.removedBuiltin, 2);
    const urls = db.listFirebaseSources().map((s) => s.url);
    assert.deepEqual(urls.sort(), ['https://my-own.firebaseio.com', 'https://new-a.firebaseio.com']);
    // Purani built-in URLs dobara seed par wapas nahi aati.
    db.seedFirebaseSources({ builtinUrls: oldList, defaultUrl: '', seedVersion: 9 });
    assert.equal(db.listFirebaseSources().length, 2);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('26. Firebase fresh-only gate, suspended cooldown and stray OTP retry deliver a fresh account', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({ dbPath: path.join(dir, 'db.sqlite'), dataDir: dir, encryptionKey: 'firebase-pipeline-test-key' });
    const source = { id: 'test', name: 'mock', url: 'https://mock.firebaseio.com' };
    let currentPhone = '';
    let messageStage = 0;
    let sends = 0;
    const attempts = [];
    const client = {
      async checkMobile(phone) { currentPhone = phone; return { ok: true, registered: phone === '9111111111', key: 'K1' }; },
      async sendOtp() {
        sends++;
        if (currentPhone === '9222222222') return { ok: false, suspended: true, reason: 'suspended' };
        messageStage = 1;
        return { ok: true, sid: 'same-sid', tid: 'same-tid', deviceId: 'toing-dev', key: 'K1' };
      },
      async verifyOtp(p) {
        attempts.push({ otp: p.otp, sid: p.sid, tid: p.tid, isNew: p.isNew });
        if (p.otp === '341401') { messageStage = 2; return { ok: false, reason: 'Invalid OTP' }; }
        return { ok: true };
      },
      async exportAccount(mobile) { return { ok: true, exportObj: { mobile, token: 'token', sid: 'same-sid', tid: 'same-tid' } }; },
    };
    const fetchImpl = async (url) => {
      const p = new URL(url).pathname;
      let data = null;
      if (p === '/messages/phone-device.json' && messageStage) {
        data = { wrong: { sender: 'SWIGGY', message: 'Swiggy OTP 341401' } };
        if (messageStage === 2) data.right = { sender: 'SWIGGY', message: 'Swiggy OTP 778899' };
      }
      return { ok: true, async json() { return data; }, async text() { return ''; } };
    };
    const manager = new FirebaseManager({ db, toingClient: client, fetchImpl, getRuntimeConfig: () => ({ usedCooldownDays: 30, claimLockTtlMs: 60000, firebaseOtpTimeoutMs: 20000, deliveryChatId: '123' }), otpInitialWaitMs: 0, logger: {} });
    manager.desiredRunning = true;
    const candidate = (phone) => ({ entry: { phone, deviceId: 'phone-device' }, source });
    assert.equal((await manager._processCandidate(1, candidate('9111111111'))).reason, 'already_registered');
    assert.equal(sends, 0);
    const reg = db.getUsedNumber('9111111111');
    assert.equal(reg.status, 'already_registered');
    assert.ok(reg.cooldownUntil - Date.now() > 29 * 86400000);
    assert.equal(db.isPhoneBlocked('9111111111', Date.now(), { ignoreAlreadyRegistered: true }), false);
    assert.equal((await manager._processCandidate(1, candidate('9222222222'))).reason, 'account_suspended');
    assert.equal(db.getUsedNumber('9222222222').status, 'suspended');
    assert.ok(db.getUsedNumber('9222222222').cooldownUntil - Date.now() > 29 * 86400000);
    const result = await manager._processCandidate(1, candidate('9333333333'));
    assert.equal(result.ok, true);
    assert.equal(sends, 2);
    assert.deepEqual(attempts, [
      { otp: '341401', sid: 'same-sid', tid: 'same-tid', isNew: true },
      { otp: '778899', sid: 'same-sid', tid: 'same-tid', isNew: true },
    ]);
    assert.equal(db.getThroughputStats().totalSessions, 1);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM delivery_queue WHERE status = 'pending'").get().n, 1);
    assert.equal(db.tryClaimPhone('9444444444', -1).ok, true);
    assert.equal(db.tryClaimPhone('9555555555', 1).ok, true);
    db.clearTelegramActiveClaims();
    assert.equal(db.isPhoneBlocked('9444444444'), true);
    assert.equal(db.isPhoneBlocked('9555555555'), false);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('27. Firebase manager scans a legacy pool and queues a fresh signup through running lanes', async () => {
  const dir = makeTmpDir();
  let manager;
  try {
    const db = new ToingDb({ dbPath: path.join(dir, 'db.sqlite'), dataDir: dir, encryptionKey: 'firebase-lanes-test-key' });
    db.addFirebaseSourcesBulk([{ url: 'https://fixture.firebaseio.com', numbersPath: 'numbers' }]);
    let sent = false;
    const fetchImpl = async (url) => {
      const p = new URL(url).pathname;
      const data = p === '/numbers.json' ? { one: '9666666666' }
        : p === '/otp/9666666666.json' && sent ? 'Swiggy OTP 778899' : null;
      return { ok: true, async json() { return data; }, async text() { return ''; } };
    };
    let completed;
    const done = new Promise((resolve) => { completed = resolve; });
    manager = new FirebaseManager({
      db, fetchImpl, logger: {}, otpInitialWaitMs: 0,
      getRuntimeConfig: () => ({ firebaseConcurrency: 2, firebaseOtpTimeoutMs: 10000, claimLockTtlMs: 60000, deliveryChatId: '123' }),
      toingClient: {
        async checkMobile() { return { ok: true, registered: false }; },
        async sendOtp() { sent = true; return { ok: true, sid: 's', tid: 't' }; },
        async verifyOtp() { return { ok: true }; },
        async exportAccount(mobile) { return { exportObj: { mobile, token: 'token' } }; },
      },
      onSignupSuccess: completed,
    });
    assert.equal((await manager.start()).ok, true);
    const result = await Promise.race([done, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('lane timed out')), 3000); t.unref(); })]);
    assert.equal(result.phone, '9666666666');
    assert.equal(db.getThroughputStats().totalSessions, 1);
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM delivery_queue').get().n, 1);
    await manager.stop({ gracefulMs: 500 });
    db.close();
  } finally {
    if (manager?.desiredRunning) await manager.stop({ gracefulMs: 500 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('28. OTP non-delivery demotes a readable source + quarantines the dead device', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({ dbPath: path.join(dir, 'db.sqlite'), dataDir: dir, encryptionKey: 'otp-health-key' });
    db.addFirebaseSourcesBulk([{ url: 'https://poolloads.firebaseio.com', numbersPath: 'numbers' }]);
    const src = db.listFirebaseSources()[0];
    const now = Date.now();

    // Pool loads fine -> "live" tier. But no OTP ever arrives.
    db.recordFirebaseSourceResult(src.id, { ok: true, ms: 120, now });
    assert.equal(db.getFirebaseSource(src.id).otpOkCount, 0);

    db.recordFirebaseOtpResult(src.id, { ok: false, sourceKey: src.url, deviceId: 'dev-1', now });
    assert.equal(db.getFirebaseSource(src.id).otpFailStreak, 1);
    assert.equal(db.getFirebaseSource(src.id).otpQuarantinedUntil, 0);
    db.recordFirebaseOtpResult(src.id, { ok: false, sourceKey: src.url, deviceId: 'dev-1', now: now + 1 });

    const after = db.getFirebaseSource(src.id);
    assert.equal(after.otpFailStreak, 0, 'streak resets once quarantined');
    assert.ok(after.otpQuarantinedUntil > now + 40 * 60_000, 'source rests ~45m on repeated non-delivery');
    // Read-health is untouched: the DB is still readable, it just cannot deliver.
    assert.equal(after.lastOkAt, now);

    // Dead device is skipped for 30m instead of blocking the whole source.
    assert.equal(db.listQuarantinedDevices(src).has('dev-1'), true);
    assert.equal(db.getDeviceOtpStats(src).quarantined, 1);

    // One real delivery clears everything and promotes the source to tier 0.
    db.recordFirebaseSourceResult(src.id, { ok: true, now: now + 2 });
    db.recordFirebaseOtpResult(src.id, { ok: true, sourceKey: src.url, deviceId: 'dev-2', latencyMs: 4_200, now: now + 3 });
    const healed = db.getFirebaseSource(src.id);
    assert.equal(healed.otpQuarantinedUntil, 0);
    assert.equal(healed.otpBestLatencyMs, 4_200, 'best OTP latency is remembered for adaptive timeouts');
    assert.equal(db.listFirebaseRunSources(now + 3)[0].id, src.id, 'OTP-proven source ranks first');

    // Reset health also clears device learning.
    db.resetFirebaseSourceHealth();
    assert.equal(db.getFirebaseSource(src.id).otpOkCount, 0);
    assert.equal(db.getDeviceOtpStats(src).total, 0);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('29. otp/<phone> fast path is still read when messages/<device> exists but has no new SMS', async () => {
  const dir = makeTmpDir();
  try {
    const db = new ToingDb({ dbPath: path.join(dir, 'db.sqlite'), dataDir: dir, encryptionKey: 'otp-fastpath-key' });
    const source = { id: 's', name: 'panel', url: 'https://otpfast.firebaseio.com' };
    let sent = false;
    const fetchImpl = async (url) => {
      const p = new URL(url).pathname;
      // Old SMS in the device inbox (pre-existing, must be ignored)...
      const data = p === '/messages/dev1.json' ? { '1': { sender: 'SWIGGY', message: 'Swiggy OTP 111111' } }
        // ...but the panel writes the fresh code only to otp/<phone>, which the
        // manager used to skip whenever a device node existed.
        : p === '/otp/9876543210.json' && sent ? 'Swiggy OTP 654321'
          : null;
      return { ok: true, async json() { return data; }, async text() { return ''; } };
    };
    const manager = new FirebaseManager({
      db, fetchImpl, logger: {}, otpInitialWaitMs: 0, otpPollMs: 50,
      getRuntimeConfig: () => ({ usedCooldownDays: 30, claimLockTtlMs: 60_000, firebaseOtpTimeoutMs: 20_000, deliveryChatId: '1' }),
      toingClient: {
        async checkMobile() { return { ok: true, registered: false }; },
        async sendOtp() { sent = true; return { ok: true, sid: 's', tid: 't' }; },
        async verifyOtp() { return { ok: true }; },
        async exportAccount(mobile) { return { exportObj: { mobile, token: 'tok' } }; },
      },
    });
    manager.desiredRunning = true;
    const res = await manager._processCandidate(1, { entry: { phone: '9876543210', deviceId: 'dev1' }, source });
    assert.equal(res.ok, true, 'fresh OTP from otp/<phone> must be found even with a device inbox present');
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('30. scanFreshDevices skips devices that are known non-deliverers', async () => {
  const { scanFreshDevices } = await import('../src/firebase-client.js');
  const source = { url: 'https://skip.firebaseio.com' };
  const now = Date.now();
  const entries = [
    { phone: '9111111111', deviceId: 'dead' },
    { phone: '9222222222', deviceId: 'live' },
  ];
  const probes = [];
  const fetchImpl = async (url) => {
    probes.push(url);
    const p = new URL(url).pathname;
    const data = p === '/messages/dead.json' ? { [String(now - 1000)]: { message: 'x' } }
      : p === '/messages/live.json' ? { [String(now - 1000)]: { message: 'y' } }
        : null;
    return { ok: true, async json() { return data; }, async text() { return ''; } };
  };
  const res = await scanFreshDevices(source, entries, {
    windowMs: 60_000, want: 2, backupCount: 2, skipDevices: new Set(['dead']), fetchImpl,
  });
  assert.equal(probes.some((u) => u.includes('/messages/dead.json')), false, 'dead device is never probed');
  assert.deepEqual(res.fresh.map((f) => f.entry.phone), ['9222222222']);
});
