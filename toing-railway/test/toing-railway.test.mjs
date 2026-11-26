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
