// B1-06zd rule tests: one prefetch job on a real database (D10-510, BR-ATTR-13 ②). The job reads
// only the link's identity_snapshot (user, pid, pid_scene, relation_id) and checks that user's
// current active binding before converting; not one identity is taken from the job or from the
// current slot. The write fills links.promo_url and promo_url_fetched_at while promo_url is NULL
// and nothing else: row_version stays (an open's CAS is never interrupted), expired links stay
// empty, at-least-once delivery changes nothing. Failure keeps NULL, with at most one queue retry.
import { createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { COUPON_CLICK_URL, SHORT_URL, promotion, relationId } from './kit.ts';
import {
  NOW,
  RAW_ITEM,
  deliver,
  expectOnlyPromoChanged,
  jobFixture,
  jobOf,
  type JobFixture,
} from './job-kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);

afterAll(async () => {
  try {
    await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

/** A link of a user whose active binding matches its snapshot: the job's normal case. */
async function normal(f: JobFixture) {
  const { userId, relation } = await f.bound();
  const linkId = await f.link({ userId, relationId: relation });
  return { userId, relation, linkId, before: await f.row(linkId) };
}

it.each([
  { pidScene: 'self_buy' as const, pid: 'mm_1001_2002_3003' },
  { pidScene: 'agent' as const, pid: 'mm_1001_2002_5005' },
])(
  '[AC-B1-06zd#23] $pidScene：按快照的推广位与 relation_id 转链（配额用途 pool_refresh），promo_url 取 coupon_click_url、时间取注入时钟，只改这两列',
  async ({ pidScene, pid }) => {
    const f = await jobFixture(db);
    const { userId, relation } = await f.bound();
    const linkId = await f.link({ userId, relationId: relation, pid, pidScene });
    const before = await f.row(linkId);

    await f.run(linkId);

    expect(f.conversions()).toEqual([
      {
        parameters: { goodsId: RAW_ITEM, pid, channelId: relation },
        appId: f.appId,
        purpose: 'pool_refresh',
      },
    ]);
    const after = await f.row(linkId);
    expect(after.promo_url).toBe(COUPON_CLICK_URL);
    expect(after.promo_url_fetched_at).toEqual(new Date(NOW));
    expectOnlyPromoChanged(before, after);
  },
);

it('[AC-B1-06zd#24] 没有 coupon_click_url 取 short_url', async () => {
  const f = await jobFixture(db);
  const { linkId, before } = await normal(f);
  f.answer(() => promotion({ coupon: null }));

  await f.run(linkId);

  const after = await f.row(linkId);
  expect(after.promo_url).toBe(SHORT_URL);
  expectOnlyPromoChanged(before, after);
});

it('[AC-B1-06zd#25] url 校验同 promoOf：恰好 2048 字符的 https 可写', async () => {
  const f = await jobFixture(db);
  const { linkId } = await normal(f);
  const url = 'https://s.click.example.test/t?e='.padEnd(2048, 'a');
  f.answer(() => promotion({ short: url, coupon: url }));

  await f.run(linkId);

  expect((await f.row(linkId)).promo_url).toBe(url);
});

it.each([
  { label: 'http', url: 'http://s.click.example.test/t?e=plain' },
  { label: '超过 2048 字符', url: `https://s.click.example.test/t?e=${'a'.repeat(2048)}` },
  { label: '不是绝对地址', url: '//s.click.example.test/t?e=relative' },
])('[AC-B1-06zd#26] 链接不合格（$label）：不写，保持 NULL', async ({ url }) => {
  const f = await jobFixture(db);
  const { linkId, before } = await normal(f);
  f.answer(() => promotion({ short: url, coupon: url }));

  await deliver(f.handler(), jobOf(f.appId, linkId));

  expect(await f.row(linkId)).toEqual(before);
});

it('[AC-B1-06zd#27] 转链答复百川形态（没有推广链接）：不写，保持 NULL', async () => {
  const f = await jobFixture(db);
  const { linkId, before } = await normal(f);
  f.answer(() => ({
    kind: 'baichuan',
    item: { platform: 'taobao', item_id: RAW_ITEM },
    promotionSlot: 'mm_1001_2002_3003',
    relationId: 'synthetic-relation',
  }));

  await deliver(f.handler(), jobOf(f.appId, linkId));

  expect(await f.row(linkId)).toEqual(before);
});

it.each([
  { label: '当前 active 绑定换了 relation_id', status: 'active', relation: 'other' },
  { label: '绑定已失效', status: 'invalid', relation: 'same' },
  { label: '绑定已解除', status: 'released', relation: 'same' },
  { label: '绑定被封禁', status: 'blocked', relation: 'same' },
  { label: '没有绑定', status: null, relation: 'same' },
])('[AC-B1-06zd#28] $label：放弃，不调转链、不写', async ({ status, relation }) => {
  const f = await jobFixture(db);
  const userId = await f.user();
  const snapshotRelation = relationId();
  if (status !== null) {
    await f.bind(userId, relation === 'same' ? snapshotRelation : relationId(), status);
  }
  const linkId = await f.link({ userId, relationId: snapshotRelation });
  const before = await f.row(linkId);

  await f.run(linkId);

  expect(f.conversions()).toEqual([]);
  expect(await f.row(linkId)).toEqual(before);
});

it.each([
  { label: '快照没有 relation_id', patch: { relation_id: null } },
  { label: '快照没有推广位', patch: { pid: null } },
  { label: '快照没有用户', patch: { user_id: null } },
  { label: '快照的场景与 link 不一致', patch: { pid_scene: 'share' } },
  { label: '快照的平台与 link 不一致', patch: { platform: 'jd' } },
])('[AC-B1-06zd#29] $label：放弃，不调转链、不写', async ({ patch }) => {
  const f = await jobFixture(db);
  const { userId, relation } = await f.bound();
  const linkId = await f.link({ userId, relationId: relation, snapshot: patch });
  const before = await f.row(linkId);

  await f.run(linkId);

  expect(f.conversions()).toEqual([]);
  expect(await f.row(linkId)).toEqual(before);
});

it('[AC-B1-06zd#30] 不跨用户：快照的用户不是 link 的用户时放弃，哪怕快照用户有 active 绑定', async () => {
  const f = await jobFixture(db);
  const owner = await f.bound();
  const other = await f.bound();
  const linkId = await f.link({
    userId: owner.userId,
    relationId: other.relation,
    snapshot: { user_id: other.userId },
  });
  const before = await f.row(linkId);

  await f.run(linkId);

  expect(f.conversions()).toEqual([]);
  expect(await f.row(linkId)).toEqual(before);
});

it('[AC-B1-06zd#31] 不是淘宝的 link 不转链', async () => {
  const f = await jobFixture(db);
  const { userId, relation } = await f.bound();
  const linkId = await f.link({ userId, relationId: relation, platform: 'jd' });
  const before = await f.row(linkId);

  await f.run(linkId);

  expect(f.conversions()).toEqual([]);
  expect(await f.row(linkId)).toEqual(before);
});

it('[AC-B1-06zd#32] 不跨推广位：用快照的推广位，不换成当前 active 的另一个', async () => {
  const f = await jobFixture(db);
  const { userId, relation } = await f.bound();
  const linkId = await f.link({ userId, relationId: relation, pid: 'mm_1001_2002_3003' });
  await db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      platform: 'taobao',
      union_account_id: f.account,
      site_id: 'synthetic-self-buy-site',
      pid: 'mm_7007_8008_9009',
      pid_scene: 'self_buy',
      status: 'active',
      hjy_ignore_confirmed_at: NOW,
      hjy_ignore_evidence_path: 'https://example.test/synthetic-evidence',
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();

  await f.run(linkId);

  expect(f.conversions().map((call) => call.parameters['pid'])).toEqual(['mm_1001_2002_3003']);
});

it('[AC-B1-06zd#33] 至少一次投递：同一任务再来一次不改已写的值', async () => {
  const f = await jobFixture(db);
  const { linkId } = await normal(f);
  await f.run(linkId);
  const first = await f.row(linkId);
  expect(first.promo_url).toBe(COUPON_CLICK_URL);
  f.answer(() => promotion({ coupon: 'https://uland.example.test/coupon/edetail?e=second' }));
  f.clock.set('2026-10-30T02:00:30.000Z');

  await f.run(linkId, 2);

  expect(await f.row(linkId)).toEqual(first);
});

it('[AC-B1-06zd#34] 两个任务同时跑：都正常结束，只留一个值', async () => {
  const f = await jobFixture(db);
  const { linkId, before } = await normal(f);
  let count = 0;
  const urls: string[] = [];
  f.answer(() => {
    count += 1;
    const url = `${COUPON_CLICK_URL}&n=${String(count)}`;
    urls.push(url);
    return promotion({ coupon: url });
  });

  await Promise.all([f.run(linkId), f.run(linkId)]);

  const after = await f.row(linkId);
  expect(urls).toContain(after.promo_url);
  expectOnlyPromoChanged(before, after);
});

it('[AC-B1-06zd#35] 分享已写过 promo_url 的 link：任务不改它', async () => {
  const f = await jobFixture(db);
  const { userId, relation } = await f.bound();
  const linkId = await f.link({
    userId,
    relationId: relation,
    promoUrl: 'https://s.click.example.test/t?e=written',
  });
  const before = await f.row(linkId);

  await f.run(linkId);

  expect(await f.row(linkId)).toEqual(before);
});

it('[AC-B1-06zd#36] BR-ATTR-13 ②：link 已过 expire_at 不写', async () => {
  const f = await jobFixture(db);
  const { userId, relation } = await f.bound();
  const linkId = await f.link({
    userId,
    relationId: relation,
    expireAt: '2026-10-30T01:59:59.999Z',
  });
  const before = await f.row(linkId);

  await f.run(linkId);

  expect(await f.row(linkId)).toEqual(before);
});

it('[AC-B1-06zd#37] 转链途中过了 expire_at：不写', async () => {
  const f = await jobFixture(db);
  const { linkId, before } = await normal(f);
  f.answer(
    () => promotion(),
    () => {
      f.clock.set('2026-10-30T02:15:00.001Z');
      return Promise.resolve();
    },
  );

  await f.run(linkId);

  expect(await f.row(linkId)).toEqual(before);
});

it('[AC-B1-06zd#38] 不动 row_version：转链期间打开改了 row_version，任务照写，也不再加一', async () => {
  const f = await jobFixture(db);
  const { linkId } = await normal(f);
  f.answer(
    () => promotion(),
    async () => {
      await db.updateTable('links').set({ row_version: 1 }).where('link_id', '=', linkId).execute();
    },
  );

  await f.run(linkId);

  expect(await f.row(linkId)).toMatchObject({ promo_url: COUPON_CLICK_URL, row_version: 1 });
});

it('[AC-B1-06zd#39] 跨 App：任务的 app_id 与 link 的 App 不同 → 不转链、不写', async () => {
  const owner = await jobFixture(db);
  const { linkId, before } = await normal(owner);
  const stranger = await jobFixture(db);
  await stranger.bound();

  await stranger.handler()({
    id: randomUUID(),
    queue: 'pool-refresh',
    name: 'linking.promo_prefetch',
    payload: jobOf(stranger.appId, linkId),
    attempt: 1,
  });

  expect(stranger.conversions()).toEqual([]);
  expect(owner.conversions()).toEqual([]);
  expect(await owner.row(linkId)).toEqual(before);
});

it.each([
  { label: '空 payload', payload: {} },
  { label: '没有 link_id', payload: { app_id: 'synthetic-app' } },
  { label: 'link_id 不是 uuid', payload: { app_id: 'synthetic-app', link_id: 'not-a-uuid' } },
  { label: 'link 不存在', payload: { app_id: 'synthetic-app', link_id: randomUUID() } },
])('[AC-B1-06zd#40] $label：不转链', async ({ payload }) => {
  const f = await jobFixture(db);

  await deliver(f.handler(), payload);

  expect(f.conversions()).toEqual([]);
});

it.each([
  { label: '联盟暂时失败', error: new UnionError('upstream_unavailable', 'synthetic', 'taobao') },
  { label: '联盟拒绝', error: new UnionError('upstream_rejected', 'synthetic', 'taobao') },
  { label: '默认数据源', error: new UnionError('adapter_unimplemented', 'synthetic', 'taobao') },
  { label: '配额用尽', error: new GovernanceError('quota_exceeded', 'union.taobao', 'synthetic') },
])(
  '[AC-B1-06zd#41] 失败（$label）：保持 NULL，队列重试不超过 1 次，日志不带 relation_id 与链接',
  async ({ error }) => {
    const f = await jobFixture(db);
    const { linkId, before, relation } = await normal(f);
    f.failConversion(error);

    const attempts = await deliver(f.handler(), jobOf(f.appId, linkId));

    expect(attempts).toBeLessThanOrEqual(2);
    expect(f.conversions().length).toBeGreaterThan(0);
    expect(f.conversions().length).toBeLessThanOrEqual(2);
    expect(await f.row(linkId)).toEqual(before);
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain(relation);
  },
);
