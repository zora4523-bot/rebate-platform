// B3-03h 第 9 节 8，Codex 第 2 轮 S1：真实 provider 的 start() 必须真的接到循环（一个只返回 stop 的空 start
// 会让 worker 起来后永不收尾）。用 Nest 装 AgentModule.forWorker()，平台的 DB（真 PostgreSQL，每个用例一库）
// / CLOCK / ROOT_LOGGER 由一个全局替身模块提供；从容器取出运行体，形状与 createAgentSweeperRuntime 的结果一致
// （同一条装配路径），start({schedule}) 后触发一次 tick → 遗留 run 被收尾（50001、退还、锁释放）、记一条
// agent_sweep_tick；stop() 后迟到触发的 tick 不再收尾新的遗留 run。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  sweepStart,
  sweeperDefaults,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import {
  AgentModule,
  agentSweeperToken,
  createAgentSweeperRuntime,
  type AgentSweeperRuntime,
} from '../../../../apps/api/src/modules/agent/agent.module.ts';
import { memberKey, usedOn } from '../stream-finalize/kit.ts';
import { leftover } from '../stream-sweeper/kit.ts';
import {
  DAY,
  Logs,
  ManualSchedule,
  START_MS,
  advisoryHolders,
  fileErrorMsg,
  runRow,
  sessionRow,
  usePgEach,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);

interface Context {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

/** A Nest context of AgentModule.forWorker() over the platform tokens it injects. */
async function agentContext(clock: FixedClock, logs: Logs): Promise<Context> {
  // Loaded by URL: platform's index pulls in its Nest controllers, which the `test` project does
  // not compile (as the B1-03j scheduling test loads it).
  const { DB, CLOCK, ROOT_LOGGER } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as { DB: symbol; CLOCK: symbol; ROOT_LOGGER: symbol };
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  class PlatformTokens {}
  class ProviderTestRoot {}
  const platform = {
    module: PlatformTokens,
    global: true,
    providers: [
      { provide: DB, useValue: pg.db },
      { provide: CLOCK, useValue: clock },
      { provide: ROOT_LOGGER, useValue: logs.logger },
    ],
    exports: [DB, CLOCK, ROOT_LOGGER],
  };
  return NestFactory.createApplicationContext(
    { module: ProviderTestRoot, imports: [platform, AgentModule.forWorker()] },
    { logger: false, abortOnError: false },
  );
}

it('[AC-B3-03h#35] 真实 provider（AgentModule.forWorker）：运行体与 createAgentSweeperRuntime 同形同参；start({schedule}) 触发一次 tick 即收尾遗留 run（50001、退还、会话锁与 advisory lock 释放）并记 agent_sweep_tick；stop 后迟到的 tick 不再收尾', async () => {
  const left = await leftover(pg.db, START_MS);
  const nowMs = left.lockMs + sweeperDefaults().marginMs + 1_000;
  const clock = new FixedClock(new Date(nowMs));
  const logs = new Logs();
  const context = await agentContext(clock, logs);
  try {
    const runtime = context.get(agentSweeperToken(), { strict: false }) as AgentSweeperRuntime;
    expect(runtime).not.toBeNull();
    expect(logs.of('agent_sweeper_disabled')).toEqual([]);

    // One assembly path: the provider's value is what createAgentSweeperRuntime builds.
    const direct = createAgentSweeperRuntime({ db: pg.db, clock, logger: logs.logger });
    expect(Object.keys(runtime).sort()).toEqual(Object.keys(direct).sort());
    expect(runtime.timings).toEqual(direct.timings);
    expect(runtime.sweeperConfig).toEqual(direct.sweeperConfig);
    expect(runtime.loopConfig).toEqual(direct.loopConfig);
    expect(runtime.texts.errorMsg(50001)).toBe(direct.texts.errorMsg(50001));
    expect(context.get(agentSweeperToken(), { strict: false })).toBe(runtime);

    const before = await usedOn(pg.db, memberKey(left.subject), DAY);
    expect(before).toBe(1);
    const schedule = new ManualSchedule();
    const loop = runtime.start({ schedule: schedule.schedule });
    try {
      expect(schedule.armed.map((a) => a.timer)).toEqual(['tick']);
      await schedule.fire('tick');
      expect(logs.of('agent_sweep_tick')).toEqual([
        expect.objectContaining({ processed: 1, finalized: 1, failed: 0, wrapped: true }),
      ]);
      const row = await runRow(pg.db, left.runId);
      expect(row).toMatchObject({ end_reason: 'server_error', settle_result: 'refunded' });
      expect(row['final_event']).toEqual({
        type: 'error',
        data: { code: 50001, msg: fileErrorMsg(50001), retryable: true, fallback: null },
      });
      expect(await usedOn(pg.db, memberKey(left.subject), DAY)).toBe(0);
      expect((await sessionRow(pg.db, left.sessionId))['run_lock_run_id']).toBeNull();
      expect(await advisoryHolders(pg.db)).toEqual([]);
    } finally {
      await loop.stop();
    }

    // After stop: a 'tick' timer that still fires finalizes nothing.
    const later = await leftover(pg.db, START_MS + 1_000);
    const pending = schedule.armed.filter((a) => a.timer === 'tick' && !a.fired);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.cancelled).toBe(true);
    await schedule.fireLate(pending[0]!);
    expect(logs.of('agent_sweep_tick')).toHaveLength(1);
    expect((await runRow(pg.db, later.runId))['final_event']).toBeNull();
    expect((await sessionRow(pg.db, later.sessionId))['run_lock_run_id']).toBe(later.runId);
  } finally {
    await context.close();
  }
});

it('[AC-B3-03h#40] 真实 provider 的 step 每次只处理一行：两条遗留 run 时 step.sweepOnce(sweepStart()) 只收尾第一条（processed 1、wrapped false、游标停在它上），第二条要下一次调用；本轮上限在 loopConfig（= sweeperConfig.maxPerTick）而不在 step', async () => {
  const first = await leftover(pg.db, START_MS);
  const second = await leftover(pg.db, START_MS + 1_000);
  const nowMs = second.lockMs + sweeperDefaults().marginMs + 1_000;
  const clock = new FixedClock(new Date(nowMs));
  const logs = new Logs();
  const context = await agentContext(clock, logs);
  try {
    const runtime = context.get(agentSweeperToken(), { strict: false }) as AgentSweeperRuntime;
    expect(runtime.loopConfig.maxPerTick).toBe(runtime.sweeperConfig.maxPerTick);
    expect(runtime.loopConfig.maxPerTick).toBeGreaterThan(1);

    const r1 = await runtime.step.sweepOnce(sweepStart());
    expect(r1).toMatchObject({ processed: 1, finalized: 1, failed: 0, wrapped: false });
    expect(r1.nextCursor).toEqual({
      lockExpiresAt: new Date(first.lockMs),
      sessionId: first.sessionId,
    });
    expect((await runRow(pg.db, first.runId))['final_event']).not.toBeNull();
    expect((await runRow(pg.db, second.runId))['final_event']).toBeNull();

    const r2 = await runtime.step.sweepOnce(r1.nextCursor);
    expect(r2).toMatchObject({ processed: 1, finalized: 1, wrapped: false });
    expect((await runRow(pg.db, second.runId))['final_event']).not.toBeNull();
    const r3 = await runtime.step.sweepOnce(r2.nextCursor);
    expect(r3).toMatchObject({ processed: 0, wrapped: true });
  } finally {
    await context.close();
  }
});
