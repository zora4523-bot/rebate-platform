import { expect, it, vi } from 'vitest';
import {
  createGovernedAdapter,
  type UnionIdentity,
} from '../../../../apps/api/src/modules/union/index.ts';
import { adapter, endpoint, quota, ManualScheduler } from '../../union/skeleton/kit.ts';
import { outcome, type Query } from './kit.ts';
import { ctx, queryOf, TestIdentity } from './port-kit.ts';

it('[AC-B1-06v#27] 有查询方法才包治理层，保留 this 与身份并注入治理上下文；缺方法仍缺省', async () => {
  const query = vi.fn<Query>(async function (this: { platform: string }, identity, context) {
    expect(this.platform).toBe('pdd');
    expect(identity).toBeInstanceOf(TestIdentity);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    return { authorized: false };
  });
  const scheduler = new ManualScheduler();
  const options = { endpoint: endpoint('pdd'), scheduler, quota: quota('account:pdd') };
  const raw = { ...adapter('pdd'), queryPddAuthority: query };
  const port = createGovernedAdapter(raw, options);
  const governed = queryOf(port);
  const identity = new TestIdentity();
  expect(await outcome(() => governed(identity, { ...ctx, scenario: 'pdd_unauthorized' }))).toEqual(
    { authorized: false },
  );
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(
    identity,
    expect.objectContaining({
      ...ctx,
      baseUrl: options.endpoint.baseUrl,
      headers: { 'X-Scenario': 'pdd_unauthorized' },
    }),
  );
  expect(
    Reflect.get(createGovernedAdapter(adapter('pdd'), options), 'queryPddAuthority'),
  ).toBeUndefined();
  expect(scheduler.pending).toBe(0);
});

it.each(['plain', 'forged', 'foreign_app', 'foreign_platform'] as const)(
  '[AC-B1-06v#28] 治理查询拒绝 %s 身份，不能触达适配器与配额',
  async (kind) => {
    const query = vi.fn<Query>(async () => ({ authorized: true }));
    const limiter = { bucketKey: 'account:pdd', tryAcquire: vi.fn(() => true) };
    const raw = { ...adapter('pdd'), queryPddAuthority: query };
    const port = createGovernedAdapter(raw, {
      endpoint: endpoint('pdd'),
      scheduler: new ManualScheduler(),
      quota: limiter,
    });
    const governed = queryOf(port);
    const good = new TestIdentity();
    const identity: unknown =
      kind === 'plain'
        ? { claims: good.claims }
        : kind === 'forged'
          ? Object.assign(Object.create(TestIdentity.prototype) as object, { claims: good.claims })
          : new TestIdentity(kind === 'foreign_app' ? { appId: 'other_app' } : { platform: 'jd' });
    expect(await outcome(() => governed(identity as UnionIdentity, ctx))).toMatchObject({
      thrown: { code: 'invalid_identity' },
    });
    expect(query).not.toHaveBeenCalled();
    expect(limiter.tryAcquire).not.toHaveBeenCalled();
  },
);

it('[AC-B1-06v#29] 授权查询按幂等读失败后重试，第三次恢复可返回 authorized', async () => {
  const scheduler = new ManualScheduler();
  const query = vi
    .fn<Query>()
    .mockRejectedValueOnce(new Error('synthetic-outage-1'))
    .mockRejectedValueOnce(new Error('synthetic-outage-2'))
    .mockResolvedValue({ authorized: true });
  const limiter = { bucketKey: 'account:pdd', tryAcquire: vi.fn(() => true) };
  const raw = { ...adapter('pdd'), queryPddAuthority: query };
  const port = createGovernedAdapter(raw, {
    endpoint: endpoint('pdd'),
    scheduler,
    quota: limiter,
  });
  const governed = queryOf(port);
  const result = outcome(() => governed(new TestIdentity(), ctx));
  await scheduler.advance(10_000);
  expect(await result).toEqual({ authorized: true });
  expect(query).toHaveBeenCalledTimes(3);
  expect(limiter.tryAcquire).toHaveBeenCalledTimes(3);
  expect(scheduler.pending).toBe(0);
});
