// Unit tests — Gold Drop Bridge (@rajafuckbot + OTP bot join).
//   node test_gold-drop-bridge.mjs
//
// Kya cover hota hai (network ke bina, pure helpers):
//   • Button roles — MANUAL CLAIM (3x) / CANCEL CLAIM / FINISH / CANCEL / …
//   • Screen kinds — number prompt, OTP request, OTP prompt, claim states,
//     summary (screenshots ke asli screens ke hisaab se)
//   • Claim index / mobile / OTP / summary parse
//   • Latest-screen button selection (purane screens ke buttons nahi)
//   • Config — username default + env override

import assert from 'node:assert/strict';
import {
  goldDropBridgeButtonRole,
  pickGoldDropBridgeButton,
  findGoldDropButtonOnScreens,
  goldDropBridgeScreenKind,
  goldDropBridgeHasPromptKind,
  parseGoldDropClaimIndex,
  parseGoldDropMobileFromText,
  normalizeGoldDropPhone,
  isGoldDropPhoneValid,
  normalizeGoldDropOtp,
  isGoldDropOtpValid,
  parseGoldDropSummary,
  goldDropBridgeUsername,
  goldDropBridgeConfig,
  _setGoldDropBridgeClientOverrideForTests,
  runGoldDropManualClaim,
  runGoldDropAutoClaims,
} from './gold-drop-bridge.js';

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

console.log('— Button roles —');
ok(goldDropBridgeButtonRole('MANUAL CLAIM (3x)') === 'manualClaim', 'MANUAL CLAIM (3x) → manualClaim');
ok(goldDropBridgeButtonRole('CANCEL CLAIM') === 'cancelClaim', 'CANCEL CLAIM → cancelClaim');
ok(goldDropBridgeButtonRole('CANCEL') === 'cancel', 'CANCEL → cancel');
ok(goldDropBridgeButtonRole('FINISH / STOP CLAIMS') === 'finishStop', 'FINISH / STOP CLAIMS → finishStop');
ok(goldDropBridgeButtonRole('CLAIM ANOTHER NUMBER') === 'claimAnother', 'CLAIM ANOTHER NUMBER → claimAnother');
ok(goldDropBridgeButtonRole('MAIN MENU') === 'mainMenu', 'MAIN MENU → mainMenu');
ok(goldDropBridgeButtonRole('BACK TO MENU') === 'backToMenu', 'BACK TO MENU → backToMenu');
ok(goldDropBridgeButtonRole('MY FIREBASE') === '', 'MY FIREBASE → no role');
ok(goldDropBridgeButtonRole('ADD BULK') === '', 'ADD BULK → no role');
ok(goldDropBridgeButtonRole('MY SOLVER KEYS') === '', 'MY SOLVER KEYS → no role');
// Fancy/small-caps text bhi dhundhe (owner ka OTP bots wala rule).
ok(goldDropBridgeButtonRole('ᴍᴀɴᴜᴀʟ claim (3x)') === 'manualClaim', 'small-caps MANUAL CLAIM → manualClaim');
// Order matters — "CANCEL CLAIM" par sirf cancelClaim, "cancel" nahi.
ok(goldDropBridgeButtonRole('Cancel Claim') === 'cancelClaim', 'Cancel Claim → cancelClaim (cancel se pehle)');

