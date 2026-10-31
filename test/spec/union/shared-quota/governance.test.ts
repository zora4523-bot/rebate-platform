// B1-22v: QuotaLimiter.tryAcquire may answer asynchronously (the shared Redis bucket). The
// governor (platform/http) awaits the answer before every attempt; a refusal or a rejected answer
// ends the call with quota_exceeded — the operation is not invoked, the breaker records nothing,
// nothing is retried. The union governance layer, the B1-04w per-request gate and the order-sync
// governed adapter keep their results; the memory limiter keeps its synchronous semantics.
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  GovernanceError,
  RedisUnavailableError,
  createGovernor,
  createMemoryQuotaLimiter,
  createRedisQuotaLimiter,
  quotaShares,
  unionPolicy,
  type QuotaLimiter,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  createGovernedSyncAdapter,
  type CallCtx,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  ManualScheduler,
  Upstream,
  ending,
  flush,
  observe,
  runCalls,
  tally,
} from '../../platform/http/kit.ts';
import { memoryLogger } from '../../platform/redis/kit.ts';
import { ctx as orderSyncCtx, win } from '../pdd-orders/kit.ts';
import { govern, pageReply, wireSetup } from '../pdd-orders-quota/kit.ts';
import { adapter, endpoint, online, window as syncWindow } from '../skeleton/kit.ts';
import { T0, WARN, fakeNamespace, unavailableWarnings } from './kit.ts';

/** A promise that rejects with `error` and is already handled (no unhandled-rejection noise). */
function rejected(error: Error): Promise<boolean> {
  const promise = Promise.reject(error);
  promise.catch(() => undefined);
  return promise;
}

it('[B1-22v] Governor 等待异步配额：答 false 即 quota_exceeded，不调用对方、不计入熔断、每次调用只取一次', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const take = vi.fn<QuotaLimiter['tryAcquire']>(async () => false);
  const governor = createGovernor('union.jd', unionPolicy('online'), {
    scheduler,
    quota: { bucketKey: 'account:jd', tryAcquire: take },
  });
  const endings = await runCalls(governor, 45, upstream.ok('never reached'), {
    kind: 'idempotent_read',
    purpose: 'online',
  });
  expect({
    endings: tally(endings),
    invoked: upstream.calledAt.length,
    takes: take.mock.calls.length,
    breaker: governor.breakerState(),
  }).toEqual({ endings: { quota_exceeded: 45 }, invoked: 0, takes: 45, breaker: 'closed' });
});

it('[B1-22v][R-04] 配额答复被拒（Redis 不可用）：调用方得到 GovernanceError quota_exceeded，不是原错误；不调用对方、不重试、不计入熔断', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() =>
    rejected(new RedisUnavailableError('command_timeout')),
  );
  const governor = createGovernor('union.jd', unionPolicy('offline'), {
    scheduler,
    quota: { bucketKey: 'account:jd', tryAcquire: take },
  });
  const read = { kind: 'idempotent_read', purpose: 'order_sync' } as const;
  const first = observe(governor.call(upstream.ok('never reached'), read));
  await flush();
  const rest = await runCalls(governor, 44, upstream.ok('never reached'), read);
  const error = first.error;
  expect({
    first: ending(first),
    governance: error instanceof GovernanceError,
    dependency: error instanceof GovernanceError ? error.dependency : null,
    rest: tally(rest),
    invoked: upstream.calledAt.length,
    takes: take.mock.calls.length,
    breaker: governor.breakerState(),
  }).toEqual({
    first: 'quota_exceeded',
    governance: true,
    dependency: 'union.jd',
    rest: { quota_exceeded: 44 },
    invoked: 0,
    takes: 45,
    breaker: 'closed',
  });
});

it('[B1-22v] 令牌答复到达前不调用对方：异步配额放行后才发出那一次尝试', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const answers: ((granted: boolean) => void)[] = [];
  const take = vi.fn<QuotaLimiter['tryAcquire']>(
    () =>
      new Promise<boolean>((resolve) => {
        answers.push(resolve);
      }),
  );
  const governor = createGovernor('union.pdd', unionPolicy('online'), {
    scheduler,
    quota: { bucketKey: 'account:pdd', tryAcquire: take },
  });
  const call = observe(
    governor.call(upstream.ok('answered'), { kind: 'write', purpose: 'online' }),
  );
  await flush();
  const before = { invoked: upstream.calledAt.length, settled: call.settled };
  answers[0]?.(true);
  await flush();
  expect({
    before,
    takes: take.mock.calls.length,
    after: { invoked: upstream.calledAt.length, ending: ending(call), value: call.value },
  }).toEqual({
    before: { invoked: 0, settled: 'pending' },
    takes: 1,
    after: { invoked: 1, ending: 'resolved', value: 'answered' },
  });
});

