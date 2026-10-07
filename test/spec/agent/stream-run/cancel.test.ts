// B3-03b cancel: POST /v1/agent/runs/{run_id}/cancel may land on another stream instance, so the
// signal goes through the Redis run registry (get / set only) and is polled every signalPollMs
// (规划/02 §9.2 「取消与断线」, 05 B3-03; BR-AI-15: a user cancel still counts). Not the owner, unknown
// or finished runs answer not_found (the wiring answers 30505). Redis is an in-memory get/set fake.
import { expect, it } from 'vitest';
import {
  createRedisRunRegistry,
  createRunManager,
  type RunConfig,
  type RunContext,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  FakeAdmission,
  FakeCards,
  FakeGuard,
  FakeRedis,
  IDS,
  ManualTime,
  fixtureCardFrame,
  framesOf,
  never,
  flush,
  rig,
  texts,
  unnumbered,
} from './kit.ts';

const CONFIG: RunConfig = {
  maxRunMs: 60_000,
  heartbeatMs: 15_000,
  disconnectGraceMs: 30_000,
  guardPollMs: 5_000,
  signalPollMs: 500,
};
const RUN = { runId: IDS.run, sessionId: IDS.session, ownerKey: 'u:u-demo-1' };

it.each([3_600, 120])(
  '[02 §9.2] Redis run 登记 ttlSeconds=%i：两个实例共用一个命名空间，A 登记、B 取消，A 看得到取消；每次 set 都带 ttlSeconds',
  async (ttl) => {
    const redis = new FakeRedis();
    const time = new ManualTime();
    const a = createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: ttl });
    const b = createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: ttl });
    await a.register({ ...RUN });
    expect(await a.cancelRequested(IDS.run)).toBe(false);
    expect(await b.requestCancel(IDS.run, 'u:someone-else')).toBe('not_found');
    expect(await b.requestCancel(IDS.run, 'd:u-demo-1')).toBe('not_found');
    expect(await a.cancelRequested(IDS.run)).toBe(false);
    expect(await b.requestCancel(IDS.run, 'u:u-demo-1')).toBe('ok');
    expect(await a.cancelRequested(IDS.run)).toBe(true);
    expect(redis.ttls.length).toBeGreaterThan(0);
    expect(redis.ttls.every((x) => x === ttl)).toBe(true);
  },
);

it.each([3_600, 120])(
  '[02 §9.2][BR-AI-23] Redis run 登记 ttlSeconds=%i：不存在的 run 取消为 not_found；finish 后取消为 not_found，另一实例 final 取回同一终止帧',
  async (ttl) => {
    const redis = new FakeRedis();
    const time = new ManualTime();
    const a = createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: ttl });
    const b = createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: ttl });
    expect(await b.requestCancel('019a0000-0000-7000-8000-00000000ffff', 'u:u-demo-1')).toBe(
      'not_found',
    );
    expect(await b.cancelRequested('019a0000-0000-7000-8000-00000000ffff')).toBe(false);
    expect(await b.final(IDS.run)).toBeNull();
    await a.register({ ...RUN });
    await a.finish(IDS.run, { event: 'done', data: { finish_reason: 'stop', quota_left: 4 } });
    expect(await b.requestCancel(IDS.run, 'u:u-demo-1')).toBe('not_found');
    expect(await b.final(IDS.run)).toEqual({
      event: 'done',
      data: { finish_reason: 'stop', quota_left: 4 },
    });
    expect(redis.ttls.every((x) => x === ttl)).toBe(true);
  },
);

