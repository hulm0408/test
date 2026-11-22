// Unit tests — Gold Drop AI Bridge (@GoldDropAi + OTP bot join).
//   node test_golddropai-bridge.mjs
//
// Kya cover hota hai (network ke bina):
//   • Button roles — CLAIM REWARD / CANCEL / MY ACCOUNT / USER GUIDE / REFER & EARN
//   • Screen kinds — menu, claimReward, number prompt, OTP dispatched,
//     processing, result, registration failed, invalid OTP (screenshots ke
//     asli screens ke hisaab se)
//   • Points / reward parse
//   • Engine — mock client se poora flow (success, registration failed,
//     OTP miss → CANCEL, invalid OTP retry → success, invalid OTP twice)
//   • Auto batch — number auto-fetch loop, one-shot, STOP, invalid number

import assert from 'node:assert/strict';
import {
  goldDropAiButtonRole,
  pickGoldDropAiButton,
  findGoldDropAiButtonOnScreens,
  goldDropAiScreenKind,
  goldDropAiHasPromptKind,
  parseGoldDropAiPoints,
  parseGoldDropAiReward,
  isGoldDropAiRewardWon,
  goldDropAiBridgeUsername,
  goldDropAiBridgeConfig,
  runGoldDropAiClaim,
  runGoldDropAiAutoClaims,
} from './golddropai-bridge.js';
import { _setGoldDropBridgeClientOverrideForTests } from './gold-drop-bridge.js';

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

console.log('— Button roles —');
ok(goldDropAiButtonRole('CLAIM REWARD') === 'claimReward', 'CLAIM REWARD → claimReward');
ok(goldDropAiButtonRole('ᴄʟᴀɪm ʀᴇᴡᴀʀd') === 'claimReward', 'small-caps CLAIM REWARD → claimReward');
ok(goldDropAiButtonRole('TAP CLAIM REWARD TO RETRY') === 'claimReward', 'TAP CLAIM REWARD TO RETRY → claimReward');
ok(goldDropAiButtonRole('CANCEL') === 'cancel', 'CANCEL → cancel');
ok(goldDropAiButtonRole('MY ACCOUNT') === 'myAccount', 'MY ACCOUNT → myAccount');
ok(goldDropAiButtonRole('USER GUIDE') === 'userGuide', 'USER GUIDE → userGuide');
ok(goldDropAiButtonRole('REFER & EARN') === 'referEarn', 'REFER & EARN → referEarn');
ok(goldDropAiButtonRole('SOMETHING ELSE') === '', 'SOMETHING ELSE → no role');

console.log('— Screen kinds (screenshots ke asli screens) —');
ok(goldDropAiScreenKind('⚡️ ɴᴀᴠ ʙᴏᴛ ⚡️\n👑 WELCOME, It\'s ✌️!\n💰 YOUR POINTS: 5 PTS\n💎 TAP CLAIM REWARD TO START') === 'menu', 'menu (/start)');
ok(goldDropAiScreenKind('✅ READY FOR NEXT CLAIM\n✨ TAP CLAIM REWARD BELOW TO PROCEED') === 'claimReward', 'READY FOR NEXT CLAIM');
ok(goldDropAiScreenKind('📱 ENTER MOBILE NUMBER\nSEND YOUR 10-DIGIT MOBILE NUMBER:\nEXAMPLE: 9876543210') === 'numberPrompt', 'number prompt');
ok(goldDropAiScreenKind('🛡️ OTP DISPATCHED\n📱 MOBILE: 6296591407\n📍 STATUS: ENTER 6-DIGIT OTP\n💡 SEND 6-DIGIT OTP OR CANCEL') === 'otpDispatched', 'OTP DISPATCHED');
ok(goldDropAiScreenKind('⏳ UPD... FPROCESSING\n📱 MOBILE: 6296591408\n90%') === 'processing', 'processing screen');
ok(goldDropAiScreenKind('📱 MOBILE: 6296591407\n💡 REWARD: BETTER LUCK NEXT TIME\n📈 POINTS: 5 LEFT (1 USED)') === 'result', 'result screen');
ok(goldDropAiScreenKind('❌ REGISTRATION FAILED\n📱 MOBILE: 6296591407\n⚠️ STATUS: THIS EMAIL IS ALREADY USED') === 'registrationFailed', 'REGISTRATION FAILED');
ok(goldDropAiScreenKind('⚠️ INVALID OTP - CANCELLED\nOTP MUST BE 6 DIGITS. CLAIM CANCELLED.') === 'invalidOtp', 'INVALID OTP');
// Error screens result se pehle dhundhe (reward/points nahi rakhte).
ok(goldDropAiScreenKind('❌ REGISTRATION FAILED\n⚠️ STATUS: THIS EMAIL IS ALREADY USED') === 'registrationFailed', 'registration failed (result se pehle)');

