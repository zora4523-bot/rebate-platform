// Rule tests for the scenario-switching command line of QA-05a (规划/05 QA-05「切换场景的命令行
// 工具」; 规划/02 §6.2 录制回放). The admin API is a recording fake (kit.ts): nothing listens or
// goes to the network. Only a local WireMock may be driven (09 README §0.2 hard rule 5; 规划/02
// §12.7 代理只能用 WireMock). Top-level it() only.
import { expect, it } from 'vitest';
import {
  resolveAdminUrl,
  runCli,
  type FaultTarget,
  type StubMapping,
} from '../../../infra/fault/fault.ts';
import {
  ALL_TARGETS,
  SAMPLE_PATH,
  SCENARIOS_OF,
  answer,
  expectedAdminUrl,
  fakeDeps,
  importedMappings,
  scenarioProblems,
  serveProblems,
  statesAfter,
} from './kit.ts';

it('[规划/05 QA-05] 默认管理地址是 http://127.0.0.1:<compose 发布端口>；load 不带参数把四个目标的桩导入该地址，导入后每个目标按头、按状态都能注入全部场景', async () => {
  const admin = expectedAdminUrl();
  expect(resolveAdminUrl({}).replace(/\/$/, '')).toBe(admin);
  const { deps, sent } = fakeDeps();
  const code = await runCli(['load'], deps);
  expect(code).toBe(0);
  expect(sent.length).toBeGreaterThan(0);
  for (const { url, init } of sent) {
    expect({ url, method: init.method }).toEqual({
      url: `${admin}/__admin/mappings/import`,
      method: 'POST',
    });
  }
  const imported = importedMappings(sent);
  for (const target of ALL_TARGETS) {
    expect(serveProblems(imported, target), target).toEqual([]);
  }
});

it('[规划/05 QA-05] load union.jd 只导入京东的桩：京东四种故障按头、按状态都在，别的目标一条不命中', async () => {
  const { deps, sent } = fakeDeps();
  const code = await runCli(['load', 'union.jd'], deps);
  expect(code).toBe(0);
  const imported = importedMappings(sent);
  expect(serveProblems(imported, 'union.jd')).toEqual([]);
  const strays = imported.filter((m) =>
    (['bailian', 'union.taobao', 'union.pdd'] as const).some((other) =>
      new RegExp(`^(?:${m.request.urlPathPattern})$`).test(SAMPLE_PATH[other]),
    ),
  );
  expect(strays.map((m) => m.name)).toEqual([]);
});

/** What `load <target>` puts into the (fake) WireMock: the CLI's own import, not buildMappings. */
async function loaded(target: FaultTarget): Promise<StubMapping[]> {
  const { deps, sent } = fakeDeps();
  expect(await runCli(['load', target], deps)).toBe(0);
  return importedMappings(sent);
}

it.each(ALL_TARGETS)(
  '[规划/05 QA-05 切换场景] %s：先 load 再 switch，不带 X-Scenario 头的请求命中的就是切到的场景',
  async (target: FaultTarget) => {
    const admin = expectedAdminUrl();
    const mappings = await loaded(target);
    for (const scenario of SCENARIOS_OF[target]) {
      const { deps, sent } = fakeDeps();
      const code = await runCli(['switch', target, scenario], deps);
      expect(code, `${target} ${scenario}`).toBe(0);
      expect(sent.filter(({ url }) => !url.startsWith(`${admin}/__admin/`))).toEqual([]);
      const hit = answer(
        mappings,
        { method: 'POST', path: SAMPLE_PATH[target] },
        statesAfter(admin, sent),
      );
      expect(hit === null || hit === 'ambiguous' ? hit : 'stub', `${target} ${scenario}`).toBe(
        'stub',
      );
      if (hit !== null && hit !== 'ambiguous') {
        expect(scenarioProblems(scenario, hit.response), `${target} ${scenario}`).toEqual([]);
      }
    }
  },
);

