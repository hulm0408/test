// Pure MTProto error classifier — decides per-slot health & cooldown.

const NETWORK_RE = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket|not connected|Connection closed|disconnected|timed?\s*out|timeout|network|fetch failed)/i;

export function telegramErrorCode(error) {
  const msg = String(error?.message ?? error ?? '');
  const explicit = String(error?.errorMessage || error?.code || '').trim();
  const pool = `${explicit} ${msg}`;
  const direct = pool.match(/\b(PEER_FLOOD|FLOOD_WAIT(?:_\d+)?|AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED_BAN|USER_DEACTIVATED|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|USER_BANNED_IN_CHANNEL|PHONE_NUMBER_BANNED|PHONE_CODE_EXPIRED|PHONE_CODE_INVALID|BOT_METHOD_INVALID|MESSAGE_ID_INVALID|BUTTON_INVALID|BUTTON_NOT_FOUND|DATA_INVALID|RPC_CALL_FAIL|TIMEOUT|CONNECTION_NOT_INITED)\b/i);
  if (direct) return direct[1].toUpperCase();
  if (/not a valid string|invalid string session|invalid session|bad session|session string/i.test(msg)) {
    return 'SESSION_INVALID';
  }
  if (NETWORK_RE.test(msg)) return 'NETWORK';
  return 'UNKNOWN';
}

export function floodWaitSeconds(code, error) {
  const msg = String(error?.message ?? error ?? '');
  const direct = /FLOOD_WAIT_(\d+)/i.exec(code || '') || /FLOOD_WAIT_(\d+)/i.exec(msg);
  if (direct) return Math.max(1, Number(direct[1]) || 1);
  const seconds = Number(error?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
}

export function classifyTelegramError(error) {
  const code = telegramErrorCode(error);
  const raw = String(error?.message ?? error ?? '').slice(0, 200);
  const base = { code, raw, seconds: 0 };

  if (code === 'PEER_FLOOD') {
    return {
      ...base,
      kind: 'peer-flood',
      healthStatus: 'cooldown',
      fatal: false,
      cooldownMs: 6 * 60 * 60_000,
      label: 'PEER_FLOOD (6h cooldown)',
    };
  }
  if (code === 'FLOOD_WAIT' || code.startsWith('FLOOD_WAIT_')) {
    const seconds = floodWaitSeconds(code, error);
    return {
      ...base,
      seconds,
      kind: 'flood',
      healthStatus: 'cooldown',
      fatal: false,
      cooldownMs: Math.max(30_000, (seconds + 5) * 1000),
      label: seconds ? `FLOOD_WAIT ${seconds}s` : 'FLOOD_WAIT',
    };
  }
  if (
    code === 'AUTH_KEY_DUPLICATED' ||
    code === 'AUTH_KEY_UNREGISTERED' ||
    code === 'AUTH_KEY_INVALID' ||
    code === 'SESSION_REVOKED' ||
    code === 'SESSION_EXPIRED' ||
    code === 'SESSION_INVALID' ||
    code === 'USER_DEACTIVATED_BAN' ||
    code === 'USER_DEACTIVATED' ||
    code === 'PHONE_NUMBER_BANNED'
  ) {
    return {
      ...base,
      kind: 'dead',
      healthStatus: 'dead',
      fatal: true,
      cooldownMs: 24 * 60 * 60_000,
      label: `${code} (session dead)`,
    };
  }
  if (code === 'CHAT_WRITE_FORBIDDEN' || code === 'USER_BANNED_IN_CHANNEL' || code === 'CHAT_ADMIN_REQUIRED') {
    return {
      ...base,
      kind: 'blocked',
      healthStatus: 'cooldown',
      fatal: false,
      cooldownMs: 60 * 60_000,
      label: `${code} (OTP bot blocked this slot)`,
    };
  }
  if (code === 'NETWORK') {
    return {
      ...base,
      kind: 'network',
      healthStatus: 'cooldown',
      fatal: false,
      cooldownMs: 12_000,
      label: 'Network timeout (auto-retry 12s)',
    };
  }
  return {
    ...base,
    kind: 'unknown',
    healthStatus: 'ready',
    fatal: false,
    cooldownMs: 0,
    label: code !== 'UNKNOWN' ? code : raw.slice(0, 60) || 'Error',
  };
}

export function isConnectionError(error) {
  const msg = String(error?.message || error || '');
  return /(AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|not connected|disconnected|Connection closed|ECONNRESET|EPIPE|socket|timed?\s*out|timeout|network)/i.test(msg);
}