console.log('— Points / reward parse —');
const pts = parseGoldDropAiPoints('📱 MOBILE: 6296591407\n💡 REWARD: BETTER LUCK NEXT TIME\n📈 POINTS: 5 LEFT (1 USED)');
ok(pts.pointsLeft === 5, 'points left 5');
ok(pts.pointsUsed === 1, 'points used 1');
ok(pts.pointsTotal === 0, 'points total 0 (result screen pe nahi)');
const ptsMenu = parseGoldDropAiPoints('💰 YOUR POINTS: 5 PTS');
ok(ptsMenu.pointsTotal === 5, 'menu total points 5');
const ptsSmall = parseGoldDropAiPoints('📈 ᴘᴏɪɴᴛs: 5 ʟᴇꜰᴛ (1 ᴜsᴇd)');
ok(ptsSmall.pointsLeft === 5 && ptsSmall.pointsUsed === 1, 'small-caps points bhi parse');
ok(parseGoldDropAiReward('💡 REWARD: BETTER LUCK NEXT TIME') === 'BETTER LUCK NEXT TIME', 'reward text');
ok(parseGoldDropAiReward('💡 REWARD: ₹50 CASHBACK') === '₹50 CASHBACK', 'reward text (cashback)');
ok(parseGoldDropAiReward('koi reward nahi') === '', 'no reward → empty');
ok(isGoldDropAiRewardWon('BETTER LUCK NEXT TIME') === false, 'better luck → no reward');
ok(isGoldDropAiRewardWon('₹50 CASHBACK') === true, 'cashback → reward won');
ok(isGoldDropAiRewardWon('') === false, 'empty → no reward');

console.log('— Button selection (latest screen pe dhoondho) —');
const screens = [
  { out: false, text: '🛡️ OTP DISPATCHED', buttons: [{ text: 'CANCEL' }] },
  { out: true, text: '6296591407', buttons: [] },
];
const cancelHit = findGoldDropAiButtonOnScreens(screens, 'cancel');
ok(cancelHit && cancelHit.text === 'CANCEL', 'latest screen se CANCEL');
ok(findGoldDropAiButtonOnScreens(screens, 'claimReward') === null, 'purane screen par claimReward nahi');
ok(pickGoldDropAiButton([{ text: 'CLAIM REWARD' }, { text: 'MY ACCOUNT' }], 'claimReward')?.text === 'CLAIM REWARD', 'pick CLAIM REWARD');
ok(goldDropAiHasPromptKind(screens, 'otpDispatched'), 'hasPromptKind otpDispatched');

console.log('— Config —');
ok(goldDropAiBridgeUsername() === 'GoldDropAi', 'default username GoldDropAi');
ok(goldDropAiBridgeUsername({ GOLDDROPAI_BOT_USERNAME: '@MyBot' }) === 'MyBot', 'env username override');
ok(goldDropAiBridgeConfig().maxInvalidOtpRetries === 1, 'default maxInvalidOtpRetries 1');
ok(goldDropAiBridgeConfig({ GOLDDROPAI_MAX_INVALID_OTP_RETRIES: '2' }).maxInvalidOtpRetries === 2, 'env retries override');

console.log('— Engine (mock client se poora single-claim flow) —');