/** quota.test.ts's ten-token scenario, with the limiter answering directly or through a promise. */
async function tenTokenScenario(asynchronous: boolean) {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const memory = createMemoryQuotaLimiter(
    {
      bucketKey: 'union:jd:acct-1',
      capacity: 10,
      refillPerSecond: 0.000001,
      shares: { online: 0, order_sync: 100, pool_refresh: 0, watch: 0 },
    },
    scheduler,
  );
  const quota: QuotaLimiter = asynchronous
    ? { bucketKey: memory.bucketKey, tryAcquire: async (purpose) => memory.tryAcquire(purpose) }
    : memory;
  const governor = createGovernor('union.jd', unionPolicy('offline'), { scheduler, quota });
  const read = { kind: 'idempotent_read', purpose: 'order_sync' } as const;
  const firstThree = [0, 1, 2].map(() => observe(governor.call(upstream.down(), read)));
  await scheduler.advance(5000);
  const fourth = observe(governor.call(upstream.down(), read));
  await scheduler.advance(5000);
  const fifth = observe(governor.call(upstream.ok('never reached'), read));
  await scheduler.advance(5000);
  return {
    firstThree: tally(firstThree.map((observed) => ending(observed))),
    fourth: ending(fourth),
    fifth: ending(fifth),
    invoked: upstream.calledAt.length,
  };
}

it('[B1-22v] 内存版语义不变且仍同步作答；同一桶经异步答复时 Governor 每次尝试照样取 1 个令牌（重试也取）', async () => {
  const memory = createMemoryQuotaLimiter({
    bucketKey: 'union:jd:acct-2',
    capacity: 100,
    refillPerSecond: 10,
    shares: quotaShares('mvp'),
  });
  const answer = memory.tryAcquire('online');
  const expected = {
    firstThree: {
      'error: upstream down #7': 1,
      'error: upstream down #8': 1,
      'error: upstream down #9': 1,
    },
    fourth: 'quota_exceeded',
    fifth: 'quota_exceeded',
    invoked: 10,
  };
  expect({
    synchronousAnswer: typeof answer,
    direct: await tenTokenScenario(false),
    throughPromise: await tenTokenScenario(true),
  }).toEqual({ synchronousAnswer: 'boolean', direct: expected, throughPromise: expected });
});

it('[B1-22v][R-04] 联盟治理层接共享桶：Redis 不可用时在线调用以 quota_exceeded 结束，原始适配器一次也不调用，并记 warn', async () => {
  const raw = adapter('jd');
  const resolveLink = vi.spyOn(raw, 'resolveLink');
  const { namespace, eval: script } = fakeNamespace(() =>
    Promise.reject(new RedisUnavailableError('connect_failed', 'ECONNREFUSED')),
  );
  const { logger, lines } = memoryLogger();
  const quota = createRedisQuotaLimiter(
    { bucketKey: 'account:jd', capacity: 100, refillPerSecond: 10, shares: quotaShares('mvp') },
    { redis: namespace, clock: new FixedClock(T0), logger },
  );
  const governed = createGovernedAdapter(raw, {
    endpoint: endpoint('jd'),
    scheduler: new ManualScheduler(),
    quota,
  });
  const error = await governed.resolveLink('https://item.jd.com/100012345678.html', online).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect({
    governance: error instanceof GovernanceError,
    code: error instanceof GovernanceError ? error.code : error,
    invoked: resolveLink.mock.calls.length,
    scripts: script.mock.calls.length,
    warned: unavailableWarnings(lines).some(
      (line) => line.level === WARN && line['purpose'] === 'online',
    ),
  }).toEqual({ governance: true, code: 'quota_exceeded', invoked: 0, scripts: 1, warned: true });
});

it('[B1-22v][R-04] 订单同步的治理适配器接共享桶：Redis 不可用时 listOrders 以 quota_exceeded 结束，离线熔断保持关闭', async () => {
  const raw = adapter('jd');
  const listOrders = vi.spyOn(raw, 'listOrders');
  const { namespace } = fakeNamespace(() =>
    Promise.reject(new RedisUnavailableError('command_timeout')),
  );
  const quota = createRedisQuotaLimiter(
    { bucketKey: 'account:jd', capacity: 100, refillPerSecond: 10, shares: quotaShares('mvp') },
    { redis: namespace, clock: new FixedClock(T0), logger: memoryLogger('worker').logger },
  );
  const sync = createGovernedSyncAdapter(raw, {
    endpoint: endpoint('jd'),
    scheduler: new ManualScheduler(),
    quota,
  });
  const ctx: CallCtx = { appId: 'app-a', requestId: 'req-sync', purpose: 'order_sync' };
  const codes: unknown[] = [];
  for (let call = 0; call < 25; call += 1) {
    codes.push(
      await sync.adapter.listOrders(syncWindow, {}, ctx).then(
        () => 'resolved',
        (reason: unknown) => (reason instanceof GovernanceError ? reason.code : reason),
      ),
    );
  }
  expect({
    codes: [...new Set(codes)],
    invoked: listOrders.mock.calls.length,
    breaker: sync.offlineBreakerState(),
  }).toEqual({ codes: ['quota_exceeded'], invoked: 0, breaker: 'closed' });
});

it.each([1, 2, 3])(
  '[B1-22v][B1-04w] 逐个上游请求取异步令牌：配额只够 %i 次时恰好发送该次数，中途拒绝即 quota_exceeded、不重试',
  async (budget) => {
    let remaining = budget;
    const { adapter: pdd, transport } = wireSetup((body) => pageReply(body));
    const take = vi.fn<QuotaLimiter['tryAcquire']>(async () => remaining-- > 0);
    const outcome = await govern(pdd, take)
      .listOrders(win, {}, orderSyncCtx)
      .then(
        () => 'resolved',
        (reason: unknown) => (reason instanceof GovernanceError ? reason.code : reason),
      );
    expect({
      outcome,
      sent: transport.mock.calls.length,
      takes: take.mock.calls.length,
    }).toEqual({ outcome: 'quota_exceeded', sent: budget, takes: budget + 1 });
  },
);
