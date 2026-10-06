import { expect, it } from 'vitest';
import { runDrill, type DrillScenario } from '../../../../infra/drills/queue/drill.ts';
import { actions, drillOptions, fakeTime, makeStub, type StubBehaviour } from './stub.ts';

const IDS = Array.from(
  { length: 7 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);

async function drill(scenario: DrillScenario, behaviour: Partial<StubBehaviour> = {}) {
  const stub = makeStub(behaviour);
  const time = fakeTime();
  const result = await runDrill(drillOptions(stub, time, { scenario }));
  return { stub, time, result };
}

it.each([
  ['worker-stop', 'graceful'],
  ['worker-kill', 'kill'],
] as const)(
  '[QA-05 停掉 worker] %s：中断后补入队、重启 worker、排空后核对',
  async (scenario, mode) => {
    const { stub, result } = await drill(scenario);
    expect(actions(stub)).toEqual([
      'reset',
      'enqueue:4',
      'startWorker',
      `stopWorker:${mode}`,
      'enqueue:3',
      'startWorker',
      'stopWorker:graceful',
    ]);
    expect(result.steps).toEqual([
      'preflight',
      'enqueue',
      'start_worker',
      'await_progress',
      'interrupt',
      'enqueue_during_outage',
      'recover',
      'drain',
      'verify',
      'cleanup',
    ]);
    expect(result).toMatchObject({ scenario, ok: true, problems: [], sent: IDS });
    expect(result.startedAt).toBe('2026-10-06T01:02:03.000Z');
  },
);

it('[QA-05 停在处理中途] 中断发生在快照已见到业务效果之后', async () => {
  const { stub } = await drill('worker-stop');
  const start = stub.calls.indexOf('startWorker');
  const stop = stub.calls.indexOf('stopWorker:graceful');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(stop).toBeGreaterThan(start);
  expect(stub.calls.slice(start, stop)).toContain('snapshot');
  expect([...stub.jobs.values()].filter((job) => job.state === 'completed').length).toBe(7);
});

it('[02 §11 至少一次投递 + 消费端去重] worker 被杀后重投：效果仍各一次，重投计 1', async () => {
  const { stub, result } = await drill('worker-kill');
  expect(result.ok).toBe(true);
  expect(result.redelivered).toBe(1);
  expect([...stub.jobs.values()].map((job) => job.effects)).toEqual([1, 1, 1, 1, 1, 1, 1]);
});

it('[02 §18 消费端去重] 消费端不去重时演练判不通过：duplicate_effect', async () => {
  const { result } = await drill('worker-kill', { dedup: false });
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([{ code: 'duplicate_effect', id: IDS[2], step: null }]);
});

it('[QA-05 任务不丢] 被杀时丢掉在途任务，演练判不通过：lost', async () => {
  const { result } = await drill('worker-kill', { loseOnKill: true });
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([{ code: 'lost', id: IDS[2], step: null }]);
});

it('[02 §14 PostgreSQL 行 断线自动重连] 断开队列连接后不重启 worker，靠它自己重连排空', async () => {
  const { stub, result } = await drill('queue-disconnect');
  expect(actions(stub)).toEqual([
    'reset',
    'enqueue:4',
    'startWorker',
    'disconnectQueue',
    'enqueue:3',
    'stopWorker:graceful',
  ]);
  expect(result.steps).toContain('recover');
  expect(result).toMatchObject({ ok: true, problems: [], sent: IDS });
});

it('[02 §14 PostgreSQL 行 断线自动重连] worker 不重连：排空超时后报 not_drained，等待有界且只走注入时钟', async () => {
  const { time, result } = await drill('queue-disconnect', { reconnectAfterPolls: null });
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual(
    IDS.slice(2).map((id) => ({ code: 'not_drained', id, step: null })),
  );
  expect(time.sleeps).toBeGreaterThanOrEqual(29);
  expect(time.sleeps).toBeLessThanOrEqual(32);
  expect(result.steps.slice(-3)).toEqual(['drain', 'verify', 'cleanup']);
});

it('[02 §14 Redis 行] Redis 停着时入队照常、任务照常执行；先排空再恢复 Redis，不补投', async () => {
  const { stub, result } = await drill('redis-down');
  expect(actions(stub)).toEqual([
    'reset',
    'enqueue:4',
    'startWorker',
    'stopRedis',
    'enqueue:3',
    'startRedis',
    'stopWorker:graceful',
  ]);
  expect(result.steps).toEqual([
    'preflight',
    'enqueue',
    'start_worker',
    'await_progress',
    'interrupt',
    'enqueue_during_outage',
    'drain',
    'recover',
    'verify',
    'cleanup',
  ]);
  const between = stub.calls.slice(
    stub.calls.indexOf('enqueue:3'),
    stub.calls.indexOf('startRedis'),
  );
  expect(between).toContain('snapshot');
  expect(result).toMatchObject({ ok: true, problems: [], sent: IDS });
});

it('[02 §14 Redis 行] 任务执行依赖 Redis 的系统在 Redis 停机期间排不空：判不通过', async () => {
  const { result } = await drill('redis-down', { workNeedsRedis: true });
  expect(result.ok).toBe(false);
  expect(result.problems.length).toBeGreaterThan(0);
  expect(result.problems.every((p) => p.code === 'not_drained')).toBe(true);
});

it('[02 §14 Redis 行 入队不依赖 Redis] 停机期间入队失败：step_failed，仍恢复 Redis、停 worker', async () => {
  const { stub, result } = await drill('redis-down', { enqueueNeedsRedis: true });
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    { code: 'step_failed', id: null, step: 'enqueue_during_outage' },
  ]);
  expect(result.steps.slice(-3)).toEqual(['interrupt', 'enqueue_during_outage', 'cleanup']);
  expect(result.sent).toEqual(IDS.slice(0, 4));
  const tail = actions(stub).slice(5);
  expect(tail).toHaveLength(2);
  expect(tail).toEqual(expect.arrayContaining(['startRedis', 'stopWorker:graceful']));
});

it.each<DrillScenario>(['worker-stop', 'worker-kill', 'queue-disconnect', 'redis-down'])(
  '[02 §14 Redis 行 不需要恢复后补投] %s：每个 id 只发送一次，只有两次入队',
  async (scenario) => {
    const { stub, result } = await drill(scenario);
    expect(stub.calls.filter((call) => call.startsWith('enqueue:'))).toEqual([
      'enqueue:4',
      'enqueue:3',
    ]);
    expect(new Set(result.sent).size).toBe(result.sent.length);
    expect([...stub.jobs.keys()].sort()).toEqual([...result.sent].sort());
  },
);