it.each([500, 2_000])(
  '[02 §9.2][BR-AI-15] 取消 signalPollMs=%i：另一实例的 RunManager 取消，signalPollMs 内 signal 中止（reason cancelled），写 done cancelled，结局 cancelled',
  async (poll) => {
    const redis = new FakeRedis();
    const time = new ManualTime();
    const config = { ...CONFIG, signalPollMs: poll };
    const r = rig({
      config,
      time,
      registry: createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: 3_600 }),
    });
    const other = createRunManager({
      admission: new FakeAdmission([], 0),
      registry: createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: 3_600 }),
      cards: new FakeCards([]),
      texts,
      guard: new FakeGuard(),
      clock: time.clock,
      scheduler: time.scheduler,
      config,
    });
    let ctx: RunContext | undefined;
    const p = r.manager.start(r.start, async (c) => {
      ctx = c;
      await c.card(unnumbered(fixtureCardFrame('product_list')));
      return never();
    });
    await time.to(1_000);
    expect(await other.cancel(IDS.run, 'u:someone-else')).toBe('not_found');
    expect(await other.cancel(IDS.run, 'u:u-demo-1')).toBe('ok');
    await time.to(1_000 + poll);
    expect(ctx?.signal.reason).toBe('cancelled');
    expect(await time.drive(p, 1_000 + poll)).toBe(true);
    expect(framesOf(r.sink.chunks).slice(-1)[0]?.data).toEqual({
      finish_reason: 'cancelled',
      quota_left: 17,
    });
    expect(r.admission.calls.map((x) => x.outcome)).toEqual([
      { ending: 'cancelled', cardsDelivered: 1 },
    ]);
    expect((await p).ending).toBe('cancelled');
    expect(await other.cancel(IDS.run, 'u:u-demo-1')).toBe('not_found');
  },
);

it.each([500, 2_000])(
  '[02 §9.2][BR-AI-15] 取消 signalPollMs=%i：本实例取消同样在 signalPollMs 内结束，结束后再取消为 not_found',
  async (poll) => {
    const r = rig({ config: { ...CONFIG, signalPollMs: poll } });
    let ctx: RunContext | undefined;
    const p = r.manager.start(r.start, async (c) => {
      ctx = c;
      return never();
    });
    await r.time.to(1_000);
    expect(await r.manager.cancel(IDS.run, 'u:u-demo-1')).toBe('ok');
    await r.time.to(1_000 + poll);
    expect(ctx?.signal.reason).toBe('cancelled');
    expect((await p).ending).toBe('cancelled');
    expect(await r.manager.cancel(IDS.run, 'u:u-demo-1')).toBe('not_found');
    expect(await r.manager.cancel('019a0000-0000-7000-8000-00000000ffff', 'u:u-demo-1')).toBe(
      'not_found',
    );
    expect(r.admission.calls).toHaveLength(1);
  },
);

it.each([3_600, 120])(
  '[BR-AI-23 细则「受理记录与收尾」] Redis run 登记 ttlSeconds=%i：运行事实（终止原因、出卡数）由一个实例记下，新建的另一实例读得到，每次 set 都带 ttlSeconds',
  async (ttl) => {
    const redis = new FakeRedis();
    const time = new ManualTime();
    const a = createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: ttl });
    await a.register({ ...RUN });
    expect(
      await createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: ttl }).facts(
        '019a0000-0000-7000-8000-00000000ffff',
      ),
    ).toBeNull();
    await a.recordFacts(IDS.run, { ending: null, cardsDelivered: 2 });
    const b = createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: ttl });
    expect(await b.facts(IDS.run)).toEqual({ ending: null, cardsDelivered: 2 });
    await a.recordFacts(IDS.run, { ending: 'consent_withdrawn', cardsDelivered: 2 });
    const c = createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: ttl });
    expect(await c.facts(IDS.run)).toEqual({ ending: 'consent_withdrawn', cardsDelivered: 2 });
    expect(redis.ttls.every((x) => x === ttl)).toBe(true);
  },
);

it.each([
  { code: 10004 as const, ending: 'consent_withdrawn', card: false },
  { code: 30501 as const, ending: 'disabled', card: true },
])(
  '[BR-AI-23 细则「受理记录与收尾」][BR-AI-13][BR-AI-12] 守卫 $code（已出卡 $card）后收尾阻塞在 settle 时，另一实例已能读到终止原因与实际出卡数，终止帧尚未写出',
  async (c) => {
    const redis = new FakeRedis();
    const time = new ManualTime();
    const r = rig({
      config: { ...CONFIG, guardPollMs: 2_000 },
      time,
      registry: createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: 3_600 }),
    });
    r.admission.barrier.hold();
    const p = r.manager.start(r.start, async (ctx) => {
      if (c.card) await ctx.card(unnumbered(fixtureCardFrame('product_list')));
      return never();
    });
    const cards = c.card ? 1 : 0;
    await time.to(1_000);
    const other = createRedisRunRegistry({ redis, clock: time.clock, ttlSeconds: 3_600 });
    if (c.card) expect(await other.facts(IDS.run)).toEqual({ ending: null, cardsDelivered: 1 });
    r.guard.answer = { code: c.code };
    await time.to(4_000);
    expect(r.admission.calls.map((x) => x.outcome)).toEqual([
      { ending: c.ending, cardsDelivered: cards },
    ]);
    expect(await other.facts(IDS.run)).toEqual({ ending: c.ending, cardsDelivered: cards });
    expect(framesOf(r.sink.chunks).map((f) => f.event)).toEqual(
      c.card ? ['meta', 'card'] : ['meta'],
    );
    r.admission.barrier.release();
    expect(await time.drive(p, 5_000)).toBe(true);
    expect(framesOf(r.sink.chunks).slice(-1)[0]?.event).toBe('error');
    expect(await other.final(IDS.run)).toMatchObject({ event: 'error', data: { code: c.code } });
  },
);