// Bot ka screen state machine — screenshots ke hisaab se.
function makeMockGoldDropAiBot({ mode = 'success' } = {}) {
  const msgs = [];
  const sent = [];
  const clicks = [];
  let n = 1;
  let otpRound = 0;
  let lastPhone = '';
  // Bot ka jawab chronological append; read newest-first (Telegram jaisa).
  const bot = (text, buttons = []) => {
    const msg = {
      id: n++,
      out: false,
      date: Date.now(),
      message: text,
      buttons: buttons.map((t) => ({
        text: t,
        click: async () => {
          clicks.push(t);
          if (t === 'CLAIM REWARD') {
            bot('📱 ENTER MOBILE NUMBER\nSEND YOUR 10-DIGIT MOBILE NUMBER:\nEXAMPLE: 9876543210');
          }
          return { message: `clicked ${t}` };
        },
      })),
    };
    msgs.push(msg);
    return msg;
  };
  const client = {
    getEntity: async () => ({}),
    sendMessage: async (entity, { message }) => {
      const t = String(message);
      sent.push(t);
      if (t === '/start') {
        bot('⚡️ ɴᴀᴠ ʙᴏᴛ ⚡️\n👑 WELCOME, It\'s ✌️!\n💰 YOUR POINTS: 5 PTS\n💎 TAP CLAIM REWARD TO START',
          ['CLAIM REWARD', 'MY ACCOUNT', 'USER GUIDE', 'REFER & EARN']);
      } else if (t === 'CLAIM REWARD') {
        bot('📱 ENTER MOBILE NUMBER\nSEND YOUR 10-DIGIT MOBILE NUMBER:\nEXAMPLE: 9876543210');
      } else if (/^\d{10}$/.test(t)) {
        lastPhone = t;
        bot('⏳ UPD... FPROCESSING\n📱 MOBILE: ' + t + '\n90%', ['CANCEL']);
        bot('🛡️ OTP DISPATCHED\n📱 MOBILE: ' + t + '\n📍 STATUS: ENTER 6-DIGIT OTP\n💡 SEND 6-DIGIT OTP OR CANCEL', ['CANCEL']);
      } else if (/^\d{6}$/.test(t)) {
        otpRound += 1;
        if ((mode === 'invalidAlways') || (mode === 'invalidOnce' && otpRound === 1)) {
          bot('⚠️ INVALID OTP - CANCELLED\nOTP MUST BE 6 DIGITS. CLAIM CANCELLED.\n🔙 TAP CLAIM REWARD TO RETRY');
        } else if (mode === 'registrationFailed') {
          bot('❌ REGISTRATION FAILED\n📱 MOBILE: ' + lastPhone + '\n⚠️ STATUS: THIS EMAIL IS ALREADY USED\n🔙 TAP CLAIM REWARD TO RETRY');
        } else {
          bot('📱 MOBILE: ' + lastPhone + '\n💡 REWARD: BETTER LUCK NEXT TIME\n📈 POINTS: 5 LEFT (1 USED)');
          bot('⚡️ ɴᴀᴠ ʙᴏᴛ\n✅ READY FOR NEXT CLAIM\n✨ TAP CLAIM REWARD BELOW TO PROCEED', ['CLAIM REWARD']);
        }
      }
    },
    getMessages: async (entity, { limit }) => msgs.slice(-Math.max(1, limit)).reverse(),
  };
  return { client, sent, clicks };
}

const ENGINE_CONFIG = {
  stepTimeoutMs: 5_000,
  startTimeoutMs: 3_000,
  otpDispatchTimeoutMs: 3_000,
  otpVerifyWaitMs: 5_000,
  otpInboxTimeoutMs: 5_000,
  pollMs: 50,
};

// Happy path: /start → CLAIM REWARD → number → OTP DISPATCHED → OTP → result.
{
  const { client, sent } = makeMockGoldDropAiBot();
  _setGoldDropBridgeClientOverrideForTests(client);
  const result = await runGoldDropAiClaim({
    phone: '6296591407',
    otpProvider: async () => ({ code: '486888' }),
    otpWatermark: async () => ({ ts: Date.now(), afterMs: Date.now() }),
    report: () => {},
    shouldAbort: () => false,
    config: ENGINE_CONFIG,
  });
  ok(result?.ok === true, 'engine: claim complete ho gayi');
  ok(result?.kind === 'claim_done', 'engine: kind claim_done');
  ok(result?.reward === 'BETTER LUCK NEXT TIME', 'engine: reward parsed');
  ok(result?.rewardWon === 0, 'engine: better luck → rewardWon 0');
  ok(result?.pointsLeft === 5 && result?.pointsUsed === 1, 'engine: points parsed');
  ok(sent.includes('/start'), 'engine: /start bheja');
  ok(sent.filter((t) => /^\d{10}$/.test(t)).length === 1, 'engine: ek baar number bheja');
  ok(sent.filter((t) => /^\d{6}$/.test(t)).length === 1, 'engine: ek OTP bheja');
  _setGoldDropBridgeClientOverrideForTests(null);
}

