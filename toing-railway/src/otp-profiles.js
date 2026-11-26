// Pure OTP Bot Profiles (Hathi / Hermes / HardXotp) — zero I/O.

export const OTP_BOT_PROFILE_IDS = ['hathi', 'hermes', 'chauhan'];

export const OTP_BOT_PROFILES = {
  hathi: {
    id: 'hathi',
    label: 'Hathi',
    uiLabel: '🐘 Hathi OTP',
    emoji: '🐘',
    username: 'Hathi_otp_bot',
    claimPreference: ['new', 'find'],
    refreshRoles: ['refresh'],
    refreshLabel: 'REFRESH',
    refreshText: 'Refresh',
    ignoreRolePatterns: [],
    extraRoleMatchers: [],
    startCommand: '/start',
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    uiLabel: '📨 Hermeshu',
    emoji: '📨',
    username: 'HermeshuOTPROBOT',
    claimPreference: ['new', 'find'],
    refreshRoles: ['refresh'],
    refreshLabel: 'REFRESH',
    refreshText: 'Refresh',
    ignoreRolePatterns: [],
    extraRoleMatchers: [],
    startCommand: '/start',
  },
  chauhan: {
    id: 'chauhan',
    label: 'HardXotp',
    uiLabel: '🔐 HardXotp',
    emoji: '🔐',
    username: 'HardXotp_Bot',
    claimPreference: ['new', 'find'],
    refreshRoles: ['refresh', 'view'],
    refreshLabel: 'VIEW MESSAGES',
    refreshText: 'View Messages',
    extraRoleMatchers: [
      { role: 'view', re: /\b(view|show|check)\s+(messages?|sms|inbox)\b|\bmessages?\b|\binbox\b/ },
    ],
    ignoreRolePatterns: [/\blive\s+stats\b/, /\bfind\s+device\b/, /\bback\b/],
    startCommand: '/start',
  },
};

export const DEFAULT_OTP_BOT_PROFILE_ID = 'hathi';

const SMALL_CAPS_MAP = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G',
  'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N',
  'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V',
  'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};

export function normalizeOtpBotProfileId(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/^@+/, '');
  if (!key) return DEFAULT_OTP_BOT_PROFILE_ID;
  if (OTP_BOT_PROFILES[key]) return key;
  for (const profile of Object.values(OTP_BOT_PROFILES)) {
    if (key === profile.username.toLowerCase()) return profile.id;
  }
  if (/hard\s*x?\s*otp|chauhan/.test(key)) return 'chauhan';
  if (/hathi|haathi|elephant/.test(key)) return 'hathi';
  if (/hermes/.test(key)) return 'hermes';
  return DEFAULT_OTP_BOT_PROFILE_ID;
}

export function getOtpBotProfile(value = '') {
  return OTP_BOT_PROFILES[normalizeOtpBotProfileId(value)] || OTP_BOT_PROFILES[DEFAULT_OTP_BOT_PROFILE_ID];
}

export function nextFailoverProfileId(currentId = '') {
  const cur = normalizeOtpBotProfileId(currentId);
  const idx = OTP_BOT_PROFILE_IDS.indexOf(cur);
  return OTP_BOT_PROFILE_IDS[(idx + 1) % OTP_BOT_PROFILE_IDS.length];
}

export function normalizeFancyText(text = '') {
  const decomposed = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  return [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
}

export function otpBotSearchText(text = '') {
  return normalizeFancyText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseButtonRole(n = '') {
  if (!n) return '';
  if (/\b(refresh|reload|check otp|get otp|update)\b/.test(n)) return 'refresh';
  if (/\b(new|change|another|next)\b.*\bnumber\b/.test(n)) return 'new';
  if (/\b(find|get|show|my|your)\s+numbers?\b/.test(n)) return 'find';
  return '';
}

export function otpBotButtonRole(text = '', profileOrId = DEFAULT_OTP_BOT_PROFILE_ID) {
  const profile = typeof profileOrId === 'object' && profileOrId
    ? profileOrId
    : getOtpBotProfile(profileOrId);
  const n = otpBotSearchText(text);
  if (!n) return '';
  for (const re of profile.ignoreRolePatterns || []) {
    if (re.test(n)) return '';
  }
  for (const matcher of profile.extraRoleMatchers || []) {
    if (matcher.re.test(n)) return matcher.role;
  }
  return baseButtonRole(n);
}

export function selectOtpBotScreenAction(screens = [], {
  mode = 'claim',
  phone = '',
  profileId = DEFAULT_OTP_BOT_PROFILE_ID,
  cardPhoneOf = null,
} = {}) {
  const profile = getOtpBotProfile(profileId);
  const wantedPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  const list = Array.isArray(screens) ? screens : [];

  for (let screenIndex = 0; screenIndex < list.length; screenIndex++) {
    const screen = list[screenIndex] || {};
    const rawButtons = Array.isArray(screen.buttons) ? screen.buttons : [];
    const buttons = rawButtons
      .map((b) => String(typeof b === 'string' ? b : b?.text || b?.button?.text || ''))
      .filter(Boolean);
    if (!buttons.length) continue;

    const roles = buttons.map((text, index) => String(
      screen.buttonRoles?.[index] || otpBotButtonRole(text, profile) || ''
    ));
    const cardPhone = typeof cardPhoneOf === 'function'
      ? (cardPhoneOf(screen.text || screen.message || '') || '')
      : '';
    const base = {
      screenIndex,
      buttons,
      roles,
      cardPhone,
      role: '',
      buttonIndex: -1,
      buttonText: '',
      reason: 'no-matching-button-on-latest-screen',
      profileId: profile.id,
    };

    if (mode === 'refresh') {
      if (wantedPhone && cardPhone && cardPhone !== wantedPhone) {
        return { ...base, reason: 'latest-screen-different-number' };
      }
      const allowed = profile.refreshRoles || ['refresh'];
      const buttonIndex = roles.findIndex((role) => allowed.includes(role));
      return buttonIndex >= 0
        ? { ...base, role: roles[buttonIndex], buttonIndex, buttonText: buttons[buttonIndex], reason: 'latest-screen' }
        : base;
    }

    const order = profile.claimPreference || ['new', 'find'];
    for (const wanted of order) {
      const buttonIndex = roles.indexOf(wanted);
      if (buttonIndex >= 0) {
        return {
          ...base,
          role: wanted,
          buttonIndex,
          buttonText: buttons[buttonIndex],
          reason: wanted === 'new' ? 'latest-screen-new' : 'latest-screen-find',
        };
      }
    }
    return base;
  }
  return null;
}