it('[BR-AI-23 细则「受理记录与收尾」] Redis 保存未完成（set 被挡）时不进入 settle，另一实例读不到终止原因；放行后才结算、才读得到', async () => {
  const redis = new FakeRedis();
  const time = new ManualTime();
  const mine = redis.view();
  const r = rig({
    config: { ...CONFIG, guardPollMs: 2_000 },
    time,
    registry: createRedisRunRegistry({ redis: mine, clock: time.clock, ttlSeconds: 3_600 }),
  });
  const p = r.manager.start(r.start, async () => never());
  await time.to(1_000);
  const other = createRedisRunRegistry({
    redis: redis.view(),
    clock: time.clock,
    ttlSeconds: 3_600,
  });
  mine.setBarrier.hold();
  r.guard.answer = { code: 10004 };
  await time.to(4_000);
  expect(r.admission.calls).toEqual([]);
  expect((await other.facts(IDS.run))?.ending ?? null).toBeNull();
  mine.setBarrier.release();
  expect(await time.drive(p, 6_000)).toBe(true);
  expect(r.admission.calls.map((x) => x.outcome)).toEqual([
    { ending: 'consent_withdrawn', cardsDelivered: 0 },
  ]);
  expect(await other.facts(IDS.run)).toEqual({ ending: 'consent_withdrawn', cardsDelivered: 0 });
});

const TERMINAL = {
  event: 'done' as const,
  data: { finish_reason: 'stop' as const, quota_left: 6 },
};

it.each([
  { first: 'cancel', then: 'facts' },
  { first: 'facts', then: 'cancel' },
  { first: 'cancel', then: 'finish' },
  { first: 'finish', then: 'cancel' },
] as const)(
  '[BR-AI-23][02 §9.2] 两实例交错读改写（$first 读后被挡，$then 先完成）：取消信号、已出卡事实与终态都不被旧快照覆盖',
  async (c) => {
    const redis = new FakeRedis();
    const time = new ManualTime();
    const viewA = redis.view();
    const viewB = redis.view();
    const a = createRedisRunRegistry({ redis: viewA, clock: time.clock, ttlSeconds: 3_600 });
    const b = createRedisRunRegistry({ redis: viewB, clock: time.clock, ttlSeconds: 3_600 });
    await a.register({ ...RUN });
    await a.recordFacts(IDS.run, { ending: null, cardsDelivered: 0 });
    const act = (op: 'cancel' | 'facts' | 'finish'): Promise<unknown> =>
      op === 'cancel'
        ? b.requestCancel(IDS.run, 'u:u-demo-1')
        : op === 'facts'
          ? a.recordFacts(IDS.run, { ending: null, cardsDelivered: 1 })
          : a.finish(IDS.run, TERMINAL);
    const firstView = c.first === 'cancel' ? viewB : viewA;
    firstView.setBarrier.hold();
    const pending = act(c.first);
    await flush();
    await act(c.then);
    firstView.setBarrier.release();
    await pending;
    await flush();
    const reader = createRedisRunRegistry({
      redis: redis.view(),
      clock: time.clock,
      ttlSeconds: 3_600,
    });
    if (c.first === 'facts' || c.then === 'facts') {
      expect(await reader.cancelRequested(IDS.run)).toBe(true);
      expect(await reader.facts(IDS.run)).toEqual({ ending: null, cardsDelivered: 1 });
    } else {
      expect(await reader.final(IDS.run)).toEqual(TERMINAL);
      expect(await reader.requestCancel(IDS.run, 'u:u-demo-1')).toBe('not_found');
      expect(await reader.facts(IDS.run)).toEqual({ ending: null, cardsDelivered: 0 });
    }
  },
);
