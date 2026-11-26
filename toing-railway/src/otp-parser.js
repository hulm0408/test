import { normalizeFancyText, otpBotSearchText } from './otp-profiles.js';

export function normalizeIndianMobileNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || !/^\+?[\d\s-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return digits;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits.slice(2);
  return null;
}

export function normalizePhone10(value = '') {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return digits.slice(2);
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function extractPhoneFromSegment(segment = '') {
  const normalized = normalizeFancyText(segment);
  const match = normalized.match(/(?:\+?91[\s-]*)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/);
  return match ? normalizeIndianMobileNumber(match[0]) : null;
}

export function extractTelegramCardPhone(text = '') {
  const lines = normalizeFancyText(text).split(/\r?\n/);
  for (const line of lines) {
    const normalizedLine = otpBotSearchText(line);
    if (!/\b(number|mobile|phone)\b/.test(normalizedLine)) continue;
    if (/\b(find|search|active numbers|live indian numbers)\b/.test(normalizedLine)) continue;
    const afterLabel = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
    const phone = extractPhoneFromSegment(afterLabel) || extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  return null;
}

function extractPhone(text = '') {
  const normalized = normalizeFancyText(text);
  const lines = normalized.split(/\r?\n/);
  for (const line of lines) {
    if (!/\bnumber\b/i.test(otpBotSearchText(line))) continue;
    const afterLabel = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
    const phone = extractPhoneFromSegment(afterLabel) || extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  for (const line of lines) {
    const s = otpBotSearchText(line);
    if (/\bid\b/.test(s)) continue;
    const phone = extractPhoneFromSegment(line);
    if (phone) return phone;
  }
  const withoutIdLines = lines
    .filter((line) => !/^\s*(?:telegram\s*)?id\b/i.test(otpBotSearchText(line)))
    .join('\n');
  return extractPhoneFromSegment(withoutIdLines);
}

function labelledValue(text, label) {
  const lines = normalizeFancyText(text).split(/\r?\n/);
  for (const line of lines) {
    if (!otpBotSearchText(line).includes(label)) continue;
    if (!line.includes(':')) continue;
    return line.slice(line.indexOf(':') + 1).trim();
  }
  return '';
}

function parseForwarderDateTime(raw = '') {
  const m = String(raw || '').match(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\s*\|\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return 0;
  let [, d, mo, y, h, mi, ap] = m;
  let hour = Number(h);
  if (ap) {
    const up = ap.toUpperCase();
    if (up === 'PM' && hour < 12) hour += 12;
    if (up === 'AM' && hour === 12) hour = 0;
  }
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi)) - (5.5 * 3600_000);
  return Number.isFinite(ms) ? ms : 0;
}

function extractSixDigitCode(text = '') {
  const src = normalizeFancyText(String(text || ''));
  const m = src.match(/(?:swiggy|swgtns|toing)[\s\S]{0,80}?\b(\d{6})\b/i)
    || src.match(/\b(\d{6})\b[\s\S]{0,60}?(?:swiggy|swgtns|toing|otp|verification|login)/i);
  if (m) return m[1];
  return '';
}

export function extractLooseOtpCode(text = '') {
  const src = normalizeFancyText(String(text ?? ''));
  if (!src) return '';
  if (!/(otp|verif|passcode|\bcode\b|\bpin\b|\bsms\b)/i.test(src)) return '';

  const usable = (value = '') => {
    const digits = String(value).replace(/\D/g, '');
    if (digits.length !== 6) return '';
    if (/^(19|20)\d{2}/.test(digits)) return '';
    return digits;
  };

  const labeled = /(?:otp|passcode|\bcode\b|\bpin\b)\s*(?:is|:|-|—|=)?\s*((?:\d[\s\-]?){6})(?!\d)/gi;
  let m;
  while ((m = labeled.exec(src))) {
    const digits = usable(m[1]);
    if (digits) return digits;
  }
  const spaced = /(?<!\d)(\d{3})[\s\-](\d{3})(?!\d)/g;
  while ((m = spaced.exec(src))) {
    const digits = usable(`${m[1]}${m[2]}`);
    if (digits) return digits;
  }
  const leading = /(?<!\d)(\d{6})(?!\d)\s*(?:is\s+)?(?:your\s+)?(?:swiggy|swgtns|toing\s+)?(?:otp|code|pin)/i;
  m = src.match(leading);
  if (m) {
    const digits = usable(m[1]);
    if (digits) return digits;
  }
  const plain = src.match(/(?<!\d)\d{6}(?!\d)/g) || [];
  for (const value of plain) {
    const digits = usable(value);
    if (digits) return digits;
  }
  return '';
}

export function parseOtpBotText(text = '') {
  const normalized = normalizeFancyText(text);
  const phone = extractPhone(normalized);
  const statusRaw = labelledValue(normalized, 'status');
  const status = (statusRaw.match(/[A-Za-z]+/) || [''])[0].toUpperCase();
  const deviceRaw = labelledValue(normalized, 'device') || labelledValue(normalized, 'finder key');
  const device = (deviceRaw.match(/[A-Za-z0-9._-]+/) || [''])[0];

  const cleanSender = (v = '') => String(v || '')
    .split(/\s*(?:\||→|=>|-{2,}|OTP\b)/i)[0]
    .trim()
    .replace(/^[{([<>\s]+|[\]})<>\s,;:]+$/g, '')
    .slice(0, 80);

  const senderMatch = normalized.match(/LAST\s+SMS\s*(?:[:\-]\s*)?[\[({\u003e]\s*([^\]\)}\n\u003c]+)\s*[\])}]/i)
    || normalized.match(/LAST\s+SMS\s*(?:FROM\s*)?[:\-]\s*([A-Za-z0-9][A-Za-z0-9 ._-]{1,79})/i)
    || normalized.match(/(?:^|\n)\s*(?:SENDER|FROM)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 ._-]{1,79})/i)
    || normalized.match(/[\[({\u003e]\s*([A-Z0-9._-]*(?:SWIGGY|SWI-GY|SWGTNS|TOING)[A-Z0-9._-]*)\s*[\])}]/i);
  const sender = senderMatch ? cleanSender(senderMatch[1]) : '';

  let code = '';
  for (const line of normalized.split(/\r?\n/)) {
    const m = line.match(/\bOTP\b\s*[:\-]?\s*(\d{6})(?!\d)/i);
    if (m) { code = m[1]; break; }
  }
  if (!code) code = extractSixDigitCode(normalized);

  const rawTime = (normalized.match(/(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}\s*\|\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)/i) || [])[1] || '';
  const smsTimeMs = rawTime ? parseForwarderDateTime(rawTime) : 0;
  const signature = code ? [sender, code, smsTimeMs || rawTime, phone || ''].join('|') : '';

  return {
    phone,
    status,
    device,
    sender,
    code,
    rawTime,
    smsTimeMs,
    signature,
    normalizedText: normalized,
  };
}

