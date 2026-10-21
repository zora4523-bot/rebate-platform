import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { fixture, open, resolved, success, type Harness } from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

it.each(['approve', 'reject'] as const)(
  '[AC-B1-10k#15] %s 审计或事件入队之后失败，整个事务回滚，重试只落一次',
  async (mode) => {
    for (const point of ['audit', 'event']) {
      const f = await fixture(h);
      const o = await f.order();
      const c = await f.claim();
      const i = await f.item(c, o);
      const other = await f.claim({ user_id: await f.user() });
      await f.item(other, o);
      const before = await f.state();
      const outage = new Error(`synthetic ${point} failure`);
      const overrides =
        point === 'audit'
          ? {
              auditOn: (trx: Parameters<typeof f.deps.auditOn>[0]) => ({
                append: async (
                  input: Parameters<ReturnType<typeof f.deps.auditOn>['append']>[0],
                ) => {
                  await f.deps.auditOn(trx).append(input);
                  throw outage;
                },
              }),
            }
          : {
              events: {
                publish: async (...args: Parameters<typeof f.deps.events.publish>) => {
                  await f.deps.events.publish(...args);
                  throw outage;
                },
              },
            };
      await expect(f.review(mode, i, {}, overrides)).rejects.toBe(outage);
      expect(await f.state()).toEqual(before);
      expect(success(await f.review(mode, i)).status).toBe(
        mode === 'approve' ? 'approved' : 'rejected',
      );
      const settled =
        mode === 'approve'
          ? [
              { claim_id: c.id, user_id: c.user_id, status: 'approved' },
              { claim_id: other.id, user_id: other.user_id, status: 'rejected' },
            ]
          : [{ claim_id: c.id, user_id: c.user_id, status: 'rejected' }];
      await resolved(f, settled);
      const committed = await f.state();
      expect(await f.review(mode, i)).toEqual({ code: 20902, data: { resource: 'claim_item' } });
      expect(await f.state()).toEqual(committed);
    }
  },
);

it('[AC-B1-10k#16] 事务内事件可见，独立连接提交前不可见；审计与各端口共用审核事务', async () => {
  const f = await fixture(h);
  const c = await f.claim();
  const i = await f.item(c, await f.order());
  const before = await f.state();
  let observed = false;
  const publish = vi.fn<typeof f.deps.events.publish>(async (trx, event) => {
    const answer = await f.deps.events.publish(trx, event);
    const inside = await f.state(trx);
    expect(inside.items.find((r) => r.id === i.id)?.decision).toBe('approved');
    expect(inside.claims.find((r) => r.id === c.id)?.status).toBe('approved');
    expect(inside.events).toHaveLength(1);
    expect(inside.jobs).toHaveLength(1);
    expect(await f.state()).toEqual(before);
    observed = true;
    return answer;
  });
  expect(success(await f.review('approve', i, {}, { events: { publish } })).status).toBe(
    'approved',
  );
  expect(observed).toBe(true);
  expect(new Set(f.transactions).size).toBe(1);
  expect((await f.state()).audits).toHaveLength(1);
  await resolved(f, [{ claim_id: c.id, user_id: c.user_id, status: 'approved' }]);
});

it.each(['rebate', 'snapshot'] as const)(
  '[AC-B1-10k#17] 通过的 %s 端口失败不能留下半笔审核',
  async (point) => {
    const f = await fixture(h);
    const c = await f.claim();
    const i = await f.item(c, await f.order());
    const before = await f.state();
    const outage = new Error(`synthetic ${point} outage`);
    const overrides =
      point === 'rebate'
        ? {
            rebate: {
              onClaimApproved: async (
                ...args: Parameters<typeof f.deps.rebate.onClaimApproved>
              ) => {
                await f.deps.rebate.onClaimApproved(...args);
                throw outage;
              },
            },
          }
        : {
            snapshots: {
              create: async () => {
                throw outage;
              },
            },
          };
    await expect(f.review('approve', i, {}, overrides)).rejects.toBe(outage);
    expect(await f.state()).toEqual(before);
  },
);

it('[AC-B1-10k#18] 未注入分佣端口仍经 settlement 处理，snapshot=none', async () => {
  const f = await fixture(h);
  const c = await f.claim();
  const i = await f.item(c, await f.order());
  const { snapshots, ...deps } = f.deps;
  void snapshots;
  // Do not install a production fallback; this test only exercises the documented optional port.
  const { approveClaimItem } =
    await import('../../../../apps/api/src/modules/orders/application/claim-review.ts');
  expect(
    success(
      await approveClaimItem(deps, f.actor, {
        claimId: c.id,
        itemId: i.id,
        expected_row_version: i.row_version,
        reason: '确认缺省端口行为',
      }),
    ).status,
  ).toBe('approved');
  expect(f.snapshots.create).not.toHaveBeenCalled();
  expect(f.rebate.onClaimApproved.mock.calls[0]?.[1].snapshot).toBe('none');
});

it('[AC-B1-10k#19] 找回通过调用来源回填，写入匹配来源；失败时归属、审核、来源全部回滚', async () => {
  const f = await fixture(h);
  const c = await f.claim();
  const link = await f.link('jd:i_12345');
  const o = await f.order({ source_match: null, source_scene: null, link_id: null });
  const i = await f.item(c, o);
  const before = await f.state();
  const outage = new Error('synthetic source read outage');
  let fail = true;
  const sources = {
    productKey: vi.fn(async () => o.product_key),
    linkLogs: vi.fn(async () => {
      if (fail) throw outage;
      return [
        {
          id: 7n,
          link_id: link,
          user_id: c.user_id,
          platform: o.platform,
          event: 'open',
          result_code: 0,
          pid_scene: 'detail',
          scene: 'detail',
          product_key: o.product_key,
          shop_id: null,
          created_at: o.attr_at,
          agent_session_id: null,
        },
      ];
    }),
  };
  const overrides = { sources, pidScene: async () => 'detail' };
  await expect(f.review('approve', i, {}, overrides)).rejects.toBe(outage);
  expect(await f.state()).toEqual(before);
  fail = false;
  expect(success(await f.review('approve', i, {}, overrides)).status).toBe('approved');
  expect(sources.linkLogs).toHaveBeenLastCalledWith(
    expect.objectContaining({
      appId: f.appId,
      userId: c.user_id,
      platform: 'jd',
      to: o.attr_at,
    }),
  );
  expect((await f.state()).orders[0]).toMatchObject({
    source_match: 'product',
    source_scene: 'detail',
    link_id: link,
    agent_session_id: null,
  });
});
