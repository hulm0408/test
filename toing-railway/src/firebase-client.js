// ===== Stateless Multi-Lane Firebase Realtime DB Client (Number Pool + SMS/OTP Inbox) =====
// Ported & upgraded from hulm0408/workwr (firebase-numbers.js + firebase-sources.js)
// Every function accepts an explicit `source` object so multiple parallel lanes and UI
// verification calls can read different Firebase Realtime DBs concurrently with ZERO races.

import { normalizeIndianMobileNumber } from './otp-parser.js';

export const MAX_BULK_FIREBASE_SOURCES = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

const seg = (part) => encodeURIComponent(String(part));

function cleanPath(p) {
  return String(p || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function normalizeSourceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function builtinSourceName(url) {
  try {
    return new URL(url).hostname
      .split('.')[0]
      .replace(/-default-rtdb$/i, '')
      .slice(0, 40) || 'Firebase';
  } catch {
    return 'Firebase';
  }
}

export function normalizePoolPhone(value) {
  const norm = normalizeIndianMobileNumber(value);
  if (norm) return norm;
  const digits = String(value ?? '').replace(/\D/g, '');
  if (/^0[6-9]\d{9}$/.test(digits)) return digits.slice(1);
  if (/^91[6-9]\d{9}$/.test(digits)) return digits.slice(2);
  return null;
}

function phoneVariants(phone) {
  return [phone, `91${phone}`, `+91${phone}`, `0${phone}`];
}

// ---------------------------------------------------------------------------
// URL validation & bulk parser (ported from workwr/firebase-sources.js)
// ---------------------------------------------------------------------------
export function validateFirebaseSourceInput({
  name = '',
  url = '',
  auth = '',
  clientsPath = 'clients',
  messagesPath = 'messages',
  numbersPath = '',
  smsPath = 'sms',
  otpPath = 'otp',
} = {}) {
  const cleanUrl = String(url || '').trim().replace(/\/+$/, '');
  if (
    !/^https:\/\/[a-z0-9-]+\.firebaseio\.com$/i.test(cleanUrl) &&
    !/^https:\/\/[a-z0-9.-]+\.firebasedatabase\.app$/i.test(cleanUrl)
  ) {
    return {
      ok: false,
      error: 'URL valid Firebase Realtime DB hona chahiye — jaise https://xxxx-default-rtdb.firebaseio.com',
    };
  }
  return {
    ok: true,
    src: {
      name: String(name || '').trim().slice(0, 40) || builtinSourceName(cleanUrl),
      url: cleanUrl,
      auth: String(auth || '').trim(),
      clientsPath: String(clientsPath || 'clients').trim() || 'clients',
      messagesPath: String(messagesPath || 'messages').trim() || 'messages',
      numbersPath: String(numbersPath || '').trim(),
      smsPath: String(smsPath || 'sms').trim() || 'sms',
      otpPath: String(otpPath || 'otp').trim() || 'otp',
    },
  };
}

export function parseFirebaseSourceBulkInput(text = '') {
  const hostRe = () => /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:firebaseio\.com|firebasedatabase\.app)(?=$|[\s/|,:;)\]\}>"'?#!]|\.(?=$|[\s,;)\]\}>"']))/gi;
  const segments = [];

  for (const chunk of String(text || '').split(/[\r\n,;]+/)) {
    if (!chunk.trim()) continue;
    const matches = [...chunk.matchAll(hostRe())];
    if (matches.length <= 1) {
      segments.push(chunk);
      continue;
    }
    matches.forEach((match, i) => {
      segments.push(chunk.slice(match.index, matches[i + 1]?.index ?? chunk.length));
    });
  }

  const entries = [];
  const invalid = [];
  for (const rawSegment of segments) {
    const segment = String(rawSegment || '').trim();
    if (!segment) continue;
    const match = hostRe().exec(segment);
    if (!match) {
      invalid.push({
        input: segment.split('|')[0].trim().slice(0, 100),
        error: 'valid Firebase Realtime DB URL nahi mila',
      });
      continue;
    }

    const rawUrl = match[0];
    const url = (/^https?:\/\//i.test(rawUrl)
      ? rawUrl.replace(/^http:\/\//i, 'https://')
      : `https://${rawUrl}`).replace(/\/+$/, '');
    const remainder = segment.slice(match.index + rawUrl.length);
    const pipeIdx = remainder.indexOf('|');
    let auth = '';
    if (pipeIdx !== -1) {
      auth = remainder.slice(pipeIdx + 1).trim()
        .replace(/^auth\s*[:=]\s*/i, '')
        .replace(/^["']|["']$/g, '')
        .trim();
    } else {
      const queryAuth = remainder.match(/[?&]auth=([^&\s,;]+)/i);
      if (queryAuth) {
        try { auth = decodeURIComponent(queryAuth[1]); } catch { auth = queryAuth[1]; }
      }
    }
    entries.push({ url, auth });
  }

  return { entries, invalid };
}

// ---------------------------------------------------------------------------
// Firebase REST GET helper (explicit source, detects HTTP-200 {"error":...})
// ---------------------------------------------------------------------------
export function _firebaseErrorMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const keys = Object.keys(value);
  if (!keys.length || !keys.every((k) => ['error', 'code', 'status'].includes(k))) return '';
  return typeof value.error === 'string' ? value.error.trim() : '';
}

function buildUrl(source, nodePath = '', params = {}) {
  const base = String(source?.url || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Firebase source URL missing');
  const p = cleanPath(nodePath);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const auth = String(source?.auth || '').trim();
  if (auth) qs.set('auth', auth);
  const q = qs.toString();
  return `${base}/${p ? `${p}.json` : '.json'}${q ? `?${q}` : ''}`;
}

export async function fbGet(source, nodePath, params = {}, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(buildUrl(source, nodePath, params), {
    signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 30_000)),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Firebase ${res.status} (GET ${cleanPath(nodePath)}) ${txt.slice(0, 120)}`.trim());
  }
  const data = await res.json();
  const firebaseError = _firebaseErrorMessage(data);
  if (firebaseError) {
    throw new Error(`Firebase error (GET ${cleanPath(nodePath)}): ${firebaseError.slice(0, 160)}`);
  }
  return data;
}

export async function verifyFirebaseSource(source, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  if (!source?.url) return { ok: false, error: 'Source URL missing' };
  const t0 = Date.now();
  try {
    const res = await fetchImpl(buildUrl(source, '', { shallow: 'true' }), {
      signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 10_000)),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, ms, error: `HTTP ${res.status} ${txt.slice(0, 100)}`.trim() };
    }
    const json = await res.json().catch(() => null);
    const fbErr = _firebaseErrorMessage(json);
    if (fbErr) return { ok: false, ms, error: fbErr.slice(0, 160) };
    const topKeys = json && typeof json === 'object' ? Object.keys(json).slice(0, 8) : [];
    return { ok: true, ms, topKeys };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err?.message || err || 'network error').slice(0, 160) };
  }
}

// ---------------------------------------------------------------------------
// Pool Parsers — clients/<deviceId> (default) & legacy numbers/
// ---------------------------------------------------------------------------
function onlineStateFromValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'online', 'active', 'connected', 'available', 'alive', 'on', 'yes', 'y'].includes(v)) return true;
  if (['false', '0', 'offline', 'inactive', 'disconnected', 'unavailable', 'dead', 'off', 'no', 'n'].includes(v)) return false;
  return null;
}

export function _clientOnlineState(client) {
  if (!client || typeof client !== 'object') return null;
  const fields = ['online', 'isOnline', 'connected', 'isConnected', 'active', 'isActive', 'presence', 'status', 'state'];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(client, field)) continue;
    const state = onlineStateFromValue(client[field]);
    if (state !== null) return state;
  }
  return null;
}

export function _countDeviceOnlineStates(entries = []) {
  const rankByDevice = new Map();
  const rankOf = (entry) => (entry?.online === true ? 2 : entry?.online === false ? 0 : 1);
  for (const entry of entries || []) {
    const key = String(entry?.deviceId || entry?.phone || '');
    if (!key) continue;
    rankByDevice.set(key, Math.max(rankByDevice.get(key) ?? -1, rankOf(entry)));
  }
  const counts = { online: 0, unknown: 0, offline: 0, total: rankByDevice.size };
  for (const rank of rankByDevice.values()) {
    if (rank === 2) counts.online += 1;
    else if (rank === 0) counts.offline += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function poolEntryFrom(childKey, value) {
  let phone = null;
  let status = '';
  let label = '';

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    phone = normalizePoolPhone(
      value.number ?? value.phone ?? value.mobile ?? value.num ?? value.msisdn ?? value.value
    );
    status = String(value.status ?? value.state ?? '').trim();
    label = String(value.label ?? value.name ?? '').trim();
  } else if (typeof value === 'string' || typeof value === 'number') {
    phone = normalizePoolPhone(value);
  }
  if (!phone) phone = normalizePoolPhone(childKey);
  if (!phone) return null;

  return { phone, status, label, childKey: String(childKey), online: true, deviceId: '', noPatch: false };
}

export function _parsePool(raw) {
  if (raw === null || raw === undefined) return [];
  const out = [];
  const seen = new Set();

  const push = (entry) => {
    if (entry && !seen.has(entry.phone)) {
      seen.add(entry.phone);
      out.push(entry);
    }
  };

  if (Array.isArray(raw)) {
    raw.forEach((item, idx) => push(poolEntryFrom(idx, item)));
  } else if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) push(poolEntryFrom(key, value));
  }
  return out;
}

export function _parseClientsPool(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();

  for (const [deviceId, c] of Object.entries(raw)) {
    if (!c || typeof c !== 'object') continue;
    const label = String(c.modelName || c.service_provider || '').trim();
    const onlineState = _clientOnlineState(c);
    const online = onlineState === null ? undefined : onlineState;
    const joined = String(c.joined || '').trim();
    const candidates = [
      c.mobNo,
      c.mobile,
      c.number,
      ...(Array.isArray(c.sims) ? c.sims.map((s) => s?.phoneNumber) : []),
    ];

    const localSeen = new Set();
    for (const rawNum of candidates) {
      const phone = normalizePoolPhone(rawNum);
      if (!phone || localSeen.has(phone)) continue;
      localSeen.add(phone);
      if (seen.has(phone)) continue;
      seen.add(phone);
      out.push({
        phone,
        deviceId: String(c.deviceId || deviceId),
        online,
        label,
        joined,
        status: '',
        childKey: String(deviceId),
        noPatch: true,
      });
    }
  }
  return out;
}

export async function listPoolNumbers(source, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const forcedLegacy = String(source?.numbersPath || '').trim();

  if (!forcedLegacy) {
    const clientsPath = String(source?.clientsPath || 'clients').trim() || 'clients';
    let raw = null;
    try {
      raw = await fbGet(source, clientsPath, {}, { timeoutMs, fetchImpl });
    } catch (e) {
      if (!/Firebase 404\b/.test(String(e?.message || ''))) throw e;
      raw = null;
    }
    if (raw && typeof raw === 'object') {
      const pool = _parseClientsPool(raw);
      if (pool.length) return pool;
    }
  }

  const legacyPath = forcedLegacy || 'numbers';
  const legacyRaw = await fbGet(source, legacyPath, {}, { timeoutMs, fetchImpl });
  return _parsePool(legacyRaw);
}

// ---------------------------------------------------------------------------
// Timestamp & OTP Message Parsing
// ---------------------------------------------------------------------------
function messageBodyOf(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    return String(v.body ?? v.message ?? v.text ?? v.sms ?? v.msg ?? v.content ?? v.otpMessage ?? '');
  }
  return '';
}

export function _parseTs(t) {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number' && Number.isFinite(t)) {
    if (t > 1e12) return t;
    if (t > 1e9) return t * 1000;
    return null;
  }
  const s = String(t).trim();
  if (/^\d+$/.test(s)) return _parseTs(Number(s));
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

// Forwarder dateTime: "23-10-2026 | 04:48 AM" or "06/10/2026 | 03:50 pm" (IST -> UTC epoch ms)
export function parseForwarderDateTime(t) {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number') return _parseTs(t);
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\s*\|\s*(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return _parseTs(s);
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  let hh = Number(m[4]);
  const mm = Number(m[5]);
  const ap = String(m[6] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (day > 31 || month > 12 || hh > 23 || mm > 59) return null;
  return Date.UTC(year, month - 1, day, hh, mm) - (5.5 * 3600 * 1000);
}

function messageTsOf(v) {
  if (!v || typeof v !== 'object') return null;
  const dt = parseForwarderDateTime(v.dateTime);
  if (dt) return dt;
  const t = v.date ?? v.timestamp ?? v.time ?? v.createdAt ?? v.created_at ?? v.at ?? v.ts ?? v.sentAt;
  return _parseTs(t);
}

export function _extractSixDigitCode(text) {
  const src = String(text ?? '');
  if (!src) return '';
  const pick6 = (s) => (s.match(/(?<!\d)\d{6}(?!\d)/) || [])[0] || '';
  const swiggyLine = src.split(/\r?\n/).find((l) => /swiggy|swgtns|toing/i.test(l)) || '';
  return pick6(swiggyLine) || pick6(src);
}

function candidateFrom(idKey, v, via, meta = '') {
  const body = messageBodyOf(v);
  const code = _extractSixDigitCode(body);
  if (!code) return null;
  return { idKey, code, ts: messageTsOf(v), body, meta, via };
}

function looksLikeMessageNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.some((k) => ['body', 'message', 'text', 'sms', 'msg', 'content', 'otpMessage'].includes(k)) ||
    keys.some((k) => ['date', 'timestamp', 'time', 'createdAt', 'at', 'ts', 'sentAt', 'dateTime'].includes(k));
}

// ---------------------------------------------------------------------------
// Device Last-Activity Scanner (hot queue of active / ONLINE devices)
// ---------------------------------------------------------------------------
function bestActivityFromMessagesNode(node) {
  if (!node || typeof node !== 'object') return null;
  const entries = Array.isArray(node) ? node.map((m, i) => [i, m]) : Object.entries(node);
  let best = null;
  for (const [k, v] of entries) {
    const keyTs = _parseTs(k);
    const msgTs = (v && typeof v === 'object') ? messageTsOf(v) : null;
    const ts = Math.max(keyTs || 0, msgTs || 0) || null;
    if (ts && (!best || ts > best)) best = ts;
  }
  return best;
}

function messagesNodeEntryCount(node) {
  if (!node || typeof node !== 'object') return 0;
  return Array.isArray(node) ? node.length : Object.keys(node).length;
}

export async function fetchDeviceLastActivityMs(source, deviceId, { fetchImpl = fetch } = {}) {
  if (!deviceId) return null;
  const messagesPath = cleanPath(source?.messagesPath || 'messages');
  let node = null;
  try {
    node = await fbGet(
      source,
      `${messagesPath}/${seg(deviceId)}`,
      { orderBy: '"$key"', limitToLast: 5 },
      { timeoutMs: 8_000, fetchImpl }
    );
  } catch {
    return null;
  }

  const quickBest = bestActivityFromMessagesNode(node);
  if (quickBest) return quickBest;
  if (!messagesNodeEntryCount(node)) return null;

  try {
    const widerNode = await fbGet(
      source,
      `${messagesPath}/${seg(deviceId)}`,
      { orderBy: '"$key"', limitToLast: 50 },
      { timeoutMs: 8_000, fetchImpl }
    );
    return bestActivityFromMessagesNode(widerNode);
  } catch {
    return null;
  }
}

export async function fetchDevicesLastActivityMs(source, deviceIds = [], { concurrency = 24, probe = null, fetchImpl = fetch } = {}) {
  const out = new Map();
  const ids = [...new Set((deviceIds || []).map((d) => String(d || '')).filter(Boolean))];
  const fn = typeof probe === 'function'
    ? probe
    : (id) => fetchDeviceLastActivityMs(source, id, { fetchImpl });
  let i = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, ids.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { out.set(id, await fn(id)); } catch { out.set(id, null); }
    }
  });
  await Promise.all(workers);
  return out;
}

export function doubledWidenWindowMs(baseWindowMs, activityAgeMs) {
  let windowMs = Math.max(1, Number(baseWindowMs) || 1);
  const ageMs = Math.max(0, Number(activityAgeMs) || 0);
  while (windowMs < ageMs) windowMs *= 2;
  return windowMs;
}

export async function scanFreshDevices(source, entries = [], opts = {}) {
  const windowMs = Number(opts.windowMs ?? 60_000);
  const maxWidenMs = Number(opts.maxWidenMs ?? 15 * 60_000);
  const want = Math.max(1, Number(opts.want ?? 8));
  const chunkSize = Math.max(10, Number(opts.chunkSize ?? 80));
  const maxProbe = Math.max(chunkSize, Number(opts.maxProbe ?? 800));
  const concurrency = Math.max(1, Number(opts.concurrency ?? 32));
  const widenByDoubling = Boolean(opts.widenByDoubling);
  const backupCount = Math.max(want, Number(opts.backupCount) || want);
  const earlyWidenStepMs = Math.max(0, Number(opts.earlyWidenStepMs) || 0);
  const maxScanMs = Math.max(0, Number(opts.maxScanMs) || 0);
  const onlineFallback = Boolean(opts.onlineFallback);
  const probe = typeof opts.probe === 'function' ? opts.probe : null;
  const fetchImpl = opts.fetchImpl || fetch;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
  const aborted = () => {
    try { return Boolean(shouldAbort && shouldAbort()); } catch { return false; }
  };

  // Legacy pools have no deviceId — return entries directly so they process immediately!
  const legacyNoDevice = (entries || []).filter((e) => !e?.deviceId);
  const byDevice = new Map();
  for (const e of entries || []) {
    if (!e?.deviceId) continue;
    if (!byDevice.has(e.deviceId)) byDevice.set(e.deviceId, []);
    byDevice.get(e.deviceId).push(e);
  }
  const deviceIds = [...byDevice.keys()];

  if (!deviceIds.length && legacyNoDevice.length) {
    return {
      fresh: legacyNoDevice.slice(0, backupCount).map((entry) => ({
        entry,
        lastActivityMs: null,
        windowMs: 0,
        selectionSource: 'legacy-pool',
        onlineFallback: false,
      })),
      checked: 0,
      probedDeviceIds: [],
      widestWindowMs: windowMs,
      widened: false,
      onlineFallback: false,
      scanTimedOut: false,
      bestLastActivityMs: null,
      exhausted: legacyNoDevice.length <= backupCount,
      totalDevices: 0,
    };
  }

  const probed = [];
  const probedDeviceIds = [];
  const fresh = [];
  const scanStartedAt = Date.now();
  let bestLastActivityMs = null;
  let scanTimedOut = false;
  let checked = 0;
  const scanDeadlineReached = () => maxScanMs > 0 && (Date.now() - scanStartedAt) >= maxScanMs;

  const rankedDoublingCandidates = (maxAgeMs = Number.POSITIVE_INFINITY) => {
    const rankedAt = Date.now();
    return probed
      .filter((p) => p.lastActivityMs && (rankedAt - p.lastActivityMs) <= maxAgeMs)
      .sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0))
      .slice(0, backupCount)
      .map((p) => ({
        ...p,
        windowMs: doubledWidenWindowMs(windowMs, rankedAt - (p.lastActivityMs || rankedAt)),
        selectionSource: 'sms-activity',
        onlineFallback: false,
      }));
  };

  const earlyAllowedWindowMs = () => {
    if (!widenByDoubling || !earlyWidenStepMs) return windowMs;
    const elapsedMs = Date.now() - scanStartedAt;
    const steps = Math.min(40, Math.floor(elapsedMs / earlyWidenStepMs));
    return windowMs * (2 ** steps);
  };

  const rankedOnlineFallbackCandidates = () => {
    if (!onlineFallback) return [];
    const seenPhones = new Set();
    return probed
      .filter((p) => p.entry?.online === true)
      .sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0))
      .filter((p) => {
        const phone = String(p.entry?.phone || '');
        if (!phone || seenPhones.has(phone)) return false;
        seenPhones.add(phone);
        return true;
      })
      .slice(0, backupCount)
      .map((p) => ({
        ...p,
        lastActivityMs: p.lastActivityMs || null,
        windowMs: 0,
        selectionSource: 'clients-online',
        onlineFallback: true,
      }));
  };

  for (let off = 0; off < deviceIds.length && checked < maxProbe && fresh.length < want && !aborted(); off += chunkSize) {
    if (checked > 0 && scanDeadlineReached()) {
      scanTimedOut = true;
      break;
    }
    const chunk = deviceIds.slice(off, off + Math.min(chunkSize, maxProbe - checked));
    const res = await fetchDevicesLastActivityMs(source, chunk, { concurrency, probe, fetchImpl });
    checked += chunk.length;
    probedDeviceIds.push(...chunk);
    const now = Date.now();
    for (const devId of chunk) {
      const ts = res.get(devId) ?? null;
      if (ts && (!bestLastActivityMs || ts > bestLastActivityMs)) bestLastActivityMs = ts;
      for (const entry of byDevice.get(devId) || []) {
        probed.push({ entry, lastActivityMs: ts });
        if (ts && (now - ts) <= windowMs) fresh.push({ entry, lastActivityMs: ts });
      }
    }

    const allowedWindowMs = earlyAllowedWindowMs();
    if (onProgress) {
      try {
        onProgress({ checked, freshCount: fresh.length, totalDevices: deviceIds.length, allowedWindowMs, bestLastActivityMs });
      } catch {}
    }

    if (
      widenByDoubling && earlyWidenStepMs &&
      !aborted() && checked < deviceIds.length &&
      Date.now() - scanStartedAt >= earlyWidenStepMs
    ) {
      const early = rankedDoublingCandidates(Math.min(maxWidenMs, allowedWindowMs));
      if (early.length) {
        return {
          fresh: early,
          checked,
          probedDeviceIds,
          widestWindowMs: Math.max(...early.map((p) => p.windowMs || windowMs)),
          widened: (early[0].windowMs || windowMs) > windowMs,
          earlyWidened: true,
          onlineFallback: false,
          scanTimedOut: false,
          bestLastActivityMs,
          exhausted: false,
          totalDevices: deviceIds.length,
        };
      }
    }
  }

  const exhausted = checked >= deviceIds.length;
  if (!exhausted && scanDeadlineReached()) scanTimedOut = true;

  if (widenByDoubling && !aborted()) {
    const rankedLimitMs = fresh.length
      ? Math.min(maxWidenMs, Math.max(windowMs, earlyAllowedWindowMs()))
      : maxWidenMs;
    const ranked = rankedDoublingCandidates(rankedLimitMs);
    if (ranked.length) {
      return {
        fresh: ranked,
        checked,
        probedDeviceIds,
        widestWindowMs: Math.max(...ranked.map((p) => p.windowMs || windowMs)),
        widened: (ranked[0].windowMs || windowMs) > windowMs,
        earlyWidened: false,
        onlineFallback: false,
        scanTimedOut,
        bestLastActivityMs,
        exhausted,
        totalDevices: deviceIds.length,
      };
    }
  }

  if (fresh.length) {
    fresh.sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
    return {
      fresh: fresh.slice(0, want * 2),
      checked,
      probedDeviceIds,
      widestWindowMs: windowMs,
      widened: false,
      onlineFallback: false,
      scanTimedOut,
      bestLastActivityMs,
      exhausted,
      totalDevices: deviceIds.length,
    };
  }

  if (aborted()) {
    return {
      fresh: [],
      checked,
      probedDeviceIds,
      widestWindowMs: windowMs,
      widened: false,
      onlineFallback: false,
      scanTimedOut,
      bestLastActivityMs,
      exhausted,
      totalDevices: deviceIds.length,
      aborted: true,
    };
  }

  const now = Date.now();
  const recent = probed
    .filter((p) => p.lastActivityMs && (now - p.lastActivityMs) <= maxWidenMs)
    .sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
  if (recent.length) {
    const top = recent.slice(0, want);
    return {
      fresh: top,
      checked,
      probedDeviceIds,
      widestWindowMs: Math.max(windowMs, now - (top[top.length - 1].lastActivityMs || now)),
      widened: true,
      onlineFallback: false,
      scanTimedOut,
      bestLastActivityMs,
      exhausted,
      totalDevices: deviceIds.length,
    };
  }

  const online = rankedOnlineFallbackCandidates();
  if (online.length) {
    return {
      fresh: online,
      checked,
      probedDeviceIds,
      widestWindowMs: windowMs,
      widened: false,
      onlineFallback: true,
      scanTimedOut,
      bestLastActivityMs,
      exhausted,
      totalDevices: deviceIds.length,
    };
  }

  return {
    fresh: [],
    checked,
    probedDeviceIds,
    widestWindowMs: windowMs,
    widened: false,
    onlineFallback: false,
    scanTimedOut,
    bestLastActivityMs,
    exhausted,
    totalDevices: deviceIds.length,
  };
}

// ---------------------------------------------------------------------------
// OTP Inbox Reading & Live Polling (messages/<deviceId> + otp/ + sms/)
// ---------------------------------------------------------------------------
export async function fetchOtpCandidates(source, phone, { deviceIds = [], fetchImpl = fetch, includeLegacy = false, limitToLast = 25 } = {}) {
  const out = [];
  const messagesPath = cleanPath(source?.messagesPath || 'messages');
  const devIds = (Array.isArray(deviceIds) ? deviceIds : []).filter(Boolean);
  const forcedLegacy = Boolean(String(source?.numbersPath || '').trim());
  const needLegacy = Boolean(includeLegacy) || forcedLegacy;

  // 1. Primary: device messages/<deviceId>
  let anyDeviceNodeFound = false;
  if (devIds.length) {
    const deviceNodes = await Promise.all(devIds.map(async (deviceId) => {
      try {
        return [
          deviceId,
          await fbGet(
            source,
            `${messagesPath}/${seg(deviceId)}`,
            { orderBy: '"$key"', limitToLast: Math.max(5, Number(limitToLast) || 25) },
            { timeoutMs: 8_000, fetchImpl }
          ),
        ];
      } catch {
        return [deviceId, null];
      }
    }));

    for (const [deviceId, node] of deviceNodes) {
      if (!node) continue;
      anyDeviceNodeFound = true;
      const entries = Array.isArray(node)
        ? node.map((m, i) => [i, m])
        : (typeof node === 'object' ? Object.entries(node) : []);
      for (const [k, m] of entries) {
        const sender = m && typeof m === 'object' ? String(m.sender || '') : '';
        const c = candidateFrom(`messages/${deviceId}/${k}`, m, 'device', sender);
        if (c) out.push(c);
      }
    }
    if (anyDeviceNodeFound && !needLegacy) {
      return out;
    }
  }

  // 2 & 3. Fast path (otp/<variant>) + legacy (sms/<variant>) in parallel
  const otpPath = cleanPath(source?.otpPath || 'otp');
  const smsPath = cleanPath(source?.smsPath || 'sms');
  const variants = phoneVariants(phone);
  const shouldCheckSms = needLegacy || !devIds.length;

  const [otpNodes, smsNodes] = await Promise.all([
    Promise.all(variants.map(async (variant) => {
      try {
        return [variant, await fbGet(source, `${otpPath}/${seg(variant)}`, {}, { timeoutMs: 8_000, fetchImpl })];
      } catch {
        return [variant, null];
      }
    })),
    shouldCheckSms
      ? Promise.all(variants.map(async (variant) => {
        try {
          return [variant, await fbGet(source, `${smsPath}/${seg(variant)}`, {}, { timeoutMs: 8_000, fetchImpl })];
        } catch {
          return [variant, null];
        }
      }))
      : Promise.resolve([]),
  ]);

  for (const [variant, node] of otpNodes) {
    if (node === null || node === undefined) continue;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const inner = node.code ?? node.otp ?? node.value ?? null;
      if (inner !== null && inner !== undefined) {
        const c = candidateFrom(`otp:${variant}`, inner, 'otp');
        if (c) out.push(c);
      } else {
        for (const [k, v] of Object.entries(node)) {
          const c = candidateFrom(`otp:${variant}/${k}`, v, 'otp');
          if (c) out.push(c);
        }
      }
    } else {
      const c = candidateFrom(`otp:${variant}`, node, 'otp');
      if (c) out.push(c);
    }
  }

  for (const [variant, node] of smsNodes) {
    if (node === null || node === undefined) continue;
    if (Array.isArray(node)) {
      node.forEach((m, i) => {
        const sender = m && typeof m === 'object' ? String(m.sender || '') : '';
        const c = candidateFrom(`sms/${variant}/${i}`, m, 'sms', sender);
        if (c) out.push(c);
      });
    } else if (typeof node === 'object') {
      if (looksLikeMessageNode(node)) {
        const c = candidateFrom(`sms/${variant}`, node, 'sms', String(node.sender || ''));
        if (c) out.push(c);
      } else {
        for (const [k, v] of Object.entries(node)) {
          const c = candidateFrom(`sms/${variant}/${k}`, v, 'sms', v && typeof v === 'object' ? String(v.sender || '') : '');
          if (c) out.push(c);
        }
      }
    } else {
      const c = candidateFrom(`sms/${variant}`, node, 'sms');
      if (c) out.push(c);
    }
  }

  return out;
}

export async function snapshotSeenOtpState(source, phone, { deviceIds = [], fetchImpl = fetch } = {}) {
  try {
    const cands = await fetchOtpCandidates(source, phone, { deviceIds, fetchImpl });
    return {
      ids: new Set(cands.map((c) => c.idKey)),
      codes: new Set(cands.map((c) => c.code)),
    };
  } catch {
    return { ids: new Set(), codes: new Set() };
  }
}

function normalizeExclude(exclude) {
  if (exclude instanceof Set) return { ids: exclude, codes: new Set(), rejectedCodes: new Set() };
  if (exclude && typeof exclude === 'object') {
    return {
      ids: exclude.ids instanceof Set ? exclude.ids : new Set(exclude.ids || []),
      codes: exclude.codes instanceof Set ? exclude.codes : new Set(exclude.codes || []),
      rejectedCodes: exclude.rejectedCodes instanceof Set ? exclude.rejectedCodes : new Set(exclude.rejectedCodes || []),
    };
  }
  return { ids: new Set(), codes: new Set(), rejectedCodes: new Set() };
}

const isSwiggyCand = (c) => /swiggy|swgtns|toing/i.test(`${c.body || ''} ${c.meta || ''}`);

export function pickBestFirebaseOtpCandidate(cands, exclude, sinceTs, acceptAnyAfter, now = Date.now()) {
  const norm = normalizeExclude(exclude);
  const fresh = (cands || []).filter((c) => {
    if (!c?.code) return false;
    if (norm.rejectedCodes.has(String(c.code))) return false;
    if (!norm.ids.has(c.idKey)) return true;
    // A message present in the pre-send snapshot is stale even if recent.
    // A reused Firebase key is fresh only when its code actually changes.
    if (norm.codes.size > 0 && !norm.codes.has(c.code)) return true;
    if (norm.codes.size === 0 && norm.ids.size === 0) return true;
    return false;
  });
  if (!fresh.length) return null;

  const swiggy = fresh.filter(isSwiggyCand);
  if (swiggy.length) {
    return swiggy.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  }
  if (acceptAnyAfter && now < acceptAnyAfter) return null;
  return fresh.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
}

export async function waitForOtpCode(source, phone, opts = {}) {
  const waitMs = Math.max(0, Number(opts.waitMs ?? 2_500));
  const timeoutMs = Math.max(2_000, Number(opts.timeoutMs ?? 60_000));
  const pollMs = Math.max(250, Number(opts.pollMs ?? 1_500));
  const acceptAnyAfterMs = Math.max(0, Number(opts.acceptAnyAfterMs ?? 18_000));
  const exclude = normalizeExclude(opts.excludeIds ?? opts.exclude);
  if (opts.rejectedCodes) {
    for (const code of opts.rejectedCodes) exclude.rejectedCodes.add(String(code));
  }
  const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
  const fetchImpl = opts.fetchImpl || fetch;
  const sinceTs = typeof opts.sinceTs === 'number' ? opts.sinceTs : Date.now() - 20_000;
  const startedAt = Date.now();

  const bail = () => Boolean(shouldAbort && shouldAbort());
  if (bail()) return { ok: false, code: '', aborted: true, polls: 0, elapsedMs: 0 };

  if (waitMs > 0) {
    const endWait = Date.now() + waitMs;
    while (Date.now() < endWait) {
      if (bail()) return { ok: false, code: '', aborted: true, polls: 0, elapsedMs: Date.now() - startedAt };
      await sleep(Math.min(250, endWait - Date.now()));
    }
  }
  if (bail()) return { ok: false, code: '', aborted: true, polls: 0, elapsedMs: Date.now() - startedAt };

  const deadline = startedAt + timeoutMs;
  const acceptAnyAfter = startedAt + Math.min(acceptAnyAfterMs, Math.floor(timeoutMs * 0.7));
  let polls = 0;
  let lastErr = null;

  for (;;) {
    polls += 1;
    try {
      const cands = await fetchOtpCandidates(source, phone, { deviceIds: opts.deviceIds, fetchImpl });
      const best = pickBestFirebaseOtpCandidate(cands, exclude, sinceTs, acceptAnyAfter, Date.now());
      if (best) {
        return {
          ok: true,
          code: best.code,
          via: best.via,
          ts: best.ts,
          idKey: best.idKey,
          sender: best.meta || '',
          polls,
          elapsedMs: Date.now() - startedAt,
        };
      }
    } catch (e) {
      lastErr = e;
    }

    if (bail()) return { ok: false, code: '', aborted: true, polls, elapsedMs: Date.now() - startedAt };
    if (Date.now() >= deadline) {
      return {
        ok: false,
        code: '',
        timeout: true,
        polls,
        elapsedMs: Date.now() - startedAt,
        error: lastErr ? String(lastErr.message || lastErr) : '',
      };
    }

    const nextWait = Math.min(pollMs, Math.max(0, deadline - Date.now()));
    const chunkEnd = Date.now() + nextWait;
    while (Date.now() < chunkEnd) {
      if (bail()) return { ok: false, code: '', aborted: true, polls, elapsedMs: Date.now() - startedAt };
      await sleep(Math.min(250, chunkEnd - Date.now()));
    }
  }
}
