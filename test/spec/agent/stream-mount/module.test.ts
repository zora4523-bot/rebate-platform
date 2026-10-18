// B3-03f 第 9 节 7：模块装配（照 test/spec/agent/stream-recovery/module.test.ts：真 Nest、只编译不连库的 Kysely；
// HTTP 用 bootstrap.createHttpApp + init + Fastify inject，不 listen）。
// - stream（有库）：agentStreamToken() 提供运行体；runConfig.maxRunMs === timings.runMaxMs、timings 为
//   runTimingsDefaults()、assertRunTimings 成立、0 < guardPollMs ≤ 5000；texts.errorMsg 取自 texts.default.json；
//   装配不发查询；init 不被 bootstrap 拒绝（stream 的检查计划含 identity 的 token 检查）。
// - stream（无库）：token 为 null，恰一条 info agent_stream_disabled；四条路由已注册，不带 token 的请求（x-auth
//   optional 的游客，不要求签名头）回 JSON 50001；坏 token → 10002（BR-ID-01 ②，证明 token 检查在 stream 上执行）。
// - api：没有该 token，/v1/agent/* 是 404；worker / admin / payout 没有该 token，也不记 agent_stream_disabled。
// - agentStreamProvider(options)（AgentModule.forStream 提供它）：token 为 agentStreamToken()；无库为 null 并记一条
//   agent_stream_disabled；有库时用 app.module 传入的同意读取器（options.consentReader，agent 不引 identity）。
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';

import {
  assertRunTimings,
  runTimingsDefaults,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  agentStreamProvider,
  agentStreamToken,
  type AgentStreamRuntime,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { ports } from '../../risk/freeze-expiry/kit.ts';
import { LEVEL, fileErrorMsg, loadConsentReader } from './kit.ts';

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

function compileOnlyDb(queries: string[]): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
  databases.push(db);
  return db;
}

