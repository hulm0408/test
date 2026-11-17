import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { GoldDropClient, goldDropEmailForMobile, isGoldDropDailyOtpLimit, signGoldDropPayload, unwrapGoldDropResponse } from './gold-drop-client.js';
import { extractGoldDropReward, isNewGoldDropReward } from './gold-drop-rewards.js';

const key = 'abcdefghijklmnopqrstuv';
const signed = signGoldDropPayload({ otp: '123456' }, key, 'user', '1234');
const [ts, payload, mixed] = signed.split('.');
const m = Number(mixed[0]), p = Number(mixed[1]);
const digest = mixed.slice(2, 2 + p) + mixed.slice(2 + p + m);
assert.equal(Buffer.from(digest, 'base64').toString(), createHmac('sha256', key.slice(4, 18)).update(`${ts}.${payload}`).digest('hex'));
assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64')), { otp: '123456', userKey: 'user', t: '1234' });
assert.deepEqual(unwrapGoldDropResponse({ resp: Buffer.from('{"ok":true}').toString('base64') }), { ok: true });

const calls = [];
const replies = [{ userKey: 'u', dataKey: key }, { statusCode: 200 }, { statusCode: 200 }, { statusCode: 200 }];
const client = new GoldDropClient({ fetchImpl: async (url, options) => {
  calls.push({ url, options });
  return new Response(JSON.stringify(replies.shift()), { status: 200 });
} });
await client.bootstrap({ zip: '509412' });
await client.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') });
await client.verifyOtp('123456');
assert.equal(calls.length, 4);
assert.equal(calls[2].options.headers.Cookie, 'gold-drop-id=u');
assert.match(calls[2].options.body.toString(), /name="img"; filename="pack.jpg"/);
assert.match(calls[3].url, /\/users\/verify-otp\/u\?t=/);
await assert.rejects(client.verifyOtp('123'), /six digits/);
const sample = '▪️ ʟᴀꜱᴛ ꜱᴍꜱ\n[VK-BGCITY-S] Success! Your Reward Code is 7E8RJ9MMYFWA. Please visit https://www.go\nᴛɪᴍᴇ: 17-11-2026 | 05:21 pm';
assert.deepEqual(extractGoldDropReward(sample), { code: '7E8RJ9MMYFWA', sms: '[VK-BGCITY-S] Success! Your Reward Code is 7E8RJ9MMYFWA. Please visit https://www.go' });
assert.equal(isNewGoldDropReward(sample, []), true);
assert.equal(isNewGoldDropReward(sample, [`1|${sample}`]), false);
assert.equal(isNewGoldDropReward(sample.replace('05:21', '05:22'), [`1|${sample}`]), false);
assert.equal(extractGoldDropReward('OTP 123456, registration success'), null);
assert.deepEqual(extractGoldDropReward('[VK-BGCITY-S] Your reward code: ABC12345. Redeem now'), { code: 'ABC12345', sms: '[VK-BGCITY-S] Your reward code: ABC12345. Redeem now' });
assert.deepEqual(extractGoldDropReward('[VK-BGCITY-S] Your reward code is\nAB12CD34. Visit the site\nTIME: 5:21'), { code: 'AB12CD34', sms: '[VK-BGCITY-S] Your reward code is\nAB12CD34. Visit the site' });
assert.equal(extractGoldDropReward('Your OTP code is 123456'), null);
assert.equal(goldDropEmailForMobile('itsnoob012@gmail.com', '9876543210', () => 0), 'itsnoob012+987654@gmail.com');
assert.equal(goldDropEmailForMobile('itsnoob012@gmail.com', '9876543210', n => n - 1), 'itsnoob012+012345@gmail.com');
assert.throws(() => goldDropEmailForMobile('not-an-email', '9876543210'), /Invalid/);
assert.throws(() => goldDropEmailForMobile('itsnoob012@gmail.com', '123'), /Invalid/);
const limitMessage = 'Your OTP limit for today is exhausted. Please try again tomorrow';
assert.equal(isGoldDropDailyOtpLimit(new Error(`Gold Drop HTTP 400: ${limitMessage}`)), true);
assert.equal(isGoldDropDailyOtpLimit(new Error(limitMessage)), true);
assert.equal(isGoldDropDailyOtpLimit(new Error('Gold Drop HTTP 400: Please try again tomorrow using the same number')), true);
assert.equal(isGoldDropDailyOtpLimit(new Error('Gold Drop HTTP 429: Too many requests')), false);
assert.equal(isGoldDropDailyOtpLimit(new Error('fetch failed')), false);
for (const status of [200, 400]) {
  const limited = new GoldDropClient({ fetchImpl: async () => new Response(JSON.stringify({ statusCode: 400, message: limitMessage }), { status }) });
  limited.userKey = 'u'; limited.dataKey = key;
  await assert.rejects(limited.register({ name: 'Rahul Kumar', mobile: '9876543210', email: 'x@example.com', pincode: '509412', code: 'KKD2LS01261026', image: Buffer.from('photo') }), isGoldDropDailyOtpLimit);
}
console.log('Gold Drop client and reward tests passed');