console.log('— Screen kinds (screenshots ke asli screens) —');
ok(goldDropBridgeScreenKind('PLEASE TYPE AND SEND THE 10-DIGIT MOBILE NUMBER:\n(E.G. 9876543210)') === 'numberPrompt', 'number prompt');
ok(goldDropBridgeScreenKind('STARTING CLAIM 1 OF 3...') === 'claimInitiating', 'STARTING CLAIM 1 OF 3');
ok(goldDropBridgeScreenKind('INITIATING CLAIM #2/3...') === 'claimInitiating', 'INITIATING CLAIM #2/3');
ok(goldDropBridgeScreenKind('SOLVING TURNSTILE CAPTCHA & REQUESTING SMS OTP...') === 'otpRequesting', 'solving captcha / requesting OTP');
ok(goldDropBridgeScreenKind('OTP SENT SUCCESSFULLY![1/3]') === 'otpRequested', 'OTP SENT SUCCESSFULLY [1/3]');
ok(goldDropBridgeScreenKind('OTP SENT FOR CLAIM #2/3!') === 'otpRequested', 'OTP SENT FOR CLAIM #2/3');
ok(goldDropBridgeScreenKind('PLEASE ENTER THE 6-DIGIT OTP CODE BELOW:') === 'otpPrompt', 'OTP prompt (claim 1)');
ok(goldDropBridgeScreenKind('PLEASE ENTER THE NEXT 6-DIGIT OTP CODE BELOW:\n(OR TAP FINISH IF YOU WISH TO STOP AFTER CLAIM #1)') === 'otpPrompt', 'OTP prompt (claim 2/3)');
ok(goldDropBridgeScreenKind('CLAIM#1COMPLETED!\nSTATUS: THANK YOU FOR YOUR PARTICIPATION') === 'claimCompleted', 'CLAIM #1 COMPLETED');
ok(goldDropBridgeScreenKind('VERIFYING OTP FOR CLAIm #3/3...') === 'verifying', 'VERIFYING OTP FOR CLAIM #3/3');
ok(goldDropBridgeScreenKind('MANUALCLAIMSSUMMARY\nMOBILE: +918058935275') === 'summary', 'MANUAL CLAIMS SUMMARY');
ok(goldDropBridgeScreenKind('BACK TO MENU') === '', 'BACK TO MENU → no kind');

console.log('— Claim index parse —');
ok(parseGoldDropClaimIndex('OTP SENT SUCCESSFULLY![1/3]') === 1, '[1/3] → 1');
ok(parseGoldDropClaimIndex('OTP SENT FOR CLAIM #2/3!') === 2, 'CLAIM #2/3 → 2');
ok(parseGoldDropClaimIndex('CLAIM #3 COMPLETED!') === 3, 'CLAIM #3 COMPLETED → 3');
ok(parseGoldDropClaimIndex('STARTING CLAIM 1 OF 3...') === 1, 'STARTING CLAIM 1 OF 3 → 1');
ok(parseGoldDropClaimIndex('koi claim text nahi') === 0, 'no index → 0');

console.log('— Mobile / OTP normalize —');
ok(parseGoldDropMobileFromText('MOBILE: +91 6287974582') === '6287974582', 'MOBILE: +91 6287974582 → 6287974582');
ok(normalizeGoldDropPhone('+91 98765 43210') === '9876543210', '+91 98765 43210 → 9876543210');
ok(isGoldDropPhoneValid('9876543210') === true, '9876543210 valid');
ok(isGoldDropPhoneValid('1234567890') === false, '1234567890 invalid (1 se shuru)');
ok(normalizeGoldDropOtp('395 388') === '395388', '395 388 → 395388');
ok(isGoldDropOtpValid('395388') === true, '395388 valid OTP');
ok(isGoldDropOtpValid('12345') === false, '12345 invalid OTP');

console.log('— Summary parse —');
const summary = parseGoldDropSummary([
  'MANUAL CLAIMS SUMMARY',
  'MOBILE: +91 6287974582',
  'NAME: Neha Joshi',
  'EMAIL: nehajoshi14356@gmail.com',
  'PINCODE: 508245',
  'CLAIMS COMPLETED: 3/3',
  'REWARDS WON: 1',
  "PRIZES: {'name': 'Cashback, 'face_value': 116}",
].join('\n'));
ok(summary.claimsCompleted === 3, 'summary claimsCompleted 3');
ok(summary.claimsTotal === 3, 'summary claimsTotal 3');
ok(summary.rewardsWon === 1, 'summary rewardsWon 1');
// PRIZES line aasaani se valid JSON nahi (single quotes) — honest parse:
// valid JSON to object, nahi to raw string (kuch invent nahi karte).
ok(summary.prizes && String(summary.prizes).includes('Cashback'), 'summary prizes parsed');

