import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBotUi } from '../src/bot-ui.js';
import { REPORT_FILE, REPORT_KEY, parsePresenceReport, formatPresenceReport } from '../src/firebase-presence-report.js';

// Drive the registered UI callbacks without Telegram, Firebase or any worker.
function makeUi({ response = () => new Response('status\nactive\ninactive\nunknown\nactive') } = {}) {
  const handlers = new Map();
  const settings = new Map();
  const replies = [];
  const cfg = { ownerIds: ['7'], firebaseMode: true };
  const calls = { link: 0, fetch: 0 };
  let gate;
  const bot = {
    use(fn) { gate = fn; }, start() {},
    command(names, fn) { for (const name of [names].flat()) handlers.set(name, fn); },
    action(name, fn) { handlers.set(name, fn); }, on(name, fn) { handlers.set(name, fn); },
  };
  const db = {
    getSetting: (key) => settings.get(key), setSetting: (key, value) => settings.set(key, value),
    listFirebaseSources: () => [],
    getFirebaseHealthSummary: () => ({ total: 8, live: 0, failed: 0, quarantined: 0, neverTried: 8 }),
  };
  registerBotUi({
    bot, db, getRuntimeConfig: () => cfg,
    slotManager: { getDashboardSnapshot: () => ({ throughput: {}, delivery: {}, toing: { semaphore: {} }, stages: {} }) },
    fetchImpl: async (url) => { calls.fetch++; assert.equal(url, 'https://fixture.invalid/file'); return response(); },
  });
  const ctx = {
    chat: { type: 'private', id: 7 }, from: { id: 7 },
    message: { document: { file_id: 'file', file_name: REPORT_FILE } },
    telegram: { getFileLink: async () => { calls.link++; return 'https://fixture.invalid/file'; } },
    reply: async (text) => { replies.push(text); }, deleteMessage: async () => {}, answerCbQuery: async () => {},
  };
  return { ctx, cfg, settings, replies, calls, run: (name) => gate(ctx, () => handlers.get(name)(ctx)) };
}

test('report counts explicit states only, accepts UTF-8 BOM/CRLF and rejects an entire invalid update', () => {
  assert.deepEqual(parsePresenceReport('\ufeffstatus\r\n ACTIVE \r\n\r\ninactive\r\nunknown\r\nActive'), {
    counts: { active: 2, inactive: 1, unknown: 1 },
  });
  assert.deepEqual(parsePresenceReport('status\n'), { counts: { active: 0, inactive: 0, unknown: 0 } });
  for (const invalid of ['', 'active', 'status\nactive\nprivate-value', 'status\n__proto__']) {
    const res = parsePresenceReport(invalid);
    assert.ok(res.error);
    assert.equal(res.counts, undefined);
    assert.doesNotMatch(res.error, /private-value|__proto__/);
  }
  assert.match(formatPresenceReport(null), /Unknown/);
  assert.match(formatPresenceReport({ active: 'bad', uploadedAt: Date.now() }), /Unknown/);
  assert.match(formatPresenceReport({ active: 0, inactive: 0, unknown: 0, uploadedAt: 0 }), /<b>0<\/b> \/ 0 reported/);
});

test('report does not enter a pending source import; panel and both dashboard modes show saved counts', async () => {
  const ui = makeUi();
  await ui.run('firebase');
  assert.match(ui.replies.at(-1), /Active numbers \(file report\):<\/b> <i>Unknown/);
  await ui.run('fb_src_add');
  await ui.run('document');
  const { uploadedAt, ...counts } = ui.settings.get(REPORT_KEY);
  assert.ok(Number.isSafeInteger(uploadedAt));
  assert.deepEqual(counts, { active: 2, inactive: 1, unknown: 1 });
  assert.equal(ui.settings.size, 1);
  assert.match(ui.replies.at(-1), /Number report saved/);
  for (const [view, firebaseMode] of [['firebase', true], ['status', true], ['status', false]]) {
    ui.cfg.firebaseMode = firebaseMode;
    await ui.run(view);
    const text = ui.replies.at(-1);
    assert.match(text, /<b>2<\/b> \/ 4 reported/);
    assert.match(text, /Uploaded .* UTC · live Firebase count nahi/);
    assert.match(text, /Saved Firebase databases:<\/b> <code>8<\/code>|8 saved databases/);
  }
  assert.deepEqual(ui.calls, { link: 1, fetch: 1 }); // Opening status never fetches a pool.
});

test('unsolicited TXT, group reports and unconfigured owners get feedback without any download', async () => {
  const ui = makeUi();
  ui.ctx.message.document.file_name = 'other.TXT';
  await ui.run('document');
  assert.match(ui.replies.at(-1), /file input pending nahi/);
  ui.ctx.message.document.file_name = REPORT_FILE;
  ui.ctx.chat.type = 'group';
  await ui.run('document');
  assert.match(ui.replies.at(-1), /owner ki private chat/);
  ui.ctx.chat.type = 'private';
  ui.cfg.ownerIds = [];
  await ui.run('document');
  assert.match(ui.replies.at(-1), /configured owner/);
  ui.cfg.ownerIds = ['8'];
  await ui.run('document');
  assert.match(ui.replies.at(-1), /Unauthorized/);
  assert.deepEqual(ui.calls, { link: 0, fetch: 0 });
  assert.equal(ui.settings.size, 0);
});

test('bad row, oversized, failed or non-UTF-8 download cannot overwrite the last good report or echo secrets', async () => {
  const previous = { active: 1, inactive: 1, unknown: 0, uploadedAt: 1000 };
  for (const [response, error] of [
    [() => new Response('status\nactive\nprivate-value'), /Line 3/],
    [() => new Response('private-value', { status: 403 }), /HTTP 403/],
    [() => { throw new Error('private-value in Telegram URL'); }, /file padh nahi/],
    [() => new Response(new Uint8Array(128 * 1024 + 1)), /128 KiB limit/],
    [() => new Response(new Uint8Array([0xff])), /UTF-8/],
    [() => new Response(''), /khaali/],
  ]) {
    const ui = makeUi({ response });
    ui.settings.set(REPORT_KEY, previous);
    await ui.run('document');
    assert.equal(ui.settings.get(REPORT_KEY), previous);
    assert.match(ui.replies.at(-1), error);
    assert.doesNotMatch(ui.replies.at(-1), /private-value/);
  }
  const ui = makeUi();
  ui.ctx.message.document.file_size = 128 * 1024 + 1;
  await ui.run('document');
  assert.match(ui.replies.at(-1), /128 KiB limit/);
  assert.deepEqual(ui.calls, { link: 0, fetch: 0 });
});

test('a Telegram error page is not passed to a pending TXT import', async () => {
  const ui = makeUi({ response: () => new Response('private-value', { status: 502 }) });
  await ui.run('fb_src_add');
  ui.ctx.message.document.file_name = 'upload.txt';
  await ui.run('document');
  assert.match(ui.replies.at(-1), /File import nahi hui: .*HTTP 502/);
  assert.doesNotMatch(ui.replies.at(-1), /private-value/);
  assert.equal(ui.settings.size, 0);
});
