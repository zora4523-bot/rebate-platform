// B1-15g (brief §9.2 #3 ① 「手机号与 user_oauth 留到 ③」; 08 BR-ID-27 「status=deleting 的账号用任何方式
// 登录都返回 10007（data.stage=processing），不得新建账号」; §9.3 item 3): after the cleanup and before
// done (closing adjustment still pending) the account keeps its phone_hmac, so an SMS login with the
// same phone still meets it: 10007 with data.stage=processing, no account created, nothing written.
// The SMS login service is B1-02's own (test/spec/identity/sms-login/kit.ts), on its database.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, fixture, openKit, rows, type Kit as SmsKit } from '../sms-login/kit.ts';
import { TOMBSTONE_NICKNAME, controls, ports, request, seedRequest, userRow } from './kit.ts';

let sms: SmsKit;
beforeAll(async () => {
  sms = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(sms);
});

it('[AC-B1-15g#31][BR-ID-27] 清理后、done 前用同一手机号短信登录 → 10007 stage=processing：phone_hmac 仍在，不建号、不签发、库不变', async () => {
  const f = await fixture(sms);
  const uid = await f.account('deleting');
  const seeded = await userRow(sms.db, { appId: f.appId, uid });
  const m = { appId: f.appId, uid, phoneHmac: seeded.phone_hmac };
  expect(m.phoneHmac).not.toBeNull();
  const row = await seedRequest(sms.db, m);
  const c = await controls(sms.db, sms.crypto, await ports());
  c.setAdjustment(m, 'pending');
  await c.runner().runOnce();
  expect((await request(sms.db, row.id)).cleaned_at).not.toBeNull();
  expect(await userRow(sms.db, m)).toMatchObject({
    status: 'deleting',
    phone_hmac: m.phoneHmac,
    nickname: TOMBSTONE_NICKNAME,
  });
  const before = await rows(sms, f.appId);
  const result = await f.login();
  expect(result).toEqual({ code: 10007, data: { stage: 'processing' } });
  expect(f.register).not.toHaveBeenCalled();
  expect(await rows(sms, f.appId)).toEqual(before);
});
