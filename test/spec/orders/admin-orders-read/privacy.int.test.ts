import { randomInt, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import {
  UNATTRIBUTED,
  audit,
  detail,
  history,
  linkLogs,
  order,
  page,
  pending,
  rejected,
  setup,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-10i#43] 列表与详情手机号只下发 3+4 脱敏串，没有手机号为 null，响应与日志不含明文', async () => {
  const s = await setup(h);
  // Generate a synthetic phone in memory; no plaintext phone fixture is stored in the repository.
  const phone = `139${String(randomInt(100_000_000)).padStart(8, '0')}`;
  const masked = `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  await h.db
    .updateTable('users')
    .set({
      phone_cipher: Buffer.from(h.fields.encrypt(phone, 'users.phone')),
      phone_hmac: h.fields.blindIndex(phone, 'users.phone'),
    })
    .where('app_id', '=', s.appId)
    .where('id', '=', s.userId)
    .execute();
  const o = await order(s);
  const without = await order(s, { user_id: await seedUser(h.db, s.appId) });
  const p = await page(await s.get());
  expect(p.items.find((i) => i.order_id === o.order_id)?.user).toEqual({
    user_id: s.userId,
    phone_masked: masked,
  });
  expect(p.items.find((i) => i.order_id === without.order_id)?.user?.phone_masked).toBeNull();
  const d = await detail(await s.get({}, o.order_id));
  expect(d.user).toEqual({ user_id: s.userId, phone_masked: masked });
  expect((await detail(await s.get({}, without.order_id))).user?.phone_masked).toBeNull();
  const exposed = JSON.stringify([p, d, s.f.lines]);
  expect(exposed.includes(phone)).toBe(false);
  expect(exposed).not.toMatch(/"(?:phone_cipher|phone_hmac|phone)"\s*:/);
});

it('[AC-B1-10i#44] 不下发原始报文与归因内部字段（pid、relation_id、custom_params、商品与店铺明细）', async () => {
  const s = await setup(h);
  const linkId = randomUUID();
  const secrets = {
    pid: `pid-secret-${randomUUID()}`,
    relation_id: `relation-secret-${randomUUID()}`,
    sub_union_id: `union-secret-${randomUUID()}`,
    custom_params: `params-secret-${randomUUID()}`,
    shop_id: `shop-secret-${randomUUID()}`,
  };
  const o = await order(s, { ...secrets, link_id: linkId, raw_payload_id: 987654321n });
  const linked = {
    pid: `link-pid-secret-${randomUUID()}`,
    product_key: `jd:link-product-secret-${randomUUID()}`,
    shop_id: `link-shop-secret-${randomUUID()}`,
    spm: `spm-secret-${randomUUID()}`,
  };
  await linkLogs(s, linkId, [linked]);
  const p = await page(await s.get());
  const d = await detail(await s.get({}, o.order_id));
  expect(d.link_logs).toEqual([
    { at: '2026-10-05T01:00:00.000Z', event: 'open', scene: 'detail' },
  ]);
  const exposed = JSON.stringify([p, d, s.f.lines]);
  for (const value of [...Object.values(secrets), ...Object.values(linked)]) {
    expect(exposed.includes(value), value).toBe(false);
  }
  expect(JSON.stringify([p, d])).not.toMatch(
    /"(?:raw_payload|raw_payload_id|union_raw_payloads|pid|relation_id|custom_params|shop_id)"\s*:/,
  );
});

it('[AC-B1-10i#45] 重复读取列表与详情不写订单、历史、待处理、快照或审计；无效动态码头被忽略', async () => {
  const s = await setup(h);
  const o = await order(s, { hold: true, hold_reason: 'UNMAPPED_STATUS' });
  await order(s, UNATTRIBUTED);
  await pending(s, o);
  await history(s, o.order_id, [
    {
      field: 'platform',
      from_status: null,
      to_status: 'PAID',
      event: 'P2',
      source: 'sync',
      at: '2026-10-06T02:58:40.000Z',
    },
  ]);
  await audit(s, {
    adminId: s.a.id,
    orderId: o.order_id,
    at: '2026-10-05T01:00:00.000Z',
    note: '早先的人工暂停',
  });
  const before = await s.snapshot();
  const headers = { 'x-step-up-token': 'unused-invalid' };
  for (let n = 0; n < 2; n += 1) {
    expect((await page(await s.get({}, undefined, headers))).total).toBe(2);
    expect((await detail(await s.get({}, o.order_id, headers))).order_id).toBe(o.order_id);
    expect((await page(await s.get({ user_id: s.userId, q: o.sub_order_id }))).total).toBe(1);
  }
  expect(await s.snapshot()).toEqual(before);
});

it('[AC-B1-10i#46] 被拒绝的读取同样不新增审计记录', async () => {
  const s = await setup(h, { grants: ['user.lookup'] });
  const o = await order(s);
  const before = await s.snapshot();
  const denied = { reason: 'admin_permission_denied' };
  await rejected(await s.get(), 10403, denied);
  await rejected(await s.get({}, o.order_id), 10403, denied);
  await rejected(await s.get({ user_id: s.userId, q: '' }), 20001, { fields: ['q'] });
  expect(await s.snapshot()).toEqual(before);
});
