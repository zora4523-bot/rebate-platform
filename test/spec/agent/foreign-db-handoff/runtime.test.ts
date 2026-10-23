// B3-08k (D10-294): createAgentStreamRuntime reads the agent.* switches, the consent version and
// the daily limits only through the injected content reader (deps.contentReader, app.module's),
// with the same results as before: switches through freshConfigValue (createAgentConfigReader),
// the version and the limits through configValue. agentStreamProvider injects that reader by
// agentContentReaderToken(). Compile-only database: a config_items query means agent built a
// content reader over its own handle. identity's consent reader is a stand-in factory (its
// currentVersion is the runtime's version source); nothing reaches a model or the network.
import { expect, it } from 'vitest';

import { admissionDefaults } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  agentContentReaderToken,
  agentStreamProvider,
  createAgentStreamRuntime,
  type AgentConsentReaderFactory,
  type AgentStreamRuntime,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { CLOCK, DB, ROOT_LOGGER } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  FakeContentReader,
  JsonReply,
  LIMIT_KEYS,
  callFactory,
  compileOnlyDb,
  configQueries,
  fixedClock,
  injectTokens,
  logs,
  member,
} from './kit.ts';

const VERSION_KEY = 'legal.ai_third_party.version';

/** identity's AiConsentReader stand-in: every subject has no consent (10004 after ① ②). */
function consentStandIn() {
  const versions: ((appId: string) => Promise<number>)[] = [];
  const factory: AgentConsentReaderFactory = (options) => {
    versions.push(options.currentVersion);
    return { check: async () => ({ allowed: false, reason: 'missing' }) };
  };
  return { factory, versions };
}

function runtimeOver(reader: FakeContentReader) {
  const queries: string[] = [];
  const consent = consentStandIn();
  const runtime = createAgentStreamRuntime({
    db: compileOnlyDb(queries),
    clock: fixedClock(),
    logger: logs().logger,
    consentReader: consent.factory,
    contentReader: reader,
  });
  return { runtime, queries, versions: consent.versions };
}

it('[AC-B3-08k#3][BR-AI-02] createAgentStreamRuntime：开放判定的 agent.enabled 只经注入 content 读取器的 freshConfigValue 读取；true → 通过 ①（本例停在同意 10004），false / 缺失 → 30501；运行体不自建 content 读取器（无 config_items 查询）', async () => {
  const cases = [
    { name: 'agent.enabled true', enabled: true, code: 10004 },
    { name: 'agent.enabled false', enabled: false, code: 30501 },
    { name: 'agent.enabled missing', enabled: undefined, code: 30501 },
  ] as const;
  for (const c of cases) {
    const reader = new FakeContentReader()
      .set(APP, 'agent.enabled', c.enabled)
      .set(APP, 'agent.whitelist_only', false);
    const { runtime, queries } = runtimeOver(reader);
    const reply = new JsonReply();
    await runtime.http.createSession(member(), reply);
    expect(reader.keys('freshConfigValue'), c.name).toContain('agent.enabled');
    expect(reader.keys('configValue'), c.name).not.toContain('agent.enabled');
    expect(configQueries(queries), c.name).toEqual([]);
    expect(reply.codes(), c.name).toEqual([c.code]);
  }
});

it('[AC-B3-08k#3] 同意版本 legal.ai_third_party.version 经注入 content 读取器的 configValue：正整数 3 → 3；缺失或非正整数 → 1；不发 config_items 查询', async () => {
  const reader = new FakeContentReader()
    .set(APP, VERSION_KEY, 3)
    .set('zero-app', VERSION_KEY, 0)
    .set('text-app', VERSION_KEY, '3');
  const { queries, versions } = runtimeOver(reader);
  expect(versions, 'consent reader factory calls').toHaveLength(1);
  const version = versions[0]!;

  const current = await version(APP);
  expect(reader.keys('configValue')).toContain(VERSION_KEY);
  expect(current).toBe(3);
  expect(await version('missing-app')).toBe(1);
  expect(await version('zero-app')).toBe(1);
  expect(await version('text-app')).toBe(1);
  expect(reader.keys('freshConfigValue')).toEqual([]);
  expect(configQueries(queries)).toEqual([]);
});

it('[AC-B3-08k#3] 配额上限 runtime.limits.current(appId) 经注入 content 读取器的 configValue：三项配置值照用；缺失或非法（负数、小数、文本）取 admissionDefaults()；不发 config_items 查询', async () => {
  const reader = new FakeContentReader()
    .set(APP, 'agent.member_daily_quota', 7)
    .set(APP, 'agent.guest_daily_quota', 2)
    .set(APP, 'agent.guest_ip_daily_quota', 9)
    .set('bad-app', 'agent.member_daily_quota', -1)
    .set('bad-app', 'agent.guest_daily_quota', 1.5)
    .set('bad-app', 'agent.guest_ip_daily_quota', '9');
  const { runtime, queries } = runtimeOver(reader);

  const limits = await runtime.limits.current(APP);
  expect(reader.keys('configValue')).toEqual(expect.arrayContaining([...LIMIT_KEYS]));
  expect(limits).toEqual({
    ...admissionDefaults(),
    memberDaily: 7,
    guestDaily: 2,
    guestIpDaily: 9,
  });
  expect(await runtime.limits.current('bad-app')).toEqual(admissionDefaults());
  expect(await runtime.limits.current('missing-app')).toEqual(admissionDefaults());
  expect(reader.keys('freshConfigValue')).toEqual([]);
  expect(configQueries(queries)).toEqual([]);
});

it('[AC-B3-08k#3][BR-AI-02] agentStreamProvider：注入 agentContentReaderToken()（app.module 组装的 content 读取器）并交给运行体；有库时运行体的配额上限经该读取器读取', async () => {
  const token = agentContentReaderToken();
  expect(agentContentReaderToken(), 'the same symbol on every call').toBe(token);
  const provider = agentStreamProvider({ consentReader: consentStandIn().factory });
  expect(injectTokens(provider)).toContain(token);

  const reader = new FakeContentReader().set(APP, 'agent.member_daily_quota', 4);
  const queries: string[] = [];
  const values = new Map<unknown, unknown>([
    [CLOCK, fixedClock()],
    [ROOT_LOGGER, logs().logger],
    [DB, compileOnlyDb(queries)],
    [token, reader],
  ]);
  const runtime = callFactory(provider, values) as AgentStreamRuntime | null;
  expect(runtime).not.toBeNull();
  const limits = await runtime!.limits.current(APP);
  expect(reader.keys('configValue')).toEqual(expect.arrayContaining([...LIMIT_KEYS]));
  expect(limits.memberDaily).toBe(4);
  expect(configQueries(queries)).toEqual([]);
});
