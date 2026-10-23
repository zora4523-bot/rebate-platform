// B3-08k (D10-294): createAgentStreamRuntime reads the agent.* switches, the consent version and
// the daily limits only through the injected content reader (deps.contentReader, app.module's),
// with the same results as before: switches through freshConfigValue behind agent's 1 s cache
// (createAgentConfigReader), the version and the limits through configValue. The runtime hands the
// business assembly that very reader (context.contentReader) and no database handle, and calls
// identity's consent reader factory (deps.consentReader, a function value handed in) with the
// version source only. agentStreamProvider injects the content reader by agentContentReaderToken()
// and the consent reader factory by agentConsentReaderToken() (app.module builds it over its own
// handle; forStream takes no consentReader option). Compile-only database: a config_items query
// means agent built a content reader over its own handle. Nothing reaches a model or the network.
import { expect, it } from 'vitest';

import { admissionDefaults } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  agentConsentReaderToken,
  agentContentReaderToken,
  agentStreamProvider,
  createAgentStreamRuntime,
  type AgentConsentReaderFactory,
  type AgentStreamAssemblyContext,
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

type ConsentOptions = Parameters<AgentConsentReaderFactory>[0];

/** identity's AiConsentReader stand-in: every subject has no consent (10004 after ① ②). */
function consentStandIn() {
  const calls: ConsentOptions[] = [];
  const factory: AgentConsentReaderFactory = (options) => {
    calls.push(options);
    return { check: async () => ({ allowed: false, reason: 'missing' }) };
  };
  return { factory, calls };
}

function runtimeOver(reader: FakeContentReader) {
  const queries: string[] = [];
  const clock = fixedClock();
  const consent = consentStandIn();
  const runtime = createAgentStreamRuntime({
    db: compileOnlyDb(queries),
    clock,
    logger: logs().logger,
    consentReader: consent.factory,
    contentReader: reader,
  });
  return { runtime, queries, clock, consent: consent.calls };
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

it('[AC-B3-08k#3][AC-B3-08k#4] 开关读取经过 agent 的 1 秒缓存：同一 app 的 agent.enabled 在 1 000 ms 内（跨请求）只读一次注入读取器的 freshConfigValue，满 1 000 ms 重读', async () => {
  const reader = new FakeContentReader()
    .set(APP, 'agent.enabled', true)
    .set(APP, 'agent.whitelist_only', false);
  const { runtime, clock } = runtimeOver(reader);
  const fresh = () => reader.count('freshConfigValue', APP, 'agent.enabled');

  const first = new JsonReply();
  await runtime.http.createSession(member(), first);
  expect(fresh(), 'first request').toBe(1);
  clock.advanceMs(999);
  const second = new JsonReply();
  await runtime.http.createSession(member(), second);
  expect(fresh(), 'age 999 ms: kept').toBe(1);
  clock.advanceMs(1);
  const third = new JsonReply();
  await runtime.http.createSession(member(), third);
  expect(fresh(), 'age 1 000 ms: read again').toBe(2);
  expect([...first.codes(), ...second.codes(), ...third.codes()]).toEqual([10004, 10004, 10004]);
});

it('[AC-B3-08k#3] 同意版本 legal.ai_third_party.version 经注入 content 读取器的 configValue：正整数 3 → 3；缺失或非正整数 → 1；同意读取器工厂只收版本来源、不收数据库句柄；不发 config_items 查询', async () => {
  const reader = new FakeContentReader()
    .set(APP, VERSION_KEY, 3)
    .set('zero-app', VERSION_KEY, 0)
    .set('text-app', VERSION_KEY, '3');
  const { queries, consent } = runtimeOver(reader);
  expect(consent, 'consent reader factory calls').toHaveLength(1);
  const version = consent[0]!.currentVersion;

  const current = await version(APP);
  expect(reader.keys('configValue')).toContain(VERSION_KEY);
  expect(current).toBe(3);
  expect(await version('missing-app')).toBe(1);
  expect(await version('zero-app')).toBe(1);
  expect(await version('text-app')).toBe(1);
  expect(reader.keys('freshConfigValue')).toEqual([]);
  expect(configQueries(queries)).toEqual([]);
  expect(consent[0], 'identity is handed no database handle').not.toHaveProperty('db');
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

it('[AC-B3-08k#2][AC-B3-08k#3][BR-AI-02] 运行体把注入的 deps.contentReader 原样交给业务装配：装配工厂收到的 context.contentReader 就是注入的那个对象，入参不带数据库句柄', () => {
  const reader = new FakeContentReader();
  const contexts: AgentStreamAssemblyContext[] = [];
  const captured = new Error('fixture: assembly context captured');
  const build = () =>
    createAgentStreamRuntime({
      db: compileOnlyDb([]),
      clock: fixedClock(),
      logger: logs().logger,
      consentReader: consentStandIn().factory,
      contentReader: reader,
      assembly: (context) => {
        contexts.push(context);
        throw captured;
      },
    });

  expect(build).toThrow(captured);
  expect(contexts, 'assembly factory calls').toHaveLength(1);
  expect(contexts[0]!.contentReader, 'the injected reader itself').toBe(reader);
  expect(contexts[0], 'no database handle for a function value handed in').not.toHaveProperty('db');
});

it('[AC-B3-08k#3][BR-AI-02] agentStreamProvider：注入 agentContentReaderToken() 与 agentConsentReaderToken()（app.module 组装的 content 读取器与同意读取器工厂）并交给运行体；有库时运行体的配额上限经该读取器读取、同意读取器工厂被调用一次', async () => {
  const token = agentContentReaderToken();
  const consentToken = agentConsentReaderToken();
  expect(agentContentReaderToken(), 'the same symbol on every call').toBe(token);
  expect(agentConsentReaderToken(), 'the same symbol on every call').toBe(consentToken);
  // forStream's options keep only the assembly and the safety configuration.
  const provider = agentStreamProvider({} as Parameters<typeof agentStreamProvider>[0]);
  expect(injectTokens(provider)).toEqual(expect.arrayContaining([token, consentToken]));

  const reader = new FakeContentReader().set(APP, 'agent.member_daily_quota', 4);
  const consent = consentStandIn();
  const queries: string[] = [];
  const values = new Map<unknown, unknown>([
    [CLOCK, fixedClock()],
    [ROOT_LOGGER, logs().logger],
    [DB, compileOnlyDb(queries)],
    [token, reader],
    [consentToken, consent.factory],
  ]);
  const runtime = callFactory(provider, values) as AgentStreamRuntime | null;
  expect(runtime).not.toBeNull();
  expect(consent.calls, 'consent reader factory calls').toHaveLength(1);
  const limits = await runtime!.limits.current(APP);
  expect(reader.keys('configValue')).toEqual(expect.arrayContaining([...LIMIT_KEYS]));
  expect(limits.memberDaily).toBe(4);
  expect(configQueries(queries)).toEqual([]);
});