it('[规划/02 §6.2 X-Scenario] 切换后单个请求仍可用 X-Scenario 头覆盖；百炼切回 normal 即恢复正常', async () => {
  const admin = expectedAdminUrl();
  const bailian = await loaded('bailian');
  const toTimeout = fakeDeps();
  expect(await runCli(['switch', 'bailian', 'timeout'], toTimeout.deps)).toBe(0);
  const states = statesAfter(admin, toTimeout.sent);
  const overridden = answer(
    bailian,
    { method: 'POST', path: SAMPLE_PATH.bailian, scenarioHeader: 'normal' },
    states,
  );
  expect(overridden !== null && overridden !== 'ambiguous').toBe(true);
  if (overridden !== null && overridden !== 'ambiguous') {
    expect(scenarioProblems('normal', overridden.response)).toEqual([]);
  }
  const back = fakeDeps();
  expect(await runCli(['switch', 'bailian', 'normal'], back.deps)).toBe(0);
  for (const [name, state] of statesAfter(admin, back.sent)) states.set(name, state);
  const restored = answer(bailian, { method: 'POST', path: SAMPLE_PATH.bailian }, states);
  expect(restored !== null && restored !== 'ambiguous').toBe(true);
  if (restored !== null && restored !== 'ambiguous') {
    expect(scenarioProblems('normal', restored.response)).toEqual([]);
  }
});

it.each<[string[]]>([
  [[]],
  [['explode']],
  [['switch']],
  [['switch', 'bailian']],
  [['switch', 'union.meituan', 'timeout']],
  [['switch', 'bailian', 'slow']],
  [['switch', 'union.taobao', 'normal']],
  [['switch', 'union.jd', 'delay']],
  [['load', 'union.pdd', 'bogus']],
])('[规划/05 QA-05] 用法错误 %j：退出 2、写 stderr、不发任何管理请求', async (argv: string[]) => {
  const { deps, sent, err } = fakeDeps();
  const code = await runCli(argv, deps);
  expect({ code, sent: sent.length, stderr: err.length > 0 }).toEqual({
    code: 2,
    sent: 0,
    stderr: true,
  });
});

it.each([
  'https://eco.taobao.com/router/rest',
  'http://api.jd.com/routerjson',
  'https://gw-api.pinduoduo.com/api/router',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'http://wiremock.example.com:8080',
])(
  '[09 README §0.2 硬规则 5] FAULT_WIREMOCK_URL=%s 不是本地 WireMock：拒绝，退出 2，不发请求',
  async (url: string) => {
    expect(() => resolveAdminUrl({ FAULT_WIREMOCK_URL: url })).toThrow();
    const { deps, sent } = fakeDeps({ FAULT_WIREMOCK_URL: url });
    const code = await runCli(['switch', 'bailian', 'timeout'], deps);
    expect({ code, sent: sent.length }).toEqual({ code: 2, sent: 0 });
  },
);

it.each([
  'http://127.0.0.1:19999',
  'http://localhost:19999',
  'http://[::1]:19999',
  'http://wiremock:8080',
])(
  '[规划/02 §12.7] FAULT_WIREMOCK_URL=%s 是本机或容器内服务名：管理请求只发往它，不带凭据头',
  async (url: string) => {
    const { deps, sent } = fakeDeps({ FAULT_WIREMOCK_URL: url });
    const code = await runCli(['switch', 'union.taobao', 'rate_limited'], deps);
    expect(code).toBe(0);
    expect(sent.length).toBeGreaterThan(0);
    for (const { url: to, init } of sent) {
      expect(to.startsWith(`${url}/__admin/`), to).toBe(true);
      const headers = Object.keys(init.headers ?? {}).map((h) => h.toLowerCase());
      expect(headers.filter((h) => h === 'authorization' || h === 'cookie')).toEqual([]);
    }
  },
);

it('[规划/05 QA-05] 管理接口返回 5xx：退出 1 并在 stderr 说明', async () => {
  const { deps, err } = fakeDeps({}, 500);
  const code = await runCli(['switch', 'bailian', 'server_error'], deps);
  expect({ code, stderr: err.length > 0 }).toEqual({ code: 1, stderr: true });
});