export function parseTelegramNumberCard(text = '') {
  const parsed = parseOtpBotText(text);
  const phone = extractTelegramCardPhone(text);
  if (!phone) return null;
  const signature = parsed.code
    ? [parsed.sender, parsed.code, parsed.smsTimeMs || parsed.rawTime, phone].join('|')
    : '';
  return { ...parsed, phone, signature };
}

export function messageText(message) {
  return String(message?.message ?? message?.text ?? '');
}

export function messageId(message) {
  const id = Number(message?.id);
  return Number.isFinite(id) ? id : 0;
}

export function telegramTsToMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

export const messageDateMs = (message) => telegramTsToMs(message?.date);
export const messageEditMs = (message) => telegramTsToMs(message?.editDate) || messageDateMs(message);

export function messageSignature(message) {
  return `${messageId(message)}|${messageEditMs(message)}|${messageText(message)}`;
}

function messageButtonsText(message) {
  try {
    const rows = message?.buttons;
    if (!rows) return '';
    const flat = [];
    for (const row of rows) {
      if (Array.isArray(row)) {
        for (const b of row) flat.push(String(b?.text || b?.button?.text || ''));
      } else {
        flat.push(String(row?.text || row?.button?.text || ''));
      }
    }
    return flat.filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

export function parseTelegramOtpMessage(message = null) {
  const text = messageText(message);
  const strict = parseOtpBotText(text);
  if (strict?.code) {
    const card = parseTelegramNumberCard(text);
    return { ...strict, phone: strict.phone || card?.phone || '', via: 'strict' };
  }
  const loose = extractLooseOtpCode([text, messageButtonsText(message)].filter(Boolean).join('\n'));
  if (!loose) return null;
  const card = parseTelegramNumberCard(text);
  return {
    phone: card?.phone || '',
    code: loose,
    sender: '',
    rawTime: '',
    smsTimeMs: 0,
    signature: `loose|${loose}`,
    via: 'loose',
  };
}

export function selectLatestFreshNumberCard(messages = [], {
  baselineSignatures = new Set(),
  excludePhones = new Set(),
  afterMessageId = 0,
  afterSignature = '',
  afterPhone = '',
} = {}) {
  const excluded = new Set(
    [...(excludePhones || [])]
      .map((p) => normalizePhone10(p))
      .filter(Boolean)
  );
  const cursorId = Number(afterMessageId) || 0;
  const cursorPhone = normalizePhone10(afterPhone);
  const list = Array.isArray(messages) ? messages : [];

  // Strict post-click matching: when waiting for a reply after clicking NEW NUMBER on cursorId,
  // check ALL messages so a brand-new reply (id > cursorId) can NEVER be hidden behind an
  // older message that happened to be edited at the same or later timestamp!
  if (cursorId > 0) {
    let newestNewMsg = null;
    let editedCursorMsg = null;
    let firstSeenCard = null;

    for (const message of list) {
      const card = parseTelegramNumberCard(messageText(message));
      if (!card?.phone) continue;

      const signature = messageSignature(message);
      const id = messageId(message);
      const result = { message, card, signature };
      if (!firstSeenCard) firstSeenCard = result;

      if (id > cursorId) {
        if (baselineSignatures?.has?.(signature)) continue;
        if (!newestNewMsg || id > messageId(newestNewMsg.message)) {
          newestNewMsg = result;
        }
        continue;
      }

      if (id === cursorId && !editedCursorMsg) {
        const changedSig = Boolean(afterSignature) && signature !== afterSignature;
        const changedPhone = !cursorPhone || card.phone !== cursorPhone;
        if (changedSig && changedPhone && !baselineSignatures?.has?.(signature)) {
          editedCursorMsg = result;
        }
      }
    }

    const arrived = newestNewMsg || editedCursorMsg;
    if (arrived) {
      if (excluded.has(arrived.card.phone)) {
        return { status: 'excluded-latest', result: arrived };
      }
      return { status: 'fresh', result: arrived };
    }

    if (!firstSeenCard) return { status: 'none', result: null };
    const firstId = messageId(firstSeenCard.message);
    if (firstId > 0 && firstId < cursorId) {
      return { status: 'before-click-latest', result: firstSeenCard };
    }
    return { status: 'baseline-latest', result: firstSeenCard };
  }

  // No cursorId (initial on-screen check before any click): evaluate latest card in list
  for (const message of list) {
    const card = parseTelegramNumberCard(messageText(message));
    if (!card?.phone) continue;

    const signature = messageSignature(message);
    const result = { message, card, signature };
    if (baselineSignatures?.has?.(signature)) {
      return { status: 'baseline-latest', result };
    }

    if (excluded.has(card.phone)) {
      return { status: 'excluded-latest', result };
    }
    return { status: 'fresh', result };
  }

  return { status: 'none', result: null };
}

export function candidateIsNew(candidate = {}, baseline = {}) {
  const ids = baseline?.ids instanceof Set ? baseline.ids : new Set(baseline?.ids || []);
  const codes = baseline?.codes instanceof Set ? baseline.codes : new Set(baseline?.codes || []);
  const maxMsgId = Number(baseline?.messageId) || 0;
  const afterMs = Number(baseline?.afterMs || baseline?.ts) || 0;

  if (!candidate?.parsed?.code) return false;
  if (candidate.idKey && ids.has(candidate.idKey)) return false;

  // Brand-new message id posted after watermark -> definitely fresh!
  if (maxMsgId > 0 && Number(candidate.messageId) > maxMsgId) {
    return true;
  }

  // Existing message edited after watermark -> fresh if code changed or timestamp newer
  const candTs = Number(candidate.ts) || 0;
  const smsTs = Number(candidate.parsed?.smsTimeMs) || 0;
  const effectiveTs = Math.max(candTs, smsTs);

  // Allow 1.5s clock skew on Telegram server timestamps
  if (afterMs > 0 && effectiveTs > 0 && effectiveTs >= afterMs - 1_500) {
    if (!codes.has(candidate.parsed.code)) return true;
    // Same code repeated ONLY if it's genuinely a new edit/signature not in baseline ids
    return !ids.has(candidate.idKey);
  }

  // Code never seen in baseline at all -> fresh
  if (!codes.has(candidate.parsed.code)) {
    return afterMs <= 0 || effectiveTs === 0 || effectiveTs >= afterMs - 5_000;
  }

  return false;
}
