// ===== 🤖 GOLD DROP AI BRIDGE — "It's ✌️ Life" bot (@GoldDropAi) ko OTP bot se jorna =====
//
// Owner ka flow (screenshots se, 2026-11-22):
//   /start → ⚡️ ɴᴀᴠ ʙᴏᴛ ⚡️ (YOUR POINTS: n PTS) + CLAIM REWARD button
//   → click CLAIM REWARD → 📱 ENTER MOBILE NUMBER (send your 10-digit mobile
//     number: EXAMPLE: 9876543210)
//   → 📱 number bhejo → (kabhi ⏳ UPD... FPROCESSING 90% — processing screen)
//     → 🛡️ OTP DISPATCHED · STATUS: ENTER 6-DIGIT OTP (+ CANCEL button)
//   → 6-digit OTP bhejo → result screen:
//       ✅ 📱 MOBILE: xxx · 💡 REWARD: BETTER LUCK NEXT TIME · 📈 POINTS: 5 LEFT (1 USED)
//         → ⚡️ ɴᴀᴠ ʙᴏᴛ · ✅ READY FOR NEXT CLAIM · CLAIM REWARD button
//       ❌ REGISTRATION FAILED · STATUS: THIS EMAIL IS ALREADY USED · TAP CLAIM REWARD TO RETRY
//       ⚠️ INVALID OTP - CANCELLED · OTP MUST BE 6 DIGITS · TAP CLAIM REWARD TO RETRY
//
// Wahi Swiggy World Bot wala system — SWIGGY WORLD BOT + OTP BOT — is bot par
// lagta hai:
//   • ek hi spare Telegram user session (OTP bots ke liye configured) se
//     @GoldDropAi ke buttons click + text bheja jata hai
//   • number OTP bot se khud fetch hota hai (getNextTelegramNumber) aur khud
//     bhej jata hai
//   • jab bot OTP maangta hai, OTP bot ke chat me code khud nikal kar wahi
//     type ho jata hai
//   • har number ke liye watermark — purana OTP dobara nahi jata
//   • CANCEL button (OTP prompt / processing screens) ka saaf rakh-rakh
//
// Ek claim = 1 number (3x claim nahi, ek claim per number). Ek number ka claim
// fail ho (email already used / doosri baar invalid OTP / OTP miss) to wahi
// number khatam — agla number turant. INVALID OTP par sirf ek retry kiya
// jata hai (same number, fresh OTP) — doosri baar bhi invalid to number chhod.
//
// Pure helpers (button role, screen kind, points/reward parse) network ke
// bina test kiye ja sakte hain — test_golddropai-bridge.mjs me cover hote hain.
// Client plumbing (read/send/click/wait) gold-drop-bridge.js se shared hai.

import {
  withGoldDropBridgeClient,
  getGoldDropEntity,
  parseGoldDropScreens,
  sendGoldDropText,
  clickGoldDropButton,
  triggerGoldDropButton,
  waitForGoldDropReply,
  settledScreen,
  setPhase,
  getGoldDropBridgeState,
  state,
  screenSignature,
  normalizeGoldDropPhone,
  isGoldDropPhoneValid,
  normalizeGoldDropOtp,
  isGoldDropOtpValid,
} from './gold-drop-bridge.js';

export const GOLDDROPAI_BRIDGE_USERNAME_DEFAULT = 'GoldDropAi';

export const GOLDDROPAI_BRIDGE_DEFAULTS = {
  stepTimeoutMs: 120_000,
  startTimeoutMs: 60_000,
  pollMs: 1_500,
  // Number bhejne ke baad "OTP DISPATCHED" screen ka budget (processing
  // screen uske beech aa sakta hai — uska intezaar usme hi ho jata hai).
  otpDispatchTimeoutMs: 90_000,
  // OTP type karne ke baad result screen (REWARD/REGISTRATION FAILED/INVALID
  // OTP) aane ka budget.
  otpVerifyWaitMs: 90_000,
  // OTP inbox (OTP bot chat) me code aane ka intezaar.
  otpInboxTimeoutMs: 90_000,
  // INVALID OTP par same number ek baar dobara try karna.
  maxInvalidOtpRetries: 1,
  // Button trigger: 'auto' = pehle click; screen na badle to button ka TEXT
  // type karke action trigger (world-bot jaisa). 'type' = click bilkul nahi.
  trigger: 'auto',
  clickGraceMs: 8_000,
  // Flood wait ke baad ka aakhri dheemi scan (0 = band).
  lateReplyGraceMs: 45_000,
};