interface Injected {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<void>;
  get(token: unknown, options?: { strict: boolean }): unknown;
  inject(options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<Injected>;
}
interface Context {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

async function setup(withDb: boolean) {
  // Loaded by URL (as the B3-03h module test does): bootstrap and app.module pull in the Nest
  // controllers, which the `test` project does not compile.
  const boot = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
    createWorkerContext(entry: string, overrides: object): Promise<Context>;
  };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const p = await ports();
  const queries: string[] = [];
  const queue = {
    send: vi.fn(async () => 'fixture'),
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const overrides = {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: p.clock,
    logger: p.logger,
    ...(withDb
      ? { dbHandles: { db: compileOnlyDb(queries), dbRead: null, close: async () => undefined } }
      : {}),
  };
  const lines = () => p.lines.map((line) => JSON.parse(line) as { level: number; msg: string });
  return { boot, overrides, queries, lines };
}

/** The four B3-03d operations, as requests without a token (a guest of X-App-Id). */
function agentRequests() {
  // Orchestrator mechanical fix (2026-10-18): the contract's required client headers.
  const client = {
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
    'x-device-id': randomUUID(),
  };
  const headers = { 'x-app-id': 'couli', ...client, 'content-type': 'application/json' };
  return [
    { method: 'POST', url: '/v1/agent/sessions', headers },
    {
      method: 'GET',
      url: '/v1/agent/sessions/current',
      headers: { 'x-app-id': 'couli', ...client },
    },
    {
      method: 'POST',
      url: `/v1/agent/sessions/${randomUUID()}/messages`,
      headers,
      payload: { client_msg_id: randomUUID(), text: '提现记录在哪看' },
    },
    { method: 'POST', url: `/v1/agent/runs/${randomUUID()}/cancel`, headers },
  ];
}

function codeOf(response: Injected): unknown {
  return (JSON.parse(response.body) as { code?: unknown }).code;
}

it('[AC-B3-03f#12][BR-AI-23] stream 入口（有库）：agentStreamToken() 提供运行体；maxRunMs = timings.runMaxMs、timings = runTimingsDefaults()、assertRunTimings 成立、0 < guardPollMs ≤ 5000；errorMsg 取自 texts.default.json；init 不被拒、装配不发查询', async () => {
  const { boot, overrides, queries, lines } = await setup(true);
  const app = await boot.createHttpApp('stream', overrides);
  try {
    await app.init();
    const runtime = app.get(agentStreamToken(), { strict: false }) as AgentStreamRuntime;
    expect(runtime).not.toBeNull();
    expect(typeof runtime.http.sendMessage).toBe('function');
    expect(typeof runtime.close).toBe('function');
    expect(runtime.timings).toEqual(runTimingsDefaults());
    expect(runtime.runConfig.maxRunMs).toBe(runtime.timings.runMaxMs);
    expect(runtime.runConfig.guardPollMs).toBeGreaterThan(0);
    expect(runtime.runConfig.guardPollMs).toBeLessThanOrEqual(5_000);
    expect(() =>
      assertRunTimings({
        ...runtime.timings,
        admissionRunMaxMs: runtime.runConfig.maxRunMs,
        sweepMarginMs: 0,
      }),
    ).not.toThrow();
    for (const code of [50001, 30501, 10004]) {
      expect(runtime.texts.errorMsg(code), String(code)).toBe(fileErrorMsg(code));
    }
    expect(typeof runtime.limits.current).toBe('function');
    expect(queries.filter((q) => /agent_|consent_records|config_items/.test(q))).toEqual([]);
    expect(lines().filter((l) => l.msg === 'agent_stream_disabled')).toEqual([]);
    expect(app.get(agentStreamToken(), { strict: false })).toBe(runtime);
  } finally {
    await app.close();
  }
}, 60_000);

it('[AC-B3-03f#13][BR-AI-23][BR-ID-01] stream 入口（无库）：token 为 null、恰一条 info agent_stream_disabled；四条路由已注册，不带 token、不带签名头的游客请求回 JSON 50001；坏 token → 10002', async () => {
  const { boot, overrides, lines } = await setup(false);
  const app = await boot.createHttpApp('stream', overrides);
  try {
    await app.init();
    expect(app.get(agentStreamToken(), { strict: false })).toBeNull();
    const disabled = lines().filter((l) => l.msg === 'agent_stream_disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.level).toBe(LEVEL.info);
    for (const request of agentRequests()) {
      const response = await app.inject(request);
      const what = `${request.method} ${request.url}`;
      expect(response.statusCode, what).not.toBe(404);
      expect(String(response.headers['content-type']), what).toContain('application/json');
      expect(codeOf(response), what).toBe(50001);
    }
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/agent/sessions',
      headers: { 'x-app-id': 'couli', authorization: 'Bearer not-a-real-token' },
    });
    expect(bad.statusCode).toBe(401);
    expect(codeOf(bad)).toBe(10002);
  } finally {
    await app.close();
  }
}, 60_000);

it('[AC-B3-03f#14] api 入口不挂 /v1/agent/*（404）也没有 agentStreamToken()；worker / admin / payout 同样没有该 token；都不记 agent_stream_disabled', async () => {
  const token = agentStreamToken();
  {
    const { boot, overrides, lines } = await setup(true);
    const app = await boot.createHttpApp('api', overrides);
    try {
      await app.init();
      expect(() => app.get(token, { strict: false })).toThrow();
      for (const request of agentRequests()) {
        const response = await app.inject(request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
      }
      expect(lines().filter((l) => l.msg === 'agent_stream_disabled')).toEqual([]);
    } finally {
      await app.close();
    }
    vi.restoreAllMocks();
  }
  for (const entry of ['worker', 'admin', 'payout']) {
    const { boot, overrides, lines } = await setup(true);
    const context = await boot.createWorkerContext(entry, overrides);
    try {
      expect(() => context.get(token, { strict: false }), entry).toThrow();
      expect(
        lines().filter((l) => l.msg === 'agent_stream_disabled'),
        entry,
      ).toEqual([]);
    } finally {
      await context.close();
    }
    vi.restoreAllMocks();
  }
}, 60_000);

it('[AC-B3-03f#15][BR-AI-13] agentStreamProvider(options)：provide 为 agentStreamToken()（同一个 symbol）；无库为 null 并记一条 agent_stream_disabled；有库时用 options.consentReader（app.module 传入的 identity 同意读取器）建同意端口', async () => {
  const token = agentStreamToken();
  expect(typeof token).toBe('symbol');
  expect(agentStreamToken()).toBe(token);
  const identityReader = await loadConsentReader();
  const consentReader = vi.fn(identityReader);
  const provider = agentStreamProvider({ consentReader });
  expect(provider.provide).toBe(token);
  const factory = provider.useFactory as (...args: unknown[]) => unknown;

  const p = await ports();
  const lines = () => p.lines.map((line) => JSON.parse(line) as { level: number; msg: string });
  expect(factory(p.clock, p.logger, undefined, undefined)).toBeNull();
  expect(lines().filter((l) => l.msg === 'agent_stream_disabled')).toHaveLength(1);
  expect(consentReader).not.toHaveBeenCalled();

  const queries: string[] = [];
  const db = compileOnlyDb(queries);
  const runtime = factory(p.clock, p.logger, db, undefined) as AgentStreamRuntime;
  expect(typeof runtime.http.createSession).toBe('function');
  expect(consentReader).toHaveBeenCalledTimes(1);
  const [options] = consentReader.mock.calls[0]!;
  expect(options.db).toBe(db);
  expect(typeof options.currentVersion).toBe('function');
  expect(queries).toEqual([]);
});
