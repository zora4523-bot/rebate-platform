// B1-15g (brief §9.2 #3 ① 「手机号与 user_oauth 留到 ③」; 08 BR-ID-27 细则「processing 中途用同一微信登录 →
// 10007（data.stage=processing），不会因 user_oauth 已删而新建账号」; §9.3 item 3): after the cleanup
// and before done the WeChat binding is still there, so a WeChat login through the real app
// (B1-02d's kit: only the third-party exchange is a double) answers 403/10007 processing and writes
// nothing.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  LOGIN,
  closeOauthKit,
  fixture,
  loginBody,
  openOauthKit,
  rejected,
  rows,
  type OauthKit,
} from '../oauth-login/kit.ts';
import { controls, ports, request, seedRequest } from './kit.ts';

let kit: OauthKit;
beforeAll(async () => {
  kit = await openOauthKit('stub');
}, 180_000);
afterAll(async () => {
  await closeOauthKit(kit);
});

it('[AC-B1-15g#32][BR-ID-27] 清理后、done 前用同一微信登录 → 403/10007 stage=processing：user_oauth 仍在，不新建账号、库不变', async () => {
  const f = await fixture(kit);
  const bound = await f.account('wechat', 'deleting');
  const m = { appId: f.appId, uid: bound.uid, phoneHmac: null };
  const row = await seedRequest(kit.suite.db, m);
  const c = await controls(kit.suite.db, f.crypto, await ports());
  c.setAdjustment(m, 'pending');
  await c.runner().runOnce();
  expect((await request(kit.suite.db, row.id)).cleaned_at).not.toBeNull();
  kit.exchange.mockResolvedValue({ union_id: bound.unionId });
  const attempt = await f.device.attempt('wechat');
  const before = await rows(f);
  expect(before.oauth.filter((binding) => binding.user_id === bound.uid)).toHaveLength(1);
  rejected(
    kit,
    LOGIN.wechat,
    await f.device.post(LOGIN.wechat, loginBody('wechat', attempt.attempt_id)),
    10007,
    { stage: 'processing' },
  );
  expect(await rows(f)).toEqual(before);
});
