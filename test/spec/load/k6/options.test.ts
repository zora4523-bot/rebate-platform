// Rule tests for the k6 options builder of QA-06a (规划/05 QA-06「k6 峰值 3 倍：搜索、转链、Agent SSE、
// 同步（上游用 WireMock；真实联盟接口压测只按 09 README §0.2 硬规则 5）」; P95 targets are pointers
// to 01 §7.1, peaks to 01 §7.3). Pure functions on a hand-written config: nothing listens, no k6
// is run. Every expected value is a literal written here. Top-level it() only.
import { expect, it } from 'vitest';
import {
  buildOptions,
  configProblems,
  resolveBaseUrls,
  type K6Scenario,
  type LoadConfig,
  type ScenarioConfig,
  type ScenarioName,
} from '../../../../infra/load/k6/options.ts';

/** A valid config; a fresh object on every call so no test shares references with another. */
function fixture(): LoadConfig {
  return {
    multiplier: 3,
    base_urls: {
      api: 'http://127.0.0.1:3000',
      stream: 'http://localhost:3001',
      admin: 'http://[::1]:3002',
    },
    scenarios: {
      search: {
        service: 'api',
        method: 'GET',
        path: '/v1/products/search?platform=jd&q=load',
        executor: 'ramping-arrival-rate',
        peak: 7,
        ramp_up: '30s',
        hold: '2m',
        latency_metric: 'http_req_duration',
        p95_ms: 1500,
        error_rate: 0.01,
      },
      convert: {
        service: 'api',
        method: 'POST',
        path: '/v1/links/convert',
        executor: 'ramping-arrival-rate',
        peak: 5,
        ramp_up: '30s',
        hold: '2m',
        latency_metric: 'http_req_duration',
        p95_ms: 1500,
        error_rate: 0.01,
      },
      agent_sse: {
        service: 'stream',
        method: 'POST',
        path: '/v1/agent/sessions/load-session/messages',
        executor: 'ramping-vus',
        peak: 4,
        ramp_up: '20s',
        hold: '1m',
        latency_metric: 'http_req_waiting',
        p95_ms: 1000,
        error_rate: 0.02,
      },
      sync: {
        service: 'admin',
        method: 'POST',
        path: '/admin/v1/order-syncs',
        executor: 'ramping-arrival-rate',
        peak: 2,
        ramp_up: '10s',
        hold: '1m',
        latency_metric: 'http_req_duration',
        p95_ms: 3000,
        error_rate: 0.01,
      },
    },
  };
}

/** The fixture with some fields of one scenario replaced. */
function patched(name: ScenarioName, patch: Partial<ScenarioConfig>): LoadConfig {
  const config = fixture();
  const scenario = config.scenarios[name];
  if (scenario !== undefined) config.scenarios[name] = { ...scenario, ...patch };
  return config;
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(did not throw)';
}

/** Highest load a k6 scenario reaches (stage targets, plus a start rate / start VUs). */
function maxLoad(scenario: K6Scenario | undefined): number {
  if (scenario === undefined) return -1;
  return Math.max(
    ...scenario.stages.map((stage) => stage.target),
    scenario.startRate ?? 0,
    scenario.startVUs ?? 0,
  );
}

/** True when two consecutive stages both sit at `target` (ramp to it, then hold it). */
function plateauAt(scenario: K6Scenario | undefined, target: number): boolean {
  const stages = scenario?.stages ?? [];
  return stages.some((stage, i) => stage.target === target && stages[i + 1]?.target === target);
}

it('[规划/05 QA-06] 合法配置没有问题', () => {
  expect(configProblems(fixture())).toEqual([]);
});

it('[规划/05 QA-06 四个场景] 缺一个场景或多出未登记的场景都是问题', () => {
  const missing = fixture();
  delete missing.scenarios.sync;
  expect(configProblems(missing).length).toBeGreaterThan(0);
  const extra = fixture();
  const scenarios: Record<string, unknown> = extra.scenarios;
  scenarios['orders_list'] = { ...fixture().scenarios.search };
  expect(configProblems(extra).length).toBeGreaterThan(0);
});

it('[规划/05 QA-06 峰值 3 倍] 系数不是 3 是问题；峰值须为正整数', () => {
  for (const multiplier of [1, 2, 2.5, 4]) {
    const config = fixture();
    config.multiplier = multiplier;
    expect(configProblems(config).length, `multiplier ${multiplier}`).toBeGreaterThan(0);
  }
  for (const peak of [0, -1, 1.5]) {
    expect(configProblems(patched('search', { peak })).length, `peak ${peak}`).toBeGreaterThan(0);
  }
});

it('[规划/05 QA-06 阈值] 每个场景都要有 P95 正整数毫秒与 0 到 1 之间（不含端点）的错误率', () => {
  const bad: [string, LoadConfig][] = [
    ['p95 0', patched('convert', { p95_ms: 0 })],
    ['p95 12.5', patched('convert', { p95_ms: 12.5 })],
    ['p95 NaN', patched('convert', { p95_ms: Number.NaN })],
    ['rate 0', patched('sync', { error_rate: 0 })],
    ['rate 1', patched('sync', { error_rate: 1 })],
    ['rate 1.5', patched('sync', { error_rate: 1.5 })],
  ];
  for (const [label, config] of bad) {
    expect(configProblems(config).length, label).toBeGreaterThan(0);
  }
});

