import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { needsTaobaoReauth } from '../../../../apps/api/src/modules/linking/index.ts';
import { createRiskStateMessageHandler } from '../../../../apps/api/src/modules/notification/application/risk-state-message.ts';
import { fixture, openSuite, type Suite } from './db-kit.ts';
import { QUEUE } from './fixtures.ts';
import { assembled } from './worker-kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function binding(f: Fixture, platform: string, status: string) {
  const accountId = randomUUID();
  await f.db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: f.appId,
      platform,
      account_name: 'fixture-account',
      status: 'active',
      auth_status: 'active',
    })
    .execute();
  return f.db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: f.userId,
      platform,
      union_account_id: accountId,
      relation_id: randomUUID(),
      status,
      bound_at: f.clock.now(),
      released_at: status === 'released' ? f.clock.now() : null,
      cooldown_until: status === 'released' ? f.clock.now() : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

const bindingCases = [
  {
    platform: 'taobao',
    status: 'invalid',
    needed: true,
    body: '你的账号限制已解除。购物前需重新完成淘宝授权。',
  },
  { platform: 'taobao', status: 'active', needed: false, body: '你的账号限制已解除。' },
  { platform: 'taobao', status: null, needed: false, body: '你的账号限制已解除。' },
  { platform: 'pdd', status: 'invalid', needed: false, body: '你的账号限制已解除。' },
  { platform: 'taobao', status: 'pending_auth', needed: false, body: '你的账号限制已解除。' },
  { platform: 'taobao', status: 'blocked', needed: false, body: '你的账号限制已解除。' },
  { platform: 'taobao', status: 'unbound', needed: false, body: '你的账号限制已解除。' },
  { platform: 'taobao', status: 'released', needed: false, body: '你的账号限制已解除。' },
] as const;

it.each(bindingCases)(
  '[AC-B1-12g#32] linking 只读口：$platform / $status，仅 invalid 淘宝绑定需授权',
  async (row) => {
    const f = await fixture(suite);
    if (row.status !== null) await binding(f, row.platform, row.status);
    const start = suite.queries.length;
    await f.db.transaction().execute(async (trx) => {
      // PostgreSQL rejects even an attempted UPDATE of zero rows in this transaction.
      await sql`set transaction read only`.execute(trx);
      expect(await needsTaobaoReauth(trx, { appId: f.appId, userId: f.userId })).toBe(row.needed);
    });
    const reads = suite.queries.slice(start).filter((query) => query.includes('union_bindings'));
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every((query) => !/InsertQueryNode|UpdateQueryNode|DeleteQueryNode/.test(query)),
    ).toBe(true);
  },
);

it.each(bindingCases)(
  '[AC-B1-12g#33] 解封消费注入 linking 实际只读口：$platform / $status',
  async (row) => {
    const f = await fixture(suite);
    const before = row.status === null ? null : await binding(f, row.platform, row.status);
    const reader = vi.fn(needsTaobaoReauth);
    const handler = createRiskStateMessageHandler({ clock: f.clock, taobaoReauthReader: reader });
    const received = f.event({ from: 'banned', to: 'normal', reason_category: null });
    const start = suite.queries.length;
    await f.db.transaction().execute(async (trx) => {
      await handler(received, trx);
      expect(reader).toHaveBeenCalledWith(trx, { appId: f.appId, userId: f.userId });
    });
    expect(suite.queries.slice(start).some((query) => query.includes('user_risk_state'))).toBe(
      false,
    );
    const rows = await f.rows();
    expect(rows.inbox).toMatchObject([
      { user_id: f.userId, title: '账户通知', body: row.body, route: null },
    ]);
    expect(rows.logs).toMatchObject([
      { channel: 'inbox', status: 'success', dedupe_key: `risk.state_changed:${received.eventId}` },
    ]);
    expect(
      await f.db.selectFrom('union_bindings').selectAll().where('app_id', '=', f.appId).execute(),
    ).toEqual(before === null ? [] : [before]);
  },
);

it('[AC-B1-12g#34] 不串用其他用户或其他 app 的 invalid 淘宝绑定', async () => {
  const f = await fixture(suite);
  const other = await fixture(suite);
  await binding(other, 'taobao', 'invalid');
  // A user UUID is globally unique: query the existing user under the wrong app to isolate app_id.
  await f.db.transaction().execute(async (trx) => {
    expect(await needsTaobaoReauth(trx, { appId: f.appId, userId: other.userId })).toBe(false);
  });
  const user = await f.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', f.userId)
    .executeTakeFirstOrThrow();
  const otherUserId = randomUUID();
  await f.db
    .insertInto('users')
    .values({ ...user, id: otherUserId, invite_code: randomUUID(), attr_code: randomUUID() })
    .execute();
  await binding({ ...f, userId: otherUserId }, 'taobao', 'invalid');
  await f.deliver(f.event({ from: 'banned', to: 'normal', reason_category: null }));
  expect((await f.rows()).inbox).toMatchObject([
    { user_id: f.userId, body: '你的账号限制已解除。' },
  ]);
});

it.each([
  ['invalid', '解封通知：购物前需重新完成淘宝授权。再次提醒：购物前需重新完成淘宝授权。'],
  ['active', '解封通知：再次提醒：'],
] as const)(
  '[AC-B1-12g#35] 真实 worker 以消费时淘宝 %s 状态替换覆盖正文的 need_reauth',
  async (status, body) => {
    const f = await fixture(suite);
    const received = f.event({ from: 'banned', to: 'normal', reason_category: null });
    // Bindings are populated after the event snapshot: this is a consumption-time read.
    await binding(f, 'taobao', status);
    await f.template('unbanned', {
      title_override: '解封通知',
      body_override: '解封通知：{need_reauth}再次提醒：{need_reauth}',
    });
    const app = await assembled('worker', f.db, f.clock);
    try {
      const matches = app.registrations.filter((registration) => registration.name === QUEUE);
      expect(matches).toHaveLength(1);
      await matches[0]!.handler({
        id: received.eventId,
        queue: QUEUE,
        name: received.name,
        attempt: 1,
        payload: {
          app_id: received.appId,
          v: received.version,
          occurred_at: received.occurredAt,
          data: received.payload,
        },
      });
      expect((await f.rows()).inbox).toMatchObject([{ title: '解封通知', body, route: null }]);
      expect((await f.rows()).logs).toMatchObject([{ channel: 'inbox', status: 'success' }]);
      expect(app.sends).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