const summary2 = parseGoldDropSummary('MANUAL CLAIMS SUMMARY\nCLAIMS COMPLETED: 2/3\nREWARDS WON: 0');
ok(summary2.claimsCompleted === 2 && summary2.claimsTotal === 3, 'summary 2/3');
ok(summary2.rewardsWon === 0, 'summary rewardsWon 0');
const summary3 = parseGoldDropSummary('MANUAL CLAIMS SUMMARY\nCLAIMS COMPLETED: 3/3\nREWARDS WON: 1\nPRIZES: {"name": "Cashback", "face_value": 116}');
ok(summary3.prizes && summary3.prizes.name === 'Cashback' && summary3.prizes.face_value === 116, 'summary valid JSON prizes → object');

console.log('— Button selection (latest screen pe dhoondho) —');
const screens = [
  { out: false, text: 'MANUAL CLAIM (3x FLOW)', buttons: [{ text: 'CANCEL CLAIM' }, { text: 'BACK TO MENU' }] },
  { out: true, text: '6287974582', buttons: [] },
];
const cancelHit = findGoldDropButtonOnScreens(screens, 'cancelClaim');
ok(cancelHit && cancelHit.text === 'CANCEL CLAIM', 'latest screen se CANCEL CLAIM');
ok(findGoldDropButtonOnScreens(screens, 'manualClaim') === null, 'purane screen par manualClaim nahi');
ok(pickGoldDropBridgeButton([{ text: 'FINISH / STOP CLAIMS' }, { text: 'CANCEL' }], 'finishStop')?.text === 'FINISH / STOP CLAIMS', 'pick FINISH / STOP CLAIMS');

const menuScreens = [{ out: false, text: 'GOLD DROP AUTOMATION', buttons: [{ text: 'MY FIREBASE' }, { text: 'MANUAL CLAIM (3x)' }] }];
ok(findGoldDropButtonOnScreens(menuScreens, 'manualClaim')?.text === 'MANUAL CLAIM (3x)', 'menu se MANUAL CLAIM (3x)');

console.log('— hasPromptKind —');
ok(goldDropBridgeHasPromptKind(screens, 'numberPrompt') === false, 'numberPrompt nahi hai');
ok(goldDropBridgeHasPromptKind([{ text: 'PLEASE ENTER THE 6-DIGIT OTP CODE BELOW:' }], 'otpPrompt') === true, 'otpPrompt hai');

console.log('— Config —');
ok(goldDropBridgeUsername({}) === 'rajafuckbot', 'default username rajafuckbot');
ok(goldDropBridgeUsername({ GOLD_DROP_BRIDGE_BOT_USERNAME: '@MyGoldBot' }) === 'MyGoldBot', 'env username @MyGoldBot → MyGoldBot');
const cfg = goldDropBridgeConfig({});
ok(cfg.username === 'rajafuckbot', 'config username');
ok(cfg.maxClaims === 3, 'config maxClaims 3');
ok(cfg.trigger === 'auto', 'config trigger auto');
const cfg2 = goldDropBridgeConfig({ GOLD_DROP_BRIDGE_MAX_CLAIMS: '2', GOLD_DROP_BRIDGE_TRIGGER: 'type' });
ok(cfg2.maxClaims === 2, 'env maxClaims 2');
ok(cfg2.trigger === 'type', 'env trigger type');

// ---------------------------------------------------------------------------
// Engine test — mock Telegram client se poora 3x claim flow (koi network
// nahi). Bot screens screenshots ke hisaab se script kiye gaye hain.
// ---------------------------------------------------------------------------
console.log('— Engine (mock client se poora 3x flow) —');