it('[09 README §0.2 硬规则 5] 目标只许回环与 WireMock：联盟、百炼、伪装成回环的主机、带凭据与相对主机的路径都是问题', () => {
  const badBases = [
    'https://gw.api.taobao.com',
    'https://api.jd.com',
    'https://dashscope.aliyuncs.com',
    'http://127.0.0.1.nip.io:3000',
    'http://localhost.example.com',
    'http://user:pw@127.0.0.1:3000',
    'http://10.0.0.8:3000',
    'ftp://127.0.0.1',
  ];
  for (const base of badBases) {
    const config = fixture();
    config.base_urls.api = base;
    expect(configProblems(config).length, base).toBeGreaterThan(0);
  }
  for (const path of ['https://gw.api.taobao.com/router/rest', '//api.jd.com/routerjson', 'v1/x']) {
    expect(configProblems(patched('search', { path })).length, path).toBeGreaterThan(0);
  }
  const wiremock = fixture();
  wiremock.base_urls.api = 'http://wiremock:8080';
  expect(configProblems(wiremock)).toEqual([]);
});

it('[规划/05 QA-06] 场景用到的服务必须配了 base URL', () => {
  const config = fixture();
  delete config.base_urls.admin;
  expect(configProblems(config).length).toBeGreaterThan(0);
});

it('[规划/05 QA-06 峰值 3 倍] 请求类场景按每秒到达数加压到峰值×3 并保持；exec 即场景名', () => {
  const options = buildOptions(fixture());
  expect(Object.keys(options.scenarios).sort()).toEqual(['agent_sse', 'convert', 'search', 'sync']);
  const expected: [string, number, string][] = [
    ['search', 21, '2m'],
    ['convert', 15, '2m'],
    ['sync', 6, '1m'],
  ];
  for (const [name, target, hold] of expected) {
    const scenario = options.scenarios[name];
    expect(scenario?.executor, name).toBe('ramping-arrival-rate');
    expect(scenario?.exec, name).toBe(name);
    expect(scenario?.timeUnit, name).toBe('1s');
    expect(maxLoad(scenario), name).toBe(target);
    expect(plateauAt(scenario, target), name).toBe(true);
    expect(scenario?.stages, name).toContainEqual({ duration: hold, target });
    expect(
      Number.isInteger(scenario?.preAllocatedVUs) && (scenario?.preAllocatedVUs ?? 0) > 0,
    ).toBe(true);
  }
});

it('[规划/05 QA-06 Agent SSE] SSE 场景按并发流数（VU）加压到峰值×3 并保持', () => {
  const scenario = buildOptions(fixture()).scenarios['agent_sse'];
  expect(scenario?.executor).toBe('ramping-vus');
  expect(scenario?.exec).toBe('agent_sse');
  expect(maxLoad(scenario)).toBe(12);
  expect(plateauAt(scenario, 12)).toBe(true);
  expect(scenario?.stages).toContainEqual({ duration: '1m', target: 12 });
});

it('[规划/05 QA-06 阈值] 每个场景一条 P95 阈值、一条错误率阈值，按 scenario 标签分开，取值来自配置', () => {
  const thresholds = buildOptions(fixture()).thresholds;
  const perScenario = Object.fromEntries(
    Object.entries(thresholds).filter(([key]) => key.includes('{scenario:')),
  );
  expect(perScenario).toEqual({
    'http_req_duration{scenario:search}': ['p(95)<1500'],
    'http_req_failed{scenario:search}': ['rate<0.01'],
    'http_req_duration{scenario:convert}': ['p(95)<1500'],
    'http_req_failed{scenario:convert}': ['rate<0.01'],
    'http_req_waiting{scenario:agent_sse}': ['p(95)<1000'],
    'http_req_failed{scenario:agent_sse}': ['rate<0.02'],
    'http_req_duration{scenario:sync}': ['p(95)<3000'],
    'http_req_failed{scenario:sync}': ['rate<0.01'],
  });
});

it('[规划/05 QA-06 峰值 3 倍] 不合法的配置不出 options：抛出写明问题的错误', () => {
  const config = fixture();
  config.multiplier = 2;
  const message = thrown(() => buildOptions(config));
  expect(message).not.toMatch(/NotImplemented|did not throw/);
  expect(message.length).toBeGreaterThan(0);
});

it('[09 README §0.2 硬规则 5] 环境变量可把 base URL 改到别的回环端口或 WireMock，改到外部主机就抛错', () => {
  expect(
    resolveBaseUrls(fixture(), {
      LOAD_API_BASE_URL: 'http://127.0.0.1:4000',
      LOAD_STREAM_BASE_URL: 'http://wiremock:8080',
    }),
  ).toEqual({
    api: 'http://127.0.0.1:4000',
    stream: 'http://wiremock:8080',
    admin: 'http://[::1]:3002',
  });
  expect(resolveBaseUrls(fixture(), {})).toEqual({
    api: 'http://127.0.0.1:3000',
    stream: 'http://localhost:3001',
    admin: 'http://[::1]:3002',
  });
  for (const [key, value] of [
    ['LOAD_API_BASE_URL', 'https://gw.api.taobao.com'],
    ['LOAD_STREAM_BASE_URL', 'https://stream.couli.example'],
    ['LOAD_ADMIN_BASE_URL', 'http://127.0.0.1.nip.io'],
  ] as const) {
    const message = thrown(() => resolveBaseUrls(fixture(), { [key]: value }));
    expect(message, value).not.toMatch(/NotImplemented|did not throw/);
  }
});