// REGISTRATION FAILED — email already used → number one-shot, CANCEL nahi.
{
  const { client, sent, clicks } = makeMockGoldDropAiBot({ mode: 'registrationFailed' });
  _setGoldDropBridgeClientOverrideForTests(client);
  const result = await runGoldDropAiClaim({
    phone: '6296591407',
    otpProvider: async () => ({ code: '486888' }),
    otpWatermark: async () => null,
    report: () => {},
    shouldAbort: () => false,
    config: ENGINE_CONFIG,
  });
  ok(result?.ok === false, 'engine: registration failed → not ok');
  ok(result?.kind === 'registration_failed', 'engine: kind registration_failed');
  ok(/ALREADY USED/i.test(String(result?.reason)), 'engine: reason already used');
  ok(sent.filter((t) => /^\d{6}$/.test(t)).length === 1, 'engine: OTP to bheja tha');
  ok(!clicks.includes('CANCEL'), 'engine: terminal screen pe CANCEL nahi dabaya');
  _setGoldDropBridgeClientOverrideForTests(null);
}

// OTP miss → CANCEL dabakar claim terminate.
{
  const { client, clicks } = makeMockGoldDropAiBot();
  _setGoldDropBridgeClientOverrideForTests(client);
  const result = await runGoldDropAiClaim({
    phone: '6296591407',
    otpProvider: async () => ({ code: '', error: 'OTP bot chat me code nahi mila' }),
    otpWatermark: async () => null,
    report: () => {},
    shouldAbort: () => false,
    config: { ...ENGINE_CONFIG, otpInboxTimeoutMs: 300 },
  });
  ok(result?.ok === false, 'engine: OTP miss → not ok');
  ok(result?.kind === 'failed_otp_miss', 'engine: kind failed_otp_miss');
  ok(clicks.includes('CANCEL'), 'engine: CANCEL dabaya (OTP prompt pe)');
  _setGoldDropBridgeClientOverrideForTests(null);
}

// INVALID OTP → ek baar retry (CLAIM REWARD text) → success.
{
  const { client, sent, clicks } = makeMockGoldDropAiBot({ mode: 'invalidOnce' });
  _setGoldDropBridgeClientOverrideForTests(client);
  // Pehla OTP galat hai (bot INVALID OTP dega), doosra sahi.
  const codes = ['580622', '275807'];
  let idx = 0;
  const result = await runGoldDropAiClaim({
    phone: '6296591408',
    otpProvider: async () => ({ code: codes[idx++] || codes[0] }),
    otpWatermark: async () => ({ ts: Date.now() }),
    report: () => {},
    shouldAbort: () => false,
    config: ENGINE_CONFIG,
  });
  ok(result?.ok === true, 'engine: invalid OTP ke baad retry success');
  ok(result?.kind === 'claim_done', 'engine: retry ke baad claim_done');
  ok(sent.includes('CLAIM REWARD'), 'engine: retry ke liye CLAIM REWARD text bheja');
  ok(sent.filter((t) => /^\d{10}$/.test(t)).length === 2, 'engine: number teen baar nahi, do baar bheja');
  ok(sent.filter((t) => /^\d{6}$/.test(t)).length === 2, 'engine: do OTP bheje (pehla galat, doosra sahi)');
  _setGoldDropBridgeClientOverrideForTests(null);
}