function makeMockGoldDropBot({ otpCodes = ['111222', '222333', '333444'] } = {}) {
  const msgs = [];
  const sent = [];
  let n = 1;
  let claim = 0;
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
          if (t === 'MANUAL CLAIM (3x)') {
            bot('MANUAL CLAIM (3x FLOW) — CLAIM GOLD DROP REWARDS MANUALLY FOR ANY NUMBER.\n'
              + 'PLEASE TYPE AND SEND THE 10-DIGIT MOBILE NUMBER:\n(E.G. 9876543210)');
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
        bot('GOLD DROP AUTOMATION', ['MY FIREBASE', 'MANUAL CLAIM (3x)', 'MY STATS']);
      } else if (/^\d{10}$/.test(t)) {
        claim = 1;
        bot(`STARTING CLAIM 1 OF 3...\nMOBILE: +91 ${t}`);
        bot('SOLVING TURNSTILE CAPTCHA & REQUESTING SMS OTP...');
        bot('OTP SENT SUCCESSFULLY![1/3]');
        bot('PLEASE ENTER THE 6-DIGIT OTP CODE BELOW:', ['CANCEL CLAIM']);
      } else if (/^\d{6}$/.test(t)) {
        claim += 1;
        if (claim === 2) {
          bot('CLAIM#1COMPLETED!\nSTATUS: THANK YOU FOR YOUR PARTICIPATION');
          bot('INITIATING CLAIM #2/3...');
          bot('OTP SENT FOR CLAIM #2/3!');
          bot('PLEASE ENTER THE NEXT 6-DIGIT OTP CODE BELOW:\n(OR TAP FINISH IF YOU WISH TO STOP AFTER CLAIM #1)', ['FINISH / STOP CLAIMS', 'CANCEL']);
        } else if (claim === 3) {
          bot('CLAIM #2COMPLETED!');
          bot('INITIATING CLAIM #3/3...');
          bot('OTP SENT FOR CLAIM #3/3!');
          bot('PLEASE ENTER THE NEXT 6-DIGIT OTP CODE BELOW:\n(OR TAP FINISH IF YOU WISH TO STOP AFTER CLAIM #2)', ['FINISH / STOP CLAIMS', 'CANCEL']);
        } else {
          bot('VERIFYING OTP FOR CLAIm #3/3...');
          bot('MANUALCLAIMSSUMMARY\nMOBILE: +91 6287974582\nCLAIMS COMPLETED: 3/3\nREWARDS WON: 1\n'
            + "PRIZES: {'name': 'Cashback, 'face_value': 116}");
        }
      }
    },
    getMessages: async (entity, { limit }) => msgs.slice(-Math.max(1, limit)).reverse(),
  };
  return { client, sent, otpCodes };
}

{
  const { client, sent, otpCodes } = makeMockGoldDropBot();
  _setGoldDropBridgeClientOverrideForTests(client);
  let otpIdx = 0;
  const result = await runGoldDropManualClaim({
    phone: '9876543210',
    otpProvider: async () => ({ code: otpCodes[otpIdx++] || otpCodes[0] }),
    otpWatermark: async () => ({ ts: Date.now(), afterMs: Date.now() }),
    report: () => {},
    shouldAbort: () => false,
    config: { stepTimeoutMs: 5_000, startTimeoutMs: 3_000, otpRequestTimeoutMs: 3_000, otpVerifyWaitMs: 5_000, otpInboxTimeoutMs: 5_000, pollMs: 50 },
  });
  ok(result?.ok === true, 'engine: 3x flow complete ho gayi');
  ok(result?.claimsCompleted === 3 && result?.claimsTotal === 3, 'engine: claims 3/3');
  ok(result?.rewardsWon === 1, 'engine: rewards won 1');
  ok(sent.includes('/start'), 'engine: /start bheja');
  ok(sent.includes('9876543210'), 'engine: number bheja');
  ok(sent.filter((t) => /^\d{6}$/.test(t)).length === 3, 'engine: teen OTP bheje (1/2/3)');
  ok(otpCodes.every((c) => sent.includes(c)), 'engine: OTP bot se mile codes hi bheje');
  _setGoldDropBridgeClientOverrideForTests(null);
}

