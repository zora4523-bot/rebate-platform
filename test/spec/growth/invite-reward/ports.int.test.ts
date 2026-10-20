import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { api, fixture, growth, openDatabase, QUALIFIED, EXPIRES, type Database } from './kit.ts';
type Identity = typeof import('../../../../apps/api/src/modules/identity/ports/invite-reward.ts');
type Orders = typeof import('../../../../apps/api/src/modules/orders/ports/invite-reward.ts');

let database: Database;
beforeAll(async () => {
  database = await openDatabase();
}, 180_000);
afterAll(async () => {
  await database?.close();
});

it('[AC-B1-35#90] 登录 IP 端口按 app/user 和绑定前左闭右开窗口，返回 host 规范文本', async () => {
  const f = await fixture(database);
  const port = (
    await api<Identity>('identity/ports/invite-reward.ts')
  ).createInviteRewardLoginIpsReader();
  for (const [app, user, at, ip] of [
    [f.appId, f.inviter, '2026-10-19T02:00:00Z', '2001:0db8::1/64'],
    [f.appId, f.inviter, '2026-10-19T02:00:00Z', '2001:db8::1'],
    [f.appId, f.inviter, '2026-10-19T01:59:59.999Z', '192.0.2.1'],
    [f.appId, f.inviter, QUALIFIED, '192.0.2.2'],
    [f.appId, f.invitee, '2026-10-19T03:00:00Z', '192.0.2.3'],
  ] as const) {
    await f.db
      .insertInto('login_logs')
      .values({
        app_id: app,
        user_id: user,
        created_at: new Date(at),
        ip,
        method: 'sms',
        device_id_hash: 'a'.repeat(64),
      })
      .execute();
  }
  const before = await f.db
    .selectFrom('login_logs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
  await f.db.transaction().execute(async (trx) => {
    expect(
      await port.read(trx, {
        app_id: f.appId,
        user_id: f.inviter,
        from: new Date('2026-10-19T02:00:00Z'),
        to: new Date(QUALIFIED),
      }),
    ).toEqual(['2001:db8::1']);
    expect(
      await port.read(trx, {
        app_id: `other_${f.appId}`,
        user_id: f.inviter,
        from: new Date('2026-10-19T02:00:00Z'),
        to: new Date(QUALIFIED),
      }),
    ).toEqual([]);
  });
  expect(
    await f.db
      .selectFrom('login_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  ).toEqual(before);
});

it.each(['account_deleted', 'phone_changed'])(
  '[AC-B1-35#91] 留存 reason=%s 命中当前手机、expire_at 严格大于现在',
  async (reason) => {
    const f = await fixture(database);
    const port = (
      await api<Identity>('identity/ports/invite-reward.ts')
    ).createInviteRewardDeletedPhoneReader();
    const user = await f.db
      .selectFrom('users')
      .select('phone_hmac')
      .where('app_id', '=', f.appId)
      .where('id', '=', f.invitee)
      .executeTakeFirstOrThrow();
    await f.db
      .insertInto('deleted_identities')
      .values({
        app_id: f.appId,
        reason,
        phone_hmac: user.phone_hmac,
        deleted_at: new Date('2026-10-01T00:00:00Z'),
        expire_at: new Date(QUALIFIED),
      })
      .execute();
    await f.db.transaction().execute(async (trx) => {
      expect(
        await port.retained(trx, {
          app_id: f.appId,
          user_id: f.invitee,
          at: new Date('2026-10-20T01:59:59.999Z'),
        }),
      ).toBe(true);
      expect(
        await port.retained(trx, {
          app_id: f.appId,
          user_id: f.invitee,
          at: new Date(QUALIFIED),
        }),
      ).toBe(false);
      expect(
        await port.retained(trx, {
          app_id: `other_${f.appId}`,
          user_id: f.invitee,
          at: new Date('2026-10-19T00:00:00Z'),
        }),
      ).toBe(false);
      expect(
        await port.retained(trx, {
          app_id: f.appId,
          user_id: f.inviter,
          at: new Date('2026-10-19T00:00:00Z'),
        }),
      ).toBe(false);
    });
  },
);

it('[AC-B1-35#92] 订单事实端口读取 attr_at 与退款/维权事实，窗口仅 self 且左右边界准确', async () => {
  const f = await fixture(database);
  const port = (await api<Orders>('orders/ports/invite-reward.ts')).createInviteRewardOrderFacts();
  const facts = await Promise.all([
    f.order({ attr_at: new Date(QUALIFIED) }),
    f.order({ attr_at: new Date('2026-11-19T01:59:59.999Z') }),
    f.order({ attr_at: new Date(EXPIRES) }),
    f.order({ attr_at: new Date('2026-10-20T01:59:59.999Z') }),
    f.order({ buy_type: 'share' }),
    f.order({ user_id: f.inviter }),
  ]);
  for (const fact of facts) {
    const key = await f.db
      .selectFrom('order_keys')
      .select('sub_order_id')
      .where('app_id', '=', f.appId)
      .where('order_id', '=', fact.order_id)
      .executeTakeFirstOrThrow();
    await f.db
      .insertInto('orders')
      .values({
        app_id: f.appId,
        order_id: fact.order_id,
        platform: 'taobao',
        sub_order_id: key.sub_order_id,
        raw_item_id: 'fixture',
        user_id: fact.user_id,
        buy_type: fact.buy_type,
        attr_at: fact.attr_at,
        credited_at: fact.credited_at,
        rebate_status: fact.rebate_status,
        platform_status: 'SETTLED',
        base_fen: fact.base_fen,
        pay_amount_fen: fact.pay_amount_fen,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 0,
        // Deliberately different: expiry must never use these timestamps.
        paid_at: new Date('2026-12-01T00:00:00Z'),
        created_at: new Date('2026-12-01T00:00:00Z'),
      })
      .execute();
  }
  const first = facts[0]!;
  await f.db
    .insertInto('order_rights')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      order_id: first.order_id,
      source: 'union',
      type: 'RIGHTS',
      status: 'FAILED',
      occurred_at: new Date(QUALIFIED),
    })
    .execute();
  await f.db.transaction().execute(async (trx) => {
    expect(await port.read(trx, { app_id: f.appId, order_id: first.order_id })).toMatchObject({
      app_id: f.appId,
      user_id: f.invitee,
      attr_at: new Date(QUALIFIED),
      base_fen: 320n,
      pay_amount_fen: 4990n,
      rebate_status: 'CREDITED',
      buy_type: 'self',
      refunded_quantity: 1,
      refunded_quantity_at_credit: 0,
      rights_pending: false,
      has_rights: true,
    });
    expect(
      await port.read(trx, { app_id: `other_${f.appId}`, order_id: first.order_id }),
    ).toBeNull();
    const window = await port.listSelfOrdersInWindow(trx, {
      app_id: f.appId,
      user_id: f.invitee,
      from: new Date(QUALIFIED),
      to: new Date(EXPIRES),
    });
    expect(window.map((o) => o.order_id).sort()).toEqual(
      [facts[0]!.order_id, facts[1]!.order_id].sort(),
    );
    expect(
      await port.listSelfOrdersInWindow(trx, {
        app_id: `other_${f.appId}`,
        user_id: f.invitee,
        from: new Date(QUALIFIED),
        to: new Date(EXPIRES),
      }),
    ).toEqual([]);
  });
});

it('[AC-B1-35#93] 可用额端口数据库错误原样抛出，不能当作可用预算', async () => {
  const f = await fixture(database);
  const fault = new Error('fixture database read failed');
  const db = f.db.withPlugin({
    transformQuery() {
      throw fault;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const reader = (await growth()).createInviteRewardBudgetReader({
    ...f.deps,
    db,
    config: { configValue: async () => ({ value: 100000, version: 1 }) },
  });
  await expect(reader.available(f.appId)).rejects.toBe(fault);
});
