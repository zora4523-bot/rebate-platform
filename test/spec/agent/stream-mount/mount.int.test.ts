// B3-03f 真实挂载（BR-AI-13、BR-AI-23；BR-ID-01 ② ③）：真实 AppModule.forEntry({entry: 'stream'})（经
// bootstrap.createHttpApp，不 listen）+ 真 PG，用 Fastify inject 发真实 HTTP 请求，不直接调 runtime.http：
// - 已同意的登录用户带有效 access token（identity 的 TOKEN_SERVICE 在 stream 入口签发与校验）：建会话、取当前会话、
//   发消息（SSE，生产默认装配下 done(safety)）、取消已结束的 run（30505）——四条路由都不回 50001，会话与 run
//   落在令牌主体（user_id）名下，证明主体经 token 检查走进了 runtime；
// - 撤回同意后（插入 accepted=false），四条路由（含 GET）都回 10004（consent_type=ai_third_party），不建会话、
//   不建 run。
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  APP,
  Logs,
  agentSnapshot,
  consent,
  framesOf,
  newMember,
  openAgent,
  runsOf,
  sessionRow,
  usePgEach,
} from './kit.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';

const pg = usePgEach(createTestDatabase);

afterEach(() => {
  vi.restoreAllMocks();
});

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
    payload?: string;
  }): Promise<Injected>;
}

const src = (path: string): string =>
  new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;

/** The real stream entry over this test's database (no listen; the job queue is a stand-in). */
async function streamApp(clock: FixedClock): Promise<App> {
  const boot = (await import(src('bootstrap.ts'))) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
  };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    src('modules/platform/index.ts')
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
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
  const app = await boot.createHttpApp('stream', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger: new Logs().logger,
    // The test owns the pool (usePgEach destroys it): closing the app leaves it open.
    dbHandles: { db: pg.db, dbRead: null, close: async () => undefined },
  });
  await app.init();
  return app;
}

/** A live session of the caller, issued by the stream entry's own token service. */
async function accessToken(app: App, clock: FixedClock, caller: AgentCaller): Promise<string> {
  const { TOKEN_SERVICE } = (await import(src('modules/identity/application/tokens.ts'))) as {
    TOKEN_SERVICE: symbol;
  };
  const { createSession } = (await import(
    src('modules/identity/application/sessions.ts')
  )) as typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
  type Tokens = Parameters<typeof createSession>[2]['tokens'];
  let tokens: Tokens | undefined;
  try {
    tokens = app.get(TOKEN_SERVICE, { strict: false }) as Tokens;
  } catch {
    // Unwired: the stream entry must run identity's token check, so it holds its token service.
  }
  expect(tokens, "the stream entry provides identity's TOKEN_SERVICE").toBeDefined();
  const session = await pg.db
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid: caller.userId!, app_id: caller.appId, device_id: caller.deviceId, scp: 'full' },
        { clock, tokens: tokens! },
      ),
    );
  return session.access_token;
}

function client(app: App, token: string) {
  const headers = { 'x-app-id': APP, authorization: `Bearer ${token}` };
  return (method: string, url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
}

function json(response: Injected): Record<string, unknown> {
  expect(String(response.headers['content-type'])).toContain('application/json');
  return JSON.parse(response.body) as Record<string, unknown>;
}

it('[AC-B3-03f#22][BR-AI-23][BR-ID-01] 真实 stream 入口 + PG：已同意的登录用户带有效 token 建会话、取当前会话、发消息（SSE done(safety)）、取消已结束 run（30505）；四条路由都不回 50001，会话与 run 落在令牌主体名下', async () => {
  const clock = new FixedClock('2026-10-06T10:00:00+08:00');
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  const app = await streamApp(clock);
  try {
    const call = client(app, await accessToken(app, clock, caller));

    const created = await call('POST', '/v1/agent/sessions');
    const createdBody = json(created);
    expect(created.statusCode, created.body).toBe(200);
    expect(createdBody['code']).toBe(0);
    const sessionId = (createdBody['data'] as Record<string, unknown>)['session_id'] as string;
    const session = await sessionRow(pg.db, sessionId);
    expect(session).toMatchObject({ app_id: APP, user_id: caller.userId });

    const current = await call('GET', '/v1/agent/sessions/current');
    const currentBody = json(current);
    expect(current.statusCode, current.body).toBe(200);
    expect(currentBody['code']).toBe(0);
    expect(JSON.stringify(currentBody['data'])).toContain(sessionId);

    const sent = await call('POST', `/v1/agent/sessions/${sessionId}/messages`, {
      client_msg_id: randomUUID(),
      text: '帮我找个保温杯',
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(String(sent.headers['content-type'])).toContain('text/event-stream');
    const frames = framesOf([sent.body]);
    expect(frames[0]!.event).toBe('meta');
    const last = frames[frames.length - 1]!;
    expect(last.event).toBe('done');
    expect(last.data['finish_reason']).toBe('safety');
    const runs = await runsOf(pg.db, sessionId);
    expect(runs.map((r) => r['id'])).toEqual([frames[0]!.data['run_id']]);

    const cancelled = await call('POST', `/v1/agent/runs/${String(runs[0]!['id'])}/cancel`);
    expect(json(cancelled)['code']).toBe(30505);

    for (const response of [created, current, cancelled]) {
      expect(json(response)['code']).not.toBe(50001);
    }
  } finally {
    await app.close();
  }
}, 120_000);

it('[AC-B3-03f#23][BR-AI-13] 真实 stream 入口 + PG：撤回同意后四条路由（含 GET）都回 10004（consent_type=ai_third_party），不建会话、不建 run', async () => {
  const clock = new FixedClock('2026-10-06T10:00:00+08:00');
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  await consent(pg.db, caller, { accepted: false });
  const app = await streamApp(clock);
  try {
    const call = client(app, await accessToken(app, clock, caller));
    const before = await agentSnapshot(pg.db);
    const responses = [
      await call('POST', '/v1/agent/sessions'),
      await call('GET', '/v1/agent/sessions/current'),
      await call('POST', `/v1/agent/sessions/${randomUUID()}/messages`, {
        client_msg_id: randomUUID(),
        text: '帮我找个保温杯',
      }),
      await call('POST', `/v1/agent/runs/${randomUUID()}/cancel`),
    ];
    for (const response of responses) {
      const body = json(response);
      expect(body['code'], response.body).toBe(10004);
      expect(body['data']).toEqual({ consent_type: 'ai_third_party' });
    }
    expect(await agentSnapshot(pg.db)).toBe(before);
  } finally {
    await app.close();
  }
}, 120_000);