// OTP miss → claim terminate + failed_otp_miss.
{
  const { client } = makeMockGoldDropBot();
  _setGoldDropBridgeClientOverrideForTests(client);
  const result = await runGoldDropManualClaim({
    phone: '9876543210',
    otpProvider: async () => ({ code: '', error: 'OTP bot chat me code nahi mila' }),
    otpWatermark: async () => null,
    report: () => {},
    shouldAbort: () => false,
    config: { stepTimeoutMs: 5_000, startTimeoutMs: 3_000, otpRequestTimeoutMs: 3_000, otpVerifyWaitMs: 5_000, otpInboxTimeoutMs: 300, pollMs: 50 },
  });
  ok(result?.ok === false && result?.kind === 'failed_otp_miss', 'engine: OTP miss → failed_otp_miss');
  ok(result?.claim === 1, 'engine: claim 1 par miss hua');
  _setGoldDropBridgeClientOverrideForTests(null);
}

console.log('— Auto batch (number auto-fetch + 3x claims loop) —');

// Happy path: 3 numbers, sab claims ok — tallies aur phones track hone.
{
  const numbers = ['9876543210', '9876543211', '9876543212'];
  let claimed = 0;
  const res = await runGoldDropAutoClaims({
    target: 3,
    getNextNumber: async ({ excludePhones }) => {
      assert.ok(!excludePhones.includes(numbers[claimed]), 'number dobara nahi aata');
      return { phone: numbers[claimed++] };
    },
    runClaim: async (phone) => ({
      ok: true, phone, claimsCompleted: 3, rewardsWon: phone.endsWith('212') ? 2 : 1,
    }),
    report: () => {},
    shouldAbort: () => false,
  });
  ok(res?.ok === true, 'auto: batch complete');
  ok(res?.processed === 3 && res?.target === 3, 'auto: 3 numbers process hue');
  ok(res?.claimsTotal === 9, 'auto: claims total 9 (3x3)');
  ok(res?.rewardsTotal === 4, 'auto: rewards total 4 (1+1+2)');
  ok(res?.phones.length === 3 && res?.phones[0] === '9876543210', 'auto: phones tracked');
  ok(res?.stopped === false, 'auto: no STOP');
}

// One-shot rule: ek number ka claim fail ho to batch nahi rukti — agla number.
{
  let n = 0;
  const res = await runGoldDropAutoClaims({
    target: 3,
    getNextNumber: async () => ({ phone: `987654321${n++}` }),
    runClaim: async (phone) => (phone === '9876543210'
      ? { ok: false, reason: 'OTP bot chat me code nahi mila' }
      : { ok: true, claimsCompleted: 3, rewardsWon: 1 }),
    report: () => {},
    shouldAbort: () => false,
    config: { maxClaims: 3 },
  });
  ok(res?.processed === 3, 'auto: fail ke baad bhi 3 numbers process hue (one-shot)');
  ok(res?.claimsTotal === 6, 'auto: 2 successful numbers → 6 claims');
  ok(res?.ok === true, 'auto: fail hone par bhi batch complete');
}

// Invalid number from OTP bot → batch ruke, saaf error.
{
  const res = await runGoldDropAutoClaims({
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
  const res = await runGoldDropAutoClaims({
    target: 5,
    getNextNumber: async () => ({ phone: `987654321${n++}` }),
    runClaim: async (phone) => ({ ok: true, phone, claimsCompleted: 3, rewardsWon: 1 }),
    report: () => {},
    shouldAbort: () => n >= 2,
  });
  ok(res?.stopped === true, 'auto: STOP par ruk gaya');
  ok(res?.processed === 2, 'auto: STOP se pehle 2 numbers process hue');
  ok(res?.claimsTotal === 6, 'auto: STOP tak 6 claims');
}

console.log(`\n✅ ${passed} tests pass`);
