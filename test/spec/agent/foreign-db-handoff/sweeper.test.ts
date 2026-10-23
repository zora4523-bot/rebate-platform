// B3-08k (D10-294): the worker's sweeper (agent.module.ts) reads the finalizer's daily limits
// through the content reader app.module assembled (deps.contentReader; AgentModule.forWorker()
// injects it by agentContentReaderToken()), never through a reader over its own handle. The
// runtime exposes that one QuotaLimitsSource as runtime.limits. Building starts nothing; the
// database is compile-only (a config_items query means a content reader over agent's handle).
import { expect, it } from 'vitest';

import {
  AgentModule,
  agentSweeperToken,
  createAgentSweeperRuntime,
  type AgentSweeperRuntime,
} from '../../../../apps/api/src/modules/agent/agent.module.ts';
import { admissionDefaults } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import { agentContentReaderToken } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { CLOCK, DB, ROOT_LOGGER } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  FakeContentReader,
  LIMIT_KEYS,
  callFactory,
  compileOnlyDb,
  configQueries,
  fixedClock,
  injectTokens,
  logs,
  providerOf,
} from './kit.ts';

function limitsReader(): FakeContentReader {
  return new FakeContentReader()
    .set(APP, 'agent.member_daily_quota', 11)
    .set(APP, 'agent.guest_daily_quota', 3)
    .set(APP, 'agent.guest_ip_daily_quota', 13)
    .set('bad-app', 'agent.member_daily_quota', -2);
}

it('[AC-B3-08k#6][BR-AI-02] createAgentSweeperRuntime：扫尾器的配额上限（runtime.limits，交给 createPgRunPorts 的同一个来源）经注入 content 读取器的 configValue 读取；缺失或非法取 admissionDefaults()；不自建 content 读取器、不发 config_items 查询', async () => {
  const reader = limitsReader();
  const queries: string[] = [];
  const runtime = createAgentSweeperRuntime({
    db: compileOnlyDb(queries),
    clock: fixedClock(),
    logger: logs().logger,
    contentReader: reader,
  });
  expect(runtime.limits, 'runtime.limits (the finalizer limits source)').toBeDefined();

  const limits = await runtime.limits!.current(APP);
  expect(reader.keys('configValue')).toEqual(expect.arrayContaining([...LIMIT_KEYS]));
  expect(limits).toEqual({
    ...admissionDefaults(),
    memberDaily: 11,
    guestDaily: 3,
    guestIpDaily: 13,
  });
  expect(await runtime.limits!.current('bad-app')).toEqual(admissionDefaults());
  expect(reader.keys('freshConfigValue')).toEqual([]);
  expect(configQueries(queries)).toEqual([]);
});

it('[AC-B3-08k#6][BR-AI-02] AgentModule.forWorker()：扫尾器 provider 注入 agentContentReaderToken() 并据此建运行体（上限经注入读取器）；无库仍为 null 并记一条 agent_sweeper_disabled', async () => {
  const token = agentContentReaderToken();
  const provider = providerOf(AgentModule.forWorker().providers, agentSweeperToken());
  expect(injectTokens(provider)).toContain(token);

  const reader = limitsReader();
  const queries: string[] = [];
  const log = logs();
  const runtime = callFactory(
    provider,
    new Map<unknown, unknown>([
      [CLOCK, fixedClock()],
      [ROOT_LOGGER, log.logger],
      [DB, compileOnlyDb(queries)],
      [token, reader],
    ]),
  ) as AgentSweeperRuntime | null;
  expect(runtime).not.toBeNull();
  expect(typeof runtime!.start).toBe('function');
  const limits = await runtime!.limits!.current(APP);
  expect(reader.keys('configValue')).toEqual(expect.arrayContaining([...LIMIT_KEYS]));
  expect(limits.memberDaily).toBe(11);
  expect(configQueries(queries)).toEqual([]);
  expect(log.lines().filter((line) => line.msg === 'agent_sweeper_disabled')).toEqual([]);

  const off = logs();
  const none = callFactory(
    provider,
    new Map<unknown, unknown>([
      [CLOCK, fixedClock()],
      [ROOT_LOGGER, off.logger],
      [token, reader],
    ]),
  );
  expect(none, 'no database handle').toBeNull();
  expect(off.lines().filter((line) => line.msg === 'agent_sweeper_disabled')).toHaveLength(1);
});