// INVALID OTP doosri baar bhi → retries khatam, number chhod.
{
  const { client, sent } = makeMockGoldDropAiBot({ mode: 'invalidAlways' });
  _setGoldDropBridgeClientOverrideForTests(client);
  let idx = 0;
  const result = await runGoldDropAiClaim({
    phone: '6296591408',
    otpProvider: async () => ({ code: ['580622', '111222'][idx++] || '580622' }),
    otpWatermark: async () => null,
    report: () => {},
    shouldAbort: () => false,
    config: ENGINE_CONFIG,
  });
  ok(result?.ok === false, 'engine: doosri invalid OTP → not ok');
  ok(result?.kind === 'invalid_otp', 'engine: kind invalid_otp');
  ok(sent.filter((t) => /^\d{10}$/.test(t)).length === 2, 'engine: ek retry tak number do baar bheja');
  _setGoldDropBridgeClientOverrideForTests(null);
}

console.log('— Auto batch (number auto-fetch + single-claim loop) —');

// Happy path: 3 numbers, sab claims ok.
{
  const numbers = ['9876543210', '9876543211', '9876543212'];
  let claimed = 0;
  const res = await runGoldDropAiAutoClaims({
    target: 3,
    getNextNumber: async ({ excludePhones }) => {
      assert.ok(!excludePhones.includes(numbers[claimed]), 'number dobara nahi aata');
      return { phone: numbers[claimed++] };
    },
    runClaim: async (phone) => ({
      ok: true, kind: 'claim_done',
      reward: phone.endsWith('212') ? '₹50 CASHBACK' : 'BETTER LUCK NEXT TIME',
      rewardWon: phone.endsWith('212') ? 1 : 0,
    }),
    report: () => {},
    shouldAbort: () => false,
  });
  ok(res?.ok === true, 'auto: batch complete');
  ok(res?.processed === 3 && res?.target === 3, 'auto: 3 numbers process hue');
  ok(res?.claimsTotal === 3, 'auto: claims total 3 (ek claim per number)');
  ok(res?.rewardsTotal === 1, 'auto: rewards total 1 (sirf 212 pe)');
  ok(res?.phones.length === 3 && res?.phones[0] === '9876543210', 'auto: phones tracked');
  ok(res?.stopped === false, 'auto: no STOP');
}

// One-shot rule: ek number ka claim fail ho to batch nahi rukti — agla number.
{
  let n = 0;
  const res = await runGoldDropAiAutoClaims({
    target: 3,
    getNextNumber: async () => ({ phone: `987654321${n++}` }),
    runClaim: async (phone) => (phone === '9876543210'
      ? { ok: false, kind: 'registration_failed', reason: 'THIS EMAIL IS ALREADY USED' }
      : { ok: true, kind: 'claim_done', reward: 'BETTER LUCK NEXT TIME', rewardWon: 0 }),
    report: () => {},
    shouldAbort: () => false,
  });
  ok(res?.processed === 3, 'auto: fail ke baad bhi 3 numbers process hue (one-shot)');
  ok(res?.claimsTotal === 2, 'auto: 2 successful numbers → 2 claims');
  ok(res?.ok === true, 'auto: fail hone par bhi batch complete');
}

// Invalid number from OTP bot → batch ruke, saaf error.
{
  const res = await runGoldDropAiAutoClaims({
    target: 3,
    getNextNumber: async () => ({ phone: '12345' }),
    runClaim: async () => ({ ok: true }),
    report: () => {},
    shouldAbort: () => false,
  });
  ok(res?.ok === false, 'auto: invalid number → batch ruka');
  ok(/valid mobile number nahi mila/.test(String(res?.lastError)), 'auto: invalid number ka error saaf');
  ok(res?.processed === 0, 'auto: koi number process nahi hua');
}

// STOP: pehle number ke baad user ne STOP kiya → ruk jaye.
{
  let n = 0;
  const res = await runGoldDropAiAutoClaims({
    target: 5,
    getNextNumber: async () => ({ phone: `987654321${n++}` }),
    runClaim: async (phone) => ({ ok: true, kind: 'claim_done', reward: 'BETTER LUCK NEXT TIME', rewardWon: 0 }),
    report: () => {},
    shouldAbort: () => n >= 2,
  });
  ok(res?.stopped === true, 'auto: STOP par ruk gaya');
  ok(res?.processed === 2, 'auto: STOP se pehle 2 numbers process hue');
  ok(res?.claimsTotal === 2, 'auto: STOP tak 2 claims');
}

console.log(`\n✅ ${passed} tests pass`);
