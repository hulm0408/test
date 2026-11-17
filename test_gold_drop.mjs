import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { GoldDropClient, signGoldDropPayload, unwrapGoldDropResponse } from './gold-drop-client.js';

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
console.log('Gold Drop client tests passed');
