import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  LOGIN,
  MASKED_NAME,
  NAME,
  NOW,
  PATH,
  ROOT,
  account,
  change,
  close,
  config,
  envelope,
  fixture,
  open,
  privateDataAbsent,
  state,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
beforeEach(() => {
  kit.clock.set(NOW);
  kit.lines.length = 0;
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
});

it('[AC-B1-13e#20] GET 去 planned、realname 鉴权且真实 AppModule 可达；PUT 保持 planned', async () => {
  const operation = kit.document.paths[PATH]!;
  expect(operation['get']!['x-implementation']).not.toBe('planned');
  expect(operation['get']!['x-auth']).toBe('realname');
  // B1-13k: B1-13f implemented savePayoutAccount, so PUT is judged by its implementation state:
  // while planned it must stay unmounted (404); once implemented it must be mounted on the real
  // AppModule, where a request without any device header stops at stage ① (10402), not 404.
  const putPlanned = operation['put']!['x-implementation'] === 'planned';
  const routes = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
  expect(Object.hasOwn(routes.CONTRACT_ROUTE_SCHEMAS, 'savePayoutAccount')).toBe(!putPlanned);
  const f = await fixture(kit);
  expect(envelope(kit, await f.get())).toEqual({});
  const put = await kit.app.inject({ method: 'PUT', url: PATH, headers: {} });
  if (putPlanned) expect(put.statusCode).toBe(404);
  else {
    expect(put.statusCode, put.body).toBe(401);
    expect(put.json()).toMatchObject({ code: 10402, trace_id: expect.any(String) });
  }
});

it('[AC-B1-13e#21] 无当前行返回空对象，旧历史行和其他用户账号不得被当成当前绑定', async () => {
  const f = await fixture(kit);
  const other = await fixture(kit, { appId: f.appId });
  await account(kit, f, LOGIN, { current: false });
  await account(kit, other, 'other@example.com');
  const before = await state(kit, f);
  expect(envelope(kit, await f.get())).toEqual({});
  expect(await state(kit, f)).toEqual(before);
});

it.each([
  ['13812345678', '138****5678'],
  ['zhangsan@example.com', 'zh***@example.com'],
  ['ab@x.com', 'a***@x.com'],
  ['a@x.com', '***@x.com'],
])(
  '[AC-B1-13e#22] 支付宝 GET 脱敏向量 %#，响应只含契约字段且日志不含敏感信息',
  async (value, masked) => {
    const f = await fixture(kit);
    const row = await account(kit, f, value);
    await account(kit, f, 'obsolete@example.com', { current: false });
    await change(kit, f);
    const before = await state(kit, f);
    kit.lines.length = 0;
    const response = await f.get();
    expect(envelope(kit, response)).toEqual({
      payout_method: 'alipay',
      masked_account: masked,
      masked_payee_name: MASKED_NAME,
      change_remaining_this_month: 1,
    });
    privateDataAbsent(
      kit,
      [response.json()],
      [
        value,
        NAME,
        row.alipay_hmac!,
        row.alipay_logon_id_cipher!.toString('utf8'),
        'obsolete@example.com',
      ],
    );
    expect(await state(kit, f)).toEqual(before);
  },
);

it('[AC-B1-13e#23] 银行卡 GET 仅尾号、银行名和脱敏姓名，不下发卡 BIN、完整卡号或摘要', async () => {
  const f = await fixture(kit);
  const value = '6222021234567890123';
  const row = await account(kit, f, value, { method: 'bank_card' });
  const response = await f.get();
  expect(envelope(kit, response)).toEqual({
    payout_method: 'bank_card',
    masked_account: '尾号 0123',
    bank_name: '招商银行',
    masked_payee_name: MASKED_NAME,
    change_remaining_this_month: 2,
  });
  privateDataAbsent(
    kit,
    [response.json()],
    [NAME, value, row.card_bin!, row.bank_card_hmac!, row.bank_card_no_cipher!.toString('utf8')],
  );
});

it('[AC-B1-13e#24] 剩余次数使用注入 Clock 的 +08:00 自然月，起点包含、终点排除且限定用户和 App', async () => {
  const f = await fixture(kit);
  await account(kit, f);
  await config(kit, f, 'withdraw.payout_account_change_per_month', 3);
  const otherUser = await fixture(kit, { appId: f.appId });
  const otherApp = await fixture(kit);
  await change(kit, otherUser);
  await change(kit, otherUser);
  await change(kit, otherApp);
  await change(kit, otherApp);
  await change(kit, f, new Date('2026-09-30T15:59:59.999Z'));
  await change(kit, f, new Date('2026-09-30T16:00:00.000Z'));
  await change(kit, f, new Date('2026-10-31T15:59:59.999Z'));
  await change(kit, f, new Date('2026-10-31T16:00:00.000Z'));
  kit.clock.set('2026-10-31T15:59:59.999Z');
  expect(envelope(kit, await f.get())).toMatchObject({ change_remaining_this_month: 1 });
  kit.clock.set('2026-10-31T16:00:00.000Z');
  expect(envelope(kit, await f.get())).toMatchObject({ change_remaining_this_month: 2 });
  expect((await state(kit, f)).changes).toHaveLength(4);
});

it('[AC-B1-13e#25] 历史次数超现配置上限时剩余钳为零；关闭方式不影响展示当前绑定', async () => {
  const f = await fixture(kit);
  await account(kit, f);
  await config(kit, f, 'withdraw.payout_methods', ['bank_card']);
  await config(kit, f, 'withdraw.payout_account_change_per_month', 1);
  await change(kit, f);
  await change(kit, f);
  expect(envelope(kit, await f.get())).toMatchObject({
    payout_method: 'alipay',
    change_remaining_this_month: 0,
  });
  expect((await state(kit, f)).changes).toHaveLength(2);
});

it('[AC-B1-13e#26] GET 未实名 30304、未登录 10001、h5_token 10403；合法实名 App 可读', async () => {
  const f = await fixture(kit);
  const unverified = await fixture(kit, { verified: false });
  // Positive control keeps this a route test even if pre-routing guards already existed.
  expect(envelope(kit, await f.get())).toEqual({});
  envelope(kit, await unverified.get(), 30304);
  envelope(kit, await f.get('guest'), 10001);
  envelope(kit, await f.get('h5'), 10403);
});

it('[AC-B1-13e#27] 保存结果与 GET 投影一致，首绑和换绑之后都按持久化状态返回', async () => {
  const { save } = await import('./kit.ts');
  const f = await fixture(kit);
  const first = await save(kit, f);
  expect(first.code).toBe(0);
  expect(envelope(kit, await f.get())).toEqual('data' in first ? first.data : undefined);
  const second = await save(kit, f, { alipayLogonId: '13812345678' });
  expect(second.code).toBe(0);
  expect(envelope(kit, await f.get())).toEqual('data' in second ? second.data : undefined);
});
