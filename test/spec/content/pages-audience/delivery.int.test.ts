// F1-09g §9.2–9.3: real AppModule + HTTP, with isolated apps and contract-validated replies.
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../../identity/request-context/db-kit.ts';
import { harness, session, type Harness } from '../config/kit.ts';
import {
  audiencePage,
  binding,
  hasEquality,
  order,
  queryProbe,
  SECTIONS_WITHOUT_PARENT,
  visible,
} from './kit.ts';

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: ReturnType<typeof createDb>;
let h: Harness;
beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  redis = await testing.acquireTestRedis();
  h = await harness(db, database.urlFor('couli_app'), redis.url);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

const BASE = ['public', 'any', 'login_yes'];
const UNAUTHORIZED = [...BASE, 'union_authorized_no', 'has_order_no'];
// F1-09k (test-change): every case except #8 seeds the page without has_parent yes / no sections,
// so its logged-in expectations hold both while has_parent is unknown (F1-09g, G3) and after
// F1-09j wires the real parent relation (pages-audience-parent/** covers that judgement).
const page = () => audiencePage(h, SECTIONS_WITHOUT_PARENT);

it('[AC-F1-09g#3] 游客三事实为 false 且不查事实，同设备登录后按令牌用户判定', async () => {
  const subject = await page();
  await binding(h, subject, 'taobao', 'active');
  await order(h, subject, 'PAID', 'ESTIMATED');
  const probe = queryProbe();
  const app = await h.start('api', db.withPlugin(probe.plugin));
  // F1-09k (test-change): has_parent_no left the seed, so it leaves the guest list; the guest
  // has_parent judgement stays asserted in #8.
  const guest = ['public', 'any', 'login_no', 'union_authorized_no', 'has_order_no'];
  expect(await visible(app, subject, true)).toEqual(guest);
  expect(probe.queries).toHaveLength(0);
  expect(await visible(app, subject)).toEqual([
    ...BASE,
    'union_authorized_yes',
    'has_order_yes',
    'both',
  ]);
  probe.queries.length = 0;
  expect(await visible(app, subject, true)).toEqual(guest);
  expect(probe.queries).toHaveLength(0);
});

it.each(['taobao', 'pdd'] as const)(
  '[AC-F1-09g#4] 仅 %s active 即已授权，另一平台 pending_auth 不阻止命中',
  async (platform) => {
    const subject = await page();
    await binding(h, subject, platform, 'active');
    await binding(h, subject, platform === 'taobao' ? 'pdd' : 'taobao', 'pending_auth');
    expect(await visible(h.app, subject)).toEqual([
      ...BASE,
      'union_authorized_yes',
      'has_order_no',
    ]);
  },
);

it.each(['taobao', 'pdd'] as const)(
  '[AC-F1-09g#5] %s 的缺失绑定及全部非 active 状态均不算已授权',
  async (platform) => {
    for (const status of [
      null,
      'unbound',
      'pending_auth',
      'invalid',
      'released',
      'blocked',
    ] as const) {
      const subject = await page();
      if (status !== null) await binding(h, subject, platform, status);
      expect.soft(await visible(h.app, subject), String(status)).toEqual(UNAUTHORIZED);
    }
  },
);

it.each([
  ['DEPOSIT_PAID', 'ESTIMATED'],
  ['PAID', 'ESTIMATED'],
  ['RECEIVED', 'WAITING'],
  ['SETTLED', 'CREDITED'],
  ['INVALID', 'VOID'],
  ['INVALID', 'CLAWED_BACK'],
  ['PAID', 'UNATTRIBUTED'],
] as const)('[AC-F1-09g#6] 本人仅有一笔 %s / %s 订单仍算有订单', async (platform, rebate) => {
  const subject = await page();
  await order(h, subject, platform, rebate);
  expect(await visible(h.app, subject)).toEqual([...BASE, 'union_authorized_no', 'has_order_yes']);
});