const normHandle = (value = '') => String(value || '').trim().replace(/^@+/, '');

export function goldDropAiBridgeUsername(env = process.env) {
  return normHandle(
    env?.GOLDDROPAI_BOT_USERNAME
    || env?.GOLD_DROP_AI_BOT_USERNAME
    || env?.GOLDDROPAI_BRIDGE_BOT
    || GOLDDROPAI_BRIDGE_USERNAME_DEFAULT
  ) || GOLDDROPAI_BRIDGE_USERNAME_DEFAULT;
}

export function goldDropAiBridgeConfig(env = process.env) {
  const num = (key, dflt, min = 250) => {
    const n = Number(env?.[key]);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  return {
    username: goldDropAiBridgeUsername(env),
    stepTimeoutMs: num('GOLDDROPAI_STEP_TIMEOUT_MS', GOLDDROPAI_BRIDGE_DEFAULTS.stepTimeoutMs),
    startTimeoutMs: num('GOLDDROPAI_START_TIMEOUT_MS', GOLDDROPAI_BRIDGE_DEFAULTS.startTimeoutMs, 5_000),
    pollMs: num('GOLDDROPAI_POLL_MS', GOLDDROPAI_BRIDGE_DEFAULTS.pollMs, 300),
    otpDispatchTimeoutMs: num('GOLDDROPAI_OTP_DISPATCH_TIMEOUT_MS', GOLDDROPAI_BRIDGE_DEFAULTS.otpDispatchTimeoutMs, 10_000),
    otpVerifyWaitMs: Math.max(30_000, Math.min(600_000,
      num('GOLDDROPAI_OTP_VERIFY_WAIT_MS', GOLDDROPAI_BRIDGE_DEFAULTS.otpVerifyWaitMs, 30_000))),
    otpInboxTimeoutMs: Math.max(30_000, Math.min(180_000,
      num('GOLDDROPAI_OTP_INBOX_TIMEOUT_MS', GOLDDROPAI_BRIDGE_DEFAULTS.otpInboxTimeoutMs, 30_000))),
    maxInvalidOtpRetries: Math.max(0, Math.min(3, Math.trunc(num('GOLDDROPAI_MAX_INVALID_OTP_RETRIES', GOLDDROPAI_BRIDGE_DEFAULTS.maxInvalidOtpRetries, 0)))),
    trigger: ['click', 'type', 'auto'].includes(String(env?.GOLDDROPAI_TRIGGER || '').trim().toLowerCase())
      ? String(env.GOLDDROPAI_TRIGGER).trim().toLowerCase()
      : GOLDDROPAI_BRIDGE_DEFAULTS.trigger,
    clickGraceMs: num('GOLDDROPAI_CLICK_GRACE_MS', GOLDDROPAI_BRIDGE_DEFAULTS.clickGraceMs, 1_000),
    lateReplyGraceMs: Math.max(0, Math.min(180_000,
      num('GOLDDROPAI_LATE_REPLY_GRACE_MS', GOLDDROPAI_BRIDGE_DEFAULTS.lateReplyGraceMs, 0))),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — network ke bina (tests inhe direct call karte hain)
// ---------------------------------------------------------------------------
const plain = (value = '') => String(value ?? '')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\u00a0/g, ' ');

// Fancy/small-caps text normalize (screenshots me bot ka text small-caps me
// hai — "ᴄʟᴀɪm ʀᴇᴡᴀʀd", "ᴘᴏɪɴᴛs", "ᴛᴀᴘ ᴄʟᴀɪм ʀᴇᴡᴀʀд").
const SMALL_CAPS_MAP = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G',
  'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N',
  'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V',
  'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};

const norm = (value = '') => {
  const decomposed = plain(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const mapped = [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
  return mapped
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

// Screen text ke liye — punctuation (- / : ! ?) bachao, sirf whitespace
// collapse + small-caps map.
const lightNorm = (value = '') => {
  const decomposed = plain(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const mapped = [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
  return mapped
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

// Button ka role — @GoldDropAi ke screens ke hisaab se.
//   claimReward | cancel | myAccount | userGuide | referEarn | ''
export function goldDropAiButtonRole(text = '') {
  const n = norm(text);
  if (!n) return '';
  if (/claim\s*reward/.test(n)) return 'claimReward';
  if (/^\s*cancel\s*$/.test(n)) return 'cancel';
  if (/my\s*account/.test(n)) return 'myAccount';
  if (/user\s*guide/.test(n)) return 'userGuide';
  if (/refer.*earn|earn.*refer/.test(n)) return 'referEarn';
  return '';
}

// Button ka raw object nikalo ({ button, text }) — pick/unwrap waisa hi.
export function pickGoldDropAiButton(buttons = [], role = '') {
  const list = Array.isArray(buttons) ? buttons : [];
  for (const item of list) {
    const raw = item?.button || item;
    const text = String(item?.text ?? (item?.button?.text ?? (raw?.text || raw || '')));
    if (goldDropAiButtonRole(text) === role) {
      return { button: raw, text };
    }
  }
  return null;
}

// Button role sirf LATEST 1-3 incoming messages me dhoondho.
export function findGoldDropAiButtonOnScreens(messages = [], role = '') {
  const list = Array.isArray(messages) ? messages : [];
  const inbound = list.filter((m) => !m?.out);
  const pool = (inbound.length ? inbound : list).slice(0, 3);
  for (const message of [...pool, ...list.slice(0, 2)]) {
    const hit = pickGoldDropAiButton(message?.buttons, role);
    if (hit) return { message, ...hit };
  }
  return null;
}

// Screen ka kind — @GoldDropAi ke asli screens ke hisaab se:
//   'menu' | 'claimReward' | 'numberPrompt' | 'otpDispatched' | 'processing'
//   'result' | 'registrationFailed' | 'invalidOtp' | ''
// Order matters — terminal/error screens pehle.
export function goldDropAiScreenKind(text = '') {
  const n = lightNorm(text);
  if (!n) return '';
  if (/registration\s*failed|already\s*used/.test(n)) return 'registrationFailed';
  if (/invalid\s*otp|claim\s*cancelled/.test(n)) return 'invalidOtp';
  if (/otp\s*dispatched/.test(n)) return 'otpDispatched';
  if (/processing|\d+\s*%|upd\.{2,}/.test(n)) return 'processing';
  if (/enter (your )?10[- ]digit mobile number|send your 10[- ]digit mobile number/.test(n)) return 'numberPrompt';
  if (/reward\s*:/.test(n) && /points\s*:/.test(n)) return 'result';
  if (/nav bot|welcome|your points/.test(n)) return 'menu';
  if (/ready for next claim|tap claim reward/.test(n)) return 'claimReward';
  return '';
}

export function goldDropAiHasPromptKind(messages = [], kind = '') {
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => goldDropAiScreenKind(String(m?.text || '')) === kind);
}

// Small-caps text decode — "ᴘᴏɪɴᴛs", "ʀᴇｗａʀd" wagaira asli letters me.
const decodeSmallCaps = (value = '') => {
  const decomposed = plain(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  return [...decomposed].map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
};

// Result screen se points nikalna — "POINTS: 5 LEFT (1 USED)".
// Small-caps variant ("ᴘᴏɪɴᴛs: 5 ʟᴇꜰᴛ (1 ᴜsᴇd)") bhi dhundhe.
export function parseGoldDropAiPoints(text = '') {
  const n = decodeSmallCaps(text);
  const out = { pointsLeft: 0, pointsUsed: 0, pointsTotal: 0 };
  const leftUsed = /points?\s*:?\s*(\d+)\s*left\s*\((\d+)\s*used\)/i.exec(n);
  if (leftUsed) {
    out.pointsLeft = Number(leftUsed[1]) || 0;
    out.pointsUsed = Number(leftUsed[2]) || 0;
  }
  const total = /your points\s*:?\s*(\d+)/i.exec(n);
  if (total) out.pointsTotal = Number(total[1]) || 0;
  return out;
}

// Result screen se reward text nikalna — "REWARD: BETTER LUCK NEXT TIME".
export function parseGoldDropAiReward(text = '') {
  const n = decodeSmallCaps(text);
  const m = /reward\s*:\s*(.+)/i.exec(n);
  return m ? m[1].trim().slice(0, 120) : '';
}

// Reward ka kya matlab — "BETTER LUCK NEXT TIME" to kuch nahi won.
export function isGoldDropAiRewardWon(rewardText = '') {
  const n = lightNorm(rewardText);
  return Boolean(n) && !/better\s*luck|no\s*reward|nothing/.test(n);
}

// ---------------------------------------------------------------------------
// 🎯 MAIN FLOW — ek number ka single claim @GoldDropAi par, OTP bot se join
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function reportCard(report, html) {
  if (typeof report !== 'function') return Promise.resolve();
  try { return Promise.resolve(report(html)).catch(() => {}); } catch { return Promise.resolve(); }
}

// Number bhejne ke baad OTP prompt / processing screens pe CANCEL dabakar
// claim ko safe terminate karna (number dobara nahi jayega).
async function cancelGoldDropAiClaim(client, entity) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const screens = await parseGoldDropScreens(client, entity, 6, { fresh: true });
      const hit = findGoldDropAiButtonOnScreens(screens, 'cancel');
      if (hit) {
        await clickGoldDropButton(hit).catch(() => {});
        console.log(`[GoldDropAiBridge] 🛑 claim terminate: "${hit.text}" dabaya`);
        await sleep(1_200);
        return true;
      }
    } catch {}
    await sleep(800);
  }
  return false;
}

// Terminal result screens (result / registrationFailed / invalidOtp) —
// processing screen in between ignore kar do.
function classifyTerminal(messages = []) {
  for (const m of messages) {
    const k = goldDropAiScreenKind(String(m?.text || ''));
    if (k === 'result') return { kind: 'result', screen: m };
    if (k === 'registrationFailed') return { kind: 'registrationFailed', screen: m };
    if (k === 'invalidOtp') return { kind: 'invalidOtp', screen: m };
  }
  return null;
}

export async function runGoldDropAiClaim({
  phone,
  otpProvider,
  otpWatermark,
  report,
  shouldAbort,
  config = {},
} = {}) {
  const cfg = { ...goldDropAiBridgeConfig(), ...(config || {}) };
  const cleanPhone = normalizeGoldDropPhone(phone);
  state.username = cfg.username;
  state.phone = cleanPhone;
  state.phase = 'start';
  state.lastError = '';
  state.recentScreens = [];
  state.step = 0;

  if (!isGoldDropPhoneValid(cleanPhone)) {
    return { ok: false, kind: 'failed_invalid_phone', phone: cleanPhone, reason: '10-digit valid mobile number chahiye (6/7/8/9 se shuru)' };
  }
  if (typeof otpProvider !== 'function') {
    return { ok: false, kind: 'no-otp-provider', phone: cleanPhone, reason: 'OTP provider missing — OTP bot se code lane ke liye' };
  }

  // baseline map se changed/new messages nikalna — edited screens bhi
  // milte hain (Telegram editMessage), wo bhi fresh maan lo.
  const changedOrNew = (m, base) => {
    if (!base) return true;
    const sig = screenSignature([m]).get(m?.id);
    return !base.has(m?.id) || base.get(m?.id) !== sig;
  };
  const poolFrom = (all, base) => {
    const seen = new Set();
    const out = [];
    for (const m of all) {
      if (changedOrNew(m, base) && !seen.has(m?.id)) {
        seen.add(m?.id);
        out.push(m);
      }
    }
    return out;
  };

  try {
    return await withGoldDropBridgeClient(async ({ client }) => {
      const entity = await getGoldDropEntity(client, cfg.username);

      // numberPrompt screen ka intezaar (CLAIM REWARD click/text ke baad).
      // Current screen pe number prompt ho to intezaar hi nahi.
      const ensureNumberPrompt = async () => {
        const cur = await parseGoldDropScreens(client, entity, 6, { fresh: true });
        if (goldDropAiHasPromptKind(cur, 'numberPrompt')) return;
        const before = screenSignature(cur);
        await waitForGoldDropReply({
          client, entity, cfg, baseline: before, shouldAbort,
          what: 'number prompt', timeoutMs: cfg.stepTimeoutMs,
          predicate: (fresh, all) => goldDropAiHasPromptKind(poolFrom(all, before), 'numberPrompt'),
        });
      };

      // Ek claim round — number prompt par hona lazmi. Number → OTP
      // DISPATCHED → OTP → terminal result. Outcome: { kind: 'result' |
      // 'registrationFailed' | 'invalidOtp' | 'otpMiss' | 'terminal' |
      // 'timeout', ... }
      const attemptRound = async () => {
    // 🔖 OTP bot ka watermark number bhejne se THIK PEHLE — iske baad
    // aaya/edited code hi is claim ka naya OTP hai.
    let watermark = null;
    if (typeof otpWatermark === 'function') {
      try {
        watermark = await otpWatermark();
        console.log(`[GoldDropAiBridge] 🔖 OTP watermark set (${cleanPhone}) — ab iske baad ka code hi naya`);
      } catch (error) {
        console.warn(`[GoldDropAiBridge] ⚠️ OTP watermark fail: ${String(error?.message || error).slice(0, 90)}`);
      }
    }

    setPhase('send-number');
    await reportCard(report, [
      '🤖 <b>Gold Drop AI Bridge — @' + cfg.username + '</b>',
      `📱 <b>Number:</b> <code>${cleanPhone}</code>`,
      '→ number bhej raha hoon, OTP dispatch ka intezaar hai…',
    ].join('\n'));
    const numBefore = screenSignature(await parseGoldDropScreens(client, entity, 6));
    await sendGoldDropText(client, entity, cleanPhone);

    // (b) OTP DISPATCHED screen — beech me processing screen aa sakta hai
    //     (ignore ho jata hai — sirf dispatched hi match kare).
    setPhase('otp-dispatch');
    const dispatched = await waitForGoldDropReply({
      client, entity, cfg, baseline: numBefore, shouldAbort,
      what: 'OTP DISPATCHED screen', timeoutMs: cfg.otpDispatchTimeoutMs,
      predicate: (fresh, all) => goldDropAiHasPromptKind(poolFrom(all, numBefore), 'otpDispatched'),
    }).catch(async (error) => {
      if (/aborted/i.test(String(error?.message || ''))) throw error;
      // Bot kabhi sidha result/error de de — us case uske aage chalo.
      const now = await parseGoldDropScreens(client, entity, 8, { fresh: true }).catch(() => []);
      const term = classifyTerminal(now);
      if (term) return { terminal: term };
      throw error;
    });
    if (dispatched?.terminal) return { kind: 'terminal', term: dispatched.terminal };

    // (c) OTP lao (OTP bot chat se) aur bhejo — watchdog ke saath, kabhi
    //     lock hang na rahe.
    setPhase('otp-wait');
    await reportCard(report, [
      '🤖 <b>Gold Drop AI Bridge — @' + cfg.username + '</b>',
      `📱 <code>${cleanPhone}</code> · OTP bot me code ka intezaar (${Math.round(cfg.otpInboxTimeoutMs / 1000)}s)…`,
    ].join('\n'));
    const inboxMs = Math.max(20_000, Number(cfg.otpInboxTimeoutMs) || 90_000);
    const fetchStartedAt = Date.now();
    console.log(`[GoldDropAiBridge] 🔎 OTP fetch shuru — ${cleanPhone} · budget ${Math.round(inboxMs / 1000)}s`);
    const otp = await Promise.race([
      otpProvider({ watermark, phone: cleanPhone }),
      new Promise((resolve) => setTimeout(() => resolve({
        code: '',
        error: `OTP fetch ${Math.round((Date.now() - fetchStartedAt) / 1000)}s me wapas nahi aaya (Telegram lock/hang) — claim terminate`,
      }), inboxMs + 15_000).unref?.()),
    ]);
    console.log(`[GoldDropAiBridge] 🔎 OTP fetch khatam (${Date.now() - fetchStartedAt}ms) — ${otp?.code ? 'code mila' : 'code nahi mila'}`);
    if (!otp?.code || !isGoldDropOtpValid(normalizeGoldDropOtp(otp.code))) {
      // 🛑 OTP nahi mila / galat shakl — CANCEL dabakar claim terminate.
      await cancelGoldDropAiClaim(client, entity);
      return {
        kind: 'otpMiss',
        reason: otp?.error || `OTP bot chat me code nahi mila: "${String(otp?.code || '').slice(0, 12)}" — claim terminate`,
      };
    }

    setPhase('otp-verify');
    state.lastAction = `otp:${otp.code}`;
    const otpBefore = screenSignature(await parseGoldDropScreens(client, entity, 6));
    await sendGoldDropText(client, entity, normalizeGoldDropOtp(otp.code));

    // (d) terminal result ka intezaar: REWARD / REGISTRATION FAILED /
    //     INVALID OTP (processing ignore ho jata hai).
    setPhase('result-wait');
    const outcome = await waitForGoldDropReply({
      client, entity, cfg, baseline: otpBefore, shouldAbort,
      what: 'claim result', timeoutMs: cfg.otpVerifyWaitMs,
      predicate: (fresh, all) => classifyTerminal(poolFrom(all, otpBefore)),
    }).catch(() => null);

    if (outcome?.terminal) return { kind: outcome.terminal.kind, term: outcome.terminal };

    // Deadline khatam — jo screen hai usi se best-effort classify karo.
    const now = await parseGoldDropScreens(client, entity, 8, { fresh: true }).catch(() => []);
    const term = classifyTerminal(now);
    if (term) return { kind: term.kind, term };
    return { kind: 'timeout', reason: 'Claim result screen time-out me nahi aayi' };
  };

  // ---- 1) /start → menu → CLAIM REWARD button ----
      setPhase('start');
      const startBefore = screenSignature(await parseGoldDropScreens(client, entity));
      await sendGoldDropText(client, entity, '/start');
      await waitForGoldDropReply({
        client, entity, cfg, baseline: startBefore,
        what: '/start ka menu', timeoutMs: cfg.startTimeoutMs, shouldAbort,
        predicate: (fresh, all) => findGoldDropAiButtonOnScreens([...fresh, ...all], 'claimReward'),
      });
      state.step = 1;

      const claimHit = findGoldDropAiButtonOnScreens(
        await parseGoldDropScreens(client, entity, 8, { fresh: true }), 'claimReward');
      if (!claimHit) throw new Error('CLAIM REWARD button nahi mila');
      await triggerGoldDropButton({
        client, entity, cfg, shouldAbort, entry: claimHit, what: 'CLAIM REWARD',
        predicate: (fresh, all) => goldDropAiHasPromptKind([...fresh, ...all], 'numberPrompt')
          || findGoldDropAiButtonOnScreens([...fresh, ...all], 'claimReward'),
      });

      // ---- 2) claim attempts — invalid OTP par ek baar retry ----
      await ensureNumberPrompt();
      let invalidRetries = 0;
      for (;;) {
        const outcome = await attemptRound();

        if (outcome.kind === 'result') {
          const text = String(outcome.term?.screen?.text || '');
          const reward = parseGoldDropAiReward(text);
          const points = parseGoldDropAiPoints(text);
          state.lastOkAt = Date.now();
          state.step = 3;
          setPhase('done');
          console.log(`[GoldDropAiBridge] ✅ claim ho gaya — ${cleanPhone} · reward "${reward}" · points left ${points.pointsLeft}`);
          await reportCard(report, [
            '🤖 <b>Gold Drop AI Bridge — Result</b>',
            `📱 <code>${cleanPhone}</code> · @${cfg.username}`,
            `✅ Reward: <b>${reward || '—'}</b>`,
            `📈 Points left: <b>${points.pointsLeft}</b> (used ${points.pointsUsed})`,
          ].join('\n'));
          return {
            ok: true,
            kind: 'claim_done',
            phone: cleanPhone,
            username: cfg.username,
            reward,
            rewardWon: isGoldDropAiRewardWon(reward) ? 1 : 0,
            ...points,
          };
        }

        if (outcome.kind === 'registrationFailed') {
          // Email already used — ye number dobara nahi chalega (one-shot).
          console.warn(`[GoldDropAiBridge] ⚠️ registration failed — ${cleanPhone} (email already used), number chhod`);
          return {
            ok: false,
            kind: 'registration_failed',
            phone: cleanPhone,
            reason: 'Bot ne REGISTRATION FAILED diya — STATUS: THIS EMAIL IS ALREADY USED',
          };
        }

        if (outcome.kind === 'otpMiss') {
          return {
            ok: false,
            kind: 'failed_otp_miss',
            phone: cleanPhone,
            reason: outcome.reason,
          };
        }

        if (outcome.kind === 'timeout') {
          return {
            ok: false,
            kind: 'failed_claim',
            phone: cleanPhone,
            reason: outcome.reason,
          };
        }

        // invalid OTP — same number ek baar retry (fresh OTP).
        if (invalidRetries < cfg.maxInvalidOtpRetries) {
          invalidRetries += 1;
          console.warn(`[GoldDropAiBridge] ⚠️ invalid OTP (${cleanPhone}) — dobara try ${invalidRetries}/${cfg.maxInvalidOtpRetries}`);
          await reportCard(report, [
            '🤖 <b>Gold Drop AI Bridge — Retry</b>',
            `📱 <code>${cleanPhone}</code> · INVALID OTP — CLAIM REWARD se dobara try kar raha hoon…`,
          ].join('\n'));
          // TAP CLAIM REWARD TO RETRY — retry screen par button nahi hota,
          // text type kar do (owner ka screenshots wala rule).
          const retryBefore = screenSignature(await parseGoldDropScreens(client, entity, 6));
          await sendGoldDropText(client, entity, 'CLAIM REWARD');
          await waitForGoldDropReply({
            client, entity, cfg, baseline: retryBefore, shouldAbort,
            what: 'retry ka number prompt', timeoutMs: cfg.stepTimeoutMs,
            predicate: (fresh, all) => goldDropAiHasPromptKind(poolFrom(all, retryBefore), 'numberPrompt'),
          });
          continue; // number prompt aa gayi — agla round chalo
        }
        console.warn(`[GoldDropAiBridge] ⚠️ invalid OTP (${cleanPhone}) — retries khatam, number chhod`);
        return {
          ok: false,
          kind: 'invalid_otp',
          phone: cleanPhone,
          reason: 'Doosri baar bhi INVALID OTP aa raha hai — claim cancelled, number chhod diya',
        };
      }
    });
  } catch (error) {
    state.lastError = String(error?.message || error);
    const aborted = /aborted|owner ne stop/i.test(String(error?.message || ''));
    if (aborted) {
      return { ok: false, kind: 'aborted', phone: cleanPhone, reason: 'Owner ne STOP kiya' };
    }
    return {
      ok: false,
      kind: 'failed_claim',
      phone: cleanPhone,
      reason: String(error?.message || error).slice(0, 240),
    };
  }
}

// ---------------------------------------------------------------------------
// 🤖 AUTO BATCH — Swiggy wala fully-auto loop: number OTP bot se khud leh,
// @GoldDropAi pe khud bhej, OTP khud type, ek number khatam to agla.
//
//   getNextNumber({ excludePhones, shouldAbort }) → { phone }   (OTP bot se)
//   runClaim(phone, { report, shouldAbort }) → runGoldDropAiClaim ka result
//
// Ek number ka claim fail ho (email already used / invalid OTP / OTP miss)
// to wahi number dobara nahi aata (one-shot) — agla number turant. Target
// poora hone ya STOP par rukna.
// ---------------------------------------------------------------------------
export async function runGoldDropAiAutoClaims({
  target,
  getNextNumber,
  runClaim,
  report,
  shouldAbort,
  config = {},
} = {}) {
  const cfg = { ...goldDropAiBridgeConfig(), ...(config || {}) };
  const want = Math.max(1, Math.min(200, Math.trunc(Number(target) || 1)));
  const usedPhones = new Set();
  const results = [];
  let processed = 0;
  let claimsTotal = 0;
  let rewardsTotal = 0;
  let stopped = false;
  let lastError = '';

  const progressHtml = (phone, note) => [
    '🤖 <b>Gold Drop AI Bridge — Auto Batch</b>',
    `📨 OTP bot se number auto-fetch · @${cfg.username}`,
    `📊 Processed: <b>${processed}/${want}</b> · Claims: <b>${claimsTotal}</b> · Rewards: <b>${rewardsTotal}</b>`,
    phone ? `📱 Current: <code>${phone}</code>` : '',
    note,
  ].filter(Boolean).join('\n');

  try {
    while (processed < want) {
      if (typeof shouldAbort === 'function' && shouldAbort()) {
        stopped = true;
        break;
      }
      // 1) 🔢 Number auto-fetch — OTP bot se (Swiggy pipeline waisa hi).
      setPhase(`auto-number-${processed + 1}`);
      await reportCard(report, progressHtml('', 'OTP bot se number le raha hoon…'));
      const entry = await getNextNumber({
        excludePhones: [...usedPhones],
        shouldAbort: typeof shouldAbort === 'function' ? shouldAbort : null,
      });
      const phone = normalizeGoldDropPhone(entry?.phone);
      if (!isGoldDropPhoneValid(phone)) {
        throw new Error(`OTP bot se valid mobile number nahi mila: "${String(entry?.phone || '').slice(0, 24)}" — batch ruka`);
      }
      if (usedPhones.has(phone)) {
        throw new Error(`OTP bot ne wahi number dobara diya: ${phone} — batch ruka`);
      }
      // Number constraint ho gayi hai (OTP bot se claim ho chuki) — pehle
      // record kar do, phir claim chalo. STOP is number ke claim ko apne
      // andar rok lega — number kaam nahi jayega.
      usedPhones.add(phone);
      processed += 1;
      state.phone = phone;
      console.log(`[GoldDropAiBridge] 🔢 auto number ${processed}/${want}: ${phone}`);

      // 2) 🔗 single claim — @GoldDropAi pe khud bhej kar chalo.
      setPhase(`auto-claim-${processed}`);
      const result = await runClaim(phone, {
        report: html => reportCard(report, progressHtml(phone, '')).then(() => reportCard(report, html)),
        shouldAbort,
      });
      const one = {
        phone,
        ok: Boolean(result?.ok),
        kind: String(result?.kind || ''),
        reward: String(result?.reward || ''),
        rewardWon: Number(result?.rewardWon) || 0,
        reason: String(result?.reason || ''),
      };
      results.push(one);
      if (one.ok) {
        claimsTotal += 1; // ek number = ek claim
        rewardsTotal += one.rewardWon;
      } else {
        // ⚠️ Ek number ka claim fail = wahi number khatam (one-shot) — agla
        // number turant, batch nahi rukti.
        lastError = one.reason || 'claim fail';
        console.warn(`[GoldDropAiBridge] ⚠️ ${phone} claim fail — ${lastError.slice(0, 90)} · agla number`);
      }
      await reportCard(report, progressHtml(phone, one.ok
        ? `✅ reward "${one.reward || '—'}" · agla number…`
        : `⚠️ claim terminate — agla number…`));
      if (typeof shouldAbort === 'function' && shouldAbort()) {
        stopped = true;
        break;
      }
    }
  } catch (error) {
    const text = String(error?.message || error);
    if (/aborted|owner ne stop/i.test(text)) {
      stopped = true;
    } else {
      lastError = text;
      state.lastError = text;
    }
  }

  setPhase(stopped ? 'auto-stopped' : 'auto-done');
  console.log(`[GoldDropAiBridge] 🤖 auto batch khatam — processed ${processed}/${want} · claims ${claimsTotal} · rewards ${rewardsTotal}${stopped ? ' · STOP' : ''}`);
  return {
    ok: !lastError || processed >= want,
    processed,
    target: want,
    claimsTotal,
    rewardsTotal,
    stopped,
    lastError,
    phones: [...usedPhones],
    results,
    username: cfg.username,
  };
}

// ---------------------------------------------------------------------------
// 🔍 PROBE — connection + latest screen check (Settings / diagnostics)
// ---------------------------------------------------------------------------
export async function probeGoldDropAiBridge({ limit = 5, config = goldDropAiBridgeConfig() } = {}) {
  const cfg = { ...goldDropAiBridgeConfig(), ...(config || {}) };
  try {
    return await withGoldDropBridgeClient(async ({ client }) => {
      const entity = await getGoldDropEntity(client, cfg.username);
      const messages = await parseGoldDropScreens(client, entity, Math.max(1, Number(limit) || 5));
      const screens = messages.map((m) => ({
        id: m.id,
        text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 300),
        buttons: m.buttons.map((b) => b.text),
        hasMedia: m.hasMedia,
        at: m.dateMs ? new Date(m.dateMs).toISOString() : '',
      }));
      const latestWithButtons = screens.find((s) => s.buttons.length) || screens[0] || null;
      return {
        ok: true,
        username: cfg.username,
        screen: latestWithButtons,
        screens,
        client: true,
      };
    });
  } catch (error) {
    state.lastError = String(error?.message || error);
    return { ok: false, username: cfg.username, reason: String(error?.message || error).slice(0, 220) };
  }
}

export function getGoldDropAiBridgeStatus() {
  const s = getGoldDropBridgeState();
  return {
    ...s,
    username: s.username || goldDropAiBridgeUsername(),
    lastScreenButtons: [...(s.lastScreenButtons || [])],
    recentScreens: [...(s.recentScreens || [])],
  };
}