it('[AC-F1-09g#7] 同设备不同用户和其他应用的事实不串用，查询同时限定 app_id 与 user_id', async () => {
  const subject = await page();
  const another = await session(h, subject.id, subject.device);
  const otherUser = {
    ...subject,
    userId: another.user.id,
    headers: { ...subject.guest, ...another.headers },
  };
  const otherApp = await page();
  for (const owner of [otherUser, otherApp]) {
    await binding(h, owner, 'pdd', 'active');
    await order(h, owner, 'SETTLED', 'CREDITED');
  }
  const probe = queryProbe();
  const app = await h.start('api', db.withPlugin(probe.plugin));
  for (const [person, expected] of [
    [subject, UNAUTHORIZED],
    [otherUser, [...BASE, 'union_authorized_yes', 'has_order_yes', 'both']],
    [subject, UNAUTHORIZED],
    [otherApp, [...BASE, 'union_authorized_yes', 'has_order_yes', 'both']],
  ] as const) {
    probe.queries.length = 0;
    expect(await visible(app, person)).toEqual(expected);
    expect(probe.queries.length).toBeGreaterThan(0);
    for (const { node } of probe.queries) {
      expect(node.kind).toBe('SelectQueryNode');
      if (node.kind === 'SelectQueryNode') {
        expect(hasEquality(node.where, 'app_id', person.id)).toBe(true);
        expect(hasEquality(node.where, 'user_id', person.userId)).toBe(true);
      }
    }
    // Multiple sections must not re-read facts: one orderCount and at most one binding per platform.
    expect(probe.queries.filter((query) => query.table === 'orders')).toHaveLength(1);
    expect(
      probe.queries.filter((query) => query.table === 'union_bindings').length,
    ).toBeLessThanOrEqual(2);
  }
});

// F1-09k (test-change): the logged-in has_parent result changes when F1-09j wires the parent
// relation (unknown now, real afterwards; covered by pages-audience-parent/**), so only the
// has_parent_* sections are left out of the logged-in comparison and the title drops that half.
// The guest assertion is unchanged: a guest's has_parent is false under both implementations.
it('[AC-F1-09g#8] 游客 has_parent no 下发；登录用户有无 parent_id 不影响其他条件', async () => {
  for (const withParent of [false, true]) {
    const subject = await audiencePage(h);
    if (withParent) {
      const parent = await seedUser(db, subject.id);
      await db
        .withSchema('app')
        .updateTable('users')
        .set({
          parent_id: parent.id,
          parent_bind_source: 'register',
          parent_bound_at: h.deps.clock.now(),
        })
        .where('app_id', '=', subject.id)
        .where('id', '=', subject.userId)
        .execute();
    }
    const loggedIn = await visible(h.app, subject);
    expect
      .soft(loggedIn.filter((id) => !String(id).startsWith('has_parent_')))
      .toEqual(UNAUTHORIZED);
    expect
      .soft(await visible(h.app, subject, true))
      .toEqual([
        'public',
        'any',
        'login_no',
        'has_parent_no',
        'union_authorized_no',
        'has_order_no',
      ]);
  }
});

it('[AC-F1-09g#9] 页面缓存期内授权和订单变化立即生效，过滤结果不跨请求缓存', async () => {
  const subject = await page();
  const bindingId = await binding(h, subject, 'pdd', 'pending_auth');
  const before = h.deps.clock.now().getTime();
  expect(await visible(h.app, subject)).toEqual(UNAUTHORIZED);
  await db
    .withSchema('app')
    .updateTable('union_bindings')
    .set({
      status: 'active',
      relation_id: 'audience-active',
      bound_at: h.deps.clock.now(),
    })
    .where('app_id', '=', subject.id)
    .where('id', '=', bindingId)
    .execute();
  expect(await visible(h.app, subject)).toEqual([...BASE, 'union_authorized_yes', 'has_order_no']);
  await order(h, subject, 'INVALID', 'VOID');
  expect(await visible(h.app, subject)).toEqual([
    ...BASE,
    'union_authorized_yes',
    'has_order_yes',
    'both',
  ]);
  await db
    .withSchema('app')
    .updateTable('union_bindings')
    .set({ status: 'invalid' })
    .where('app_id', '=', subject.id)
    .where('id', '=', bindingId)
    .execute();
  expect(await visible(h.app, subject)).toEqual([...BASE, 'union_authorized_no', 'has_order_yes']);
  expect(h.deps.clock.now().getTime()).toBe(before);
});

it.each(['orders', 'union_bindings'] as const)(
  '[AC-F1-09g#10] %s 读取失败只使该事实未知，其他事实仍过滤，返回 200 并 warn',
  async (failing) => {
    const subject = await page();
    await binding(h, subject, 'taobao', 'active');
    await order(h, subject, 'PAID', 'ESTIMATED');
    const probe = queryProbe(failing);
    const app = await h.start('api', db.withPlugin(probe.plugin));
    const logStart = h.logs.length;
    expect(await visible(app, subject)).toEqual([
      ...BASE,
      failing === 'orders' ? 'union_authorized_yes' : 'has_order_yes',
    ]);
    expect(probe.queries.some((query) => query.table === failing)).toBe(true);
    expect(
      h.logs.slice(logStart).some((line) => (JSON.parse(line) as { level: number }).level === 40),
    ).toBe(true);
    // A failure must not be cached either: the same handle recovers on the next request.
    probe.control.failing = null;
    expect(await visible(app, subject)).toEqual([
      ...BASE,
      'union_authorized_yes',
      'has_order_yes',
      'both',
    ]);
  },
);
