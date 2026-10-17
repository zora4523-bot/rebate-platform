// B3-03f 真实挂载（BR-AI-13、BR-AI-23；BR-ID-01 ② ③）：真实 AppModule.forEntry({entry: 'stream'})（经
// bootstrap.createHttpApp，不 listen）+ 真 PG，用 Fastify inject 发真实 HTTP 请求，不直接调 runtime.http：
// - 已同意的登录用户带有效 access token（identity 的 TOKEN_SERVICE 在 stream 入口签发与校验）：建会话、取当前会话、
//   发消息（SSE，生产默认装配下 done(safety)）、取消已结束的 run（30505）——四条路由都不回 50001，会话与 run
//   落在令牌主体（user_id）名下，证明主体经 token 检查走进了 runtime；
// - 撤回同意后（插入 accepted=false），四条路由（含 GET）都回 10004（consent_type=ai_third_party），不建会话、
//   不建 run。
// - 游客与设备主体（BR-AI-13）：不带 token、带设备身份（X-Device-Id，契约 createAgentSession：无 token 时为
//   本设备）的游客，设备级同意已写入 → 受理（会话 user_id 为空、device_id 为该设备）；同一设备登录后（用户级无同意）
//   → 10004 且无副作用；写用户级同意后该设备受理，同一账号换设备也受理（会话都在该用户名下）。
// - require_phone（BR-AI-23 ②、BR-ID-03）：开启后游客 10001、未绑手机账号 10005、已绑手机账号受理；绑手机取自
//   users.phone_hmac / phone_cipher，不由夹具注入。
// - 白名单（BR-AI-23 ①、BR-AI-12）：whitelist_only=true 时名单外 30501、名单外且未同意仍 30501（不是 10004）、
//   名单内受理；运行中把 whitelist_only 打开，5 s 后名单外用户的新请求即 30501。
// - 游客额度键（BR-AI-23 ⑩、BR-AI-15、BR-ID-03；B3-03g quotaSubjects）：游客与未绑手机账号按设备与 IP 两个计数，
//   键由挂载层从真实请求推出（设备取自设备身份，IP 取自来源地址，不是明文 IP）。同设备换 IP：设备键相同、IP 键
//   不同；换设备同 IP：设备键不同、IP 键相同；未绑手机账号也只有设备与 IP 两个键。guest_daily_quota 与
//   guest_ip_daily_quota 设为 1 后，把一条 run 记为已计入（生产默认装配每条都退还，夹具改 settle_result 模拟
//   消耗），同设备换 IP → 30502、换设备同 IP → 30502，均不建 run；换设备且换 IP 照常受理。
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  APP,
  Logs,
  agentSnapshot,
  anotherDevice,
  consent,
  framesOf,
  loginOnDevice,
  newGuest,
  newMember,
  openAgent,
  runsOf,
  sessionRow,
  setConfig,
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
    remoteAddress?: string;
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

function client(app: App, token: string, remoteAddress?: string) {
  const headers = { 'x-app-id': APP, authorization: `Bearer ${token}` };
  return (method: string, url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
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

type Call = (method: string, url: string, body?: unknown) => Promise<Injected>;

/** A guest request: no token, the device identity of the caller's devices row. */
function guestClient(app: App, caller: AgentCaller, remoteAddress?: string): Call {
  const headers = {
    'x-app-id': caller.appId,
    'x-device-id': caller.deviceId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  return (method, url, body) =>
    app.inject({
      method,
      url,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
}

async function memberClient(
  app: App,
  clock: FixedClock,
  caller: AgentCaller,
  remoteAddress?: string,
): Promise<Call> {
  return client(app, await accessToken(app, clock, caller), remoteAddress);
}

/** createSession then sendMessage, both accepted; the session is owned as expected. */
async function expectAccepted(
  call: Call,
  owner: { userId: string | null; deviceId?: string },
  what: string,
): Promise<string> {
  const created = await call('POST', '/v1/agent/sessions');
  const createdBody = json(created);
  expect(createdBody['code'], `${what}: ${created.body}`).toBe(0);
  const sessionId = (createdBody['data'] as Record<string, unknown>)['session_id'] as string;
  const session = await sessionRow(pg.db, sessionId);
  expect(session['user_id'], what).toBe(owner.userId);
  if (owner.deviceId !== undefined) expect(session['device_id'], what).toBe(owner.deviceId);
  const sent = await call('POST', `/v1/agent/sessions/${sessionId}/messages`, {
    client_msg_id: randomUUID(),
    text: '帮我找个保温杯',
  });
  expect(sent.statusCode, `${what}: ${sent.body}`).toBe(200);
  expect(String(sent.headers['content-type']), what).toContain('text/event-stream');
  const frames = framesOf([sent.body]);
  expect(frames[0]!.event, what).toBe('meta');
  expect(frames[frames.length - 1]!.event, what).toBe('done');
  expect(await runsOf(pg.db, sessionId), what).toHaveLength(1);
  return sessionId;
}

/** createSession and sendMessage both refused with `code`; no agent_* row written. */
async function expectRefused(call: Call, code: number, what: string): Promise<void> {
  const before = await agentSnapshot(pg.db);
  const created = await call('POST', '/v1/agent/sessions');
  expect(json(created)['code'], `${what}: ${created.body}`).toBe(code);
  const sent = await call('POST', `/v1/agent/sessions/${randomUUID()}/messages`, {
    client_msg_id: randomUUID(),
    text: '帮我找个保温杯',
  });
  expect(json(sent)['code'], `${what}: ${sent.body}`).toBe(code);
  expect(await agentSnapshot(pg.db), what).toBe(before);
}

it('[AC-B3-03f#24][BR-AI-13] 真实 stream 入口 + PG：带设备身份的游客（设备级同意）受理；同一设备登录后用户级无同意 → 10004、无副作用；写用户级同意后该设备受理，同一账号换设备仍受理', async () => {
  const clock = new FixedClock('2026-10-06T10:00:00+08:00');
  await openAgent(pg.db);
  const guest = await newGuest(pg.db);
  await consent(pg.db, guest);
  const account = await newMember(pg.db);
  const app = await streamApp(clock);
  try {
    await expectAccepted(
      guestClient(app, guest),
      { userId: null, deviceId: guest.deviceId },
      'guest with device consent',
    );

    // The same device after login: the guest's device consent is not inherited.
    const loggedIn = await loginOnDevice(pg.db, guest, account);
    const onSameDevice = await memberClient(app, clock, loggedIn);
    await expectRefused(onSameDevice, 10004, 'logged in, no user-level consent');

    await consent(pg.db, loggedIn);
    await expectAccepted(onSameDevice, { userId: account.userId }, 'user consent, same device');

    // The same account on another device: the user-level consent holds there too.
    const second = await anotherDevice(pg.db, loggedIn);
    await expectAccepted(
      await memberClient(app, clock, second),
      { userId: account.userId },
      'user consent, another device',
    );
  } finally {
    await app.close();
  }
}, 120_000);

it('[AC-B3-03f#25][BR-AI-23][BR-ID-03] 真实 stream 入口 + PG：agent.require_phone=true 时游客 10001、已登录未绑手机 10005（无副作用）、已绑手机照常受理', async () => {
  const clock = new FixedClock('2026-10-06T10:00:00+08:00');
  await openAgent(pg.db);
  await setConfig(pg.db, APP, 'agent.require_phone', true);
  const guest = await newGuest(pg.db);
  const unbound = await newMember(pg.db, { phoneBound: false });
  const bound = await newMember(pg.db);
  for (const caller of [guest, unbound, bound]) await consent(pg.db, caller);
  const app = await streamApp(clock);
  try {
    await expectRefused(guestClient(app, guest), 10001, 'guest');
    await expectRefused(await memberClient(app, clock, unbound), 10005, 'no bound phone');
    await expectAccepted(
      await memberClient(app, clock, bound),
      { userId: bound.userId },
      'bound phone',
    );
  } finally {
    await app.close();
  }
}, 120_000);

it('[AC-B3-03f#26][BR-AI-23][BR-AI-12] 真实 stream 入口 + PG：whitelist_only=true 时名单外 30501、名单外且未同意仍 30501（不是 10004），均无副作用；名单内照常受理', async () => {
  const clock = new FixedClock('2026-10-06T10:00:00+08:00');
  await openAgent(pg.db);
  const listed = await newMember(pg.db);
  const unlisted = await newMember(pg.db);
  const unlistedNoConsent = await newMember(pg.db);
  await consent(pg.db, listed);
  await consent(pg.db, unlisted);
  await setConfig(pg.db, APP, 'agent.whitelist_only', true);
  await setConfig(pg.db, APP, 'agent.whitelist_user_ids', [listed.userId]);
  const app = await streamApp(clock);
  try {
    await expectRefused(await memberClient(app, clock, unlisted), 30501, 'unlisted');
    await expectRefused(
      await memberClient(app, clock, unlistedNoConsent),
      30501,
      'unlisted without consent',
    );
    await expectAccepted(
      await memberClient(app, clock, listed),
      { userId: listed.userId },
      'listed',
    );
  } finally {
    await app.close();
  }
}, 120_000);

it('[AC-B3-03f#27][BR-AI-12] 真实 stream 入口 + PG：运行中打开 whitelist_only，5 s 后名单外用户的新消息与建会话都 30501、不建 run', async () => {
  const clock = new FixedClock('2026-10-06T10:00:00+08:00');
  await openAgent(pg.db);
  await setConfig(pg.db, APP, 'agent.whitelist_user_ids', []);
  const caller = await newMember(pg.db);
  await consent(pg.db, caller);
  const app = await streamApp(clock);
  try {
    const call = await memberClient(app, clock, caller);
    // Open: this reads (and caches) whitelist_only = false now.
    const created = await call('POST', '/v1/agent/sessions');
    expect(json(created)['code'], created.body).toBe(0);
    const sessionId = (json(created)['data'] as Record<string, unknown>)['session_id'] as string;

    await setConfig(pg.db, APP, 'agent.whitelist_only', true);
    clock.advanceMs(5_000);
    const sent = await call('POST', `/v1/agent/sessions/${sessionId}/messages`, {
      client_msg_id: randomUUID(),
      text: '帮我找个保温杯',
    });
    expect(json(sent)['code'], sent.body).toBe(30501);
    expect(await runsOf(pg.db, sessionId)).toEqual([]);
    expect(json(await call('POST', '/v1/agent/sessions'))['code']).toBe(30501);
  } finally {
    await app.close();
  }
}, 120_000);

/** quota_subjects of the single run of a session, parsed: [kind, key] pairs. */
async function subjectsOf(sessionId: string): Promise<[string, string][]> {
  const runs = await runsOf(pg.db, sessionId);
  expect(runs).toHaveLength(1);
  return (runs[0]!['quota_subjects'] as string[]).map((s) => JSON.parse(s) as [string, string]);
}

/**
 * A finished run on `sessionId` that counts against the quota (settle_result 'counted'), with the
 * same quota_subjects as the session's existing run; accepted a minute before `clock` (the same
 * day). Columns as B3-03g's acceptance writes them, within every agent_runs constraint.
 */
async function insertCountedRun(clock: FixedClock, sessionId: string): Promise<void> {
  const [source] = await runsOf(pg.db, sessionId);
  expect(source, `the run of ${sessionId}`).toBeDefined();
  const now = clock.now();
  const acceptedAt = new Date(now.getTime() - 60_000);
  const hex = randomUUID().replace(/-/g, '');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  await pg.db
    .insertInto('agent_runs')
    .values({
      id,
      app_id: APP,
      session_id: sessionId,
      prompt_version: 'none',
      accepted_at: acceptedAt,
      deadline_at: new Date(acceptedAt.getTime() + 20_000),
      quota_subjects: source!['quota_subjects'] as string[],
      end_reason: 'stop',
      finish_reason: 'stop',
      settle_result: 'counted',
      settled_at: now,
      final_event: sql`${JSON.stringify({ type: 'done', data: { finish_reason: 'stop' } })}::jsonb`,
      ended_at: now,
    })
    .execute();
}

function keyOf(subjects: readonly [string, string][], kind: string): string {
  const found = subjects.filter(([k]) => k === kind);
  expect(found, `one ${kind} subject`).toHaveLength(1);
  return found[0]![1];
}

it('[AC-B3-03f#28][BR-AI-23][BR-AI-15][BR-ID-03] 真实 stream 入口 + PG：游客与未绑手机账号按设备与 IP 两个键计数——同设备换 IP 设备键同、IP 键异，换设备同 IP 反之；设备或 IP 任一达上限（各为 1）→ 30502、不建 run，换设备且换 IP 照常受理', async () => {
  const clock = new FixedClock('2026-10-06T10:00:00+08:00');
  await openAgent(pg.db);
  await setConfig(pg.db, APP, 'agent.guest_daily_quota', 1);
  await setConfig(pg.db, APP, 'agent.guest_ip_daily_quota', 1);
  const a = await newGuest(pg.db);
  const b = await newGuest(pg.db);
  const c = await newGuest(pg.db);
  const unbound = await newMember(pg.db, { phoneBound: false });
  for (const caller of [a, b, c, unbound]) await consent(pg.db, caller);
  // TEST-NET-3 addresses (RFC 5737), never real clients.
  const IP1 = '203.0.113.11';
  const IP2 = '203.0.113.12';
  const IP3 = '203.0.113.13';
  const IP4 = '203.0.113.14';
  const IP5 = '203.0.113.15';
  const IP6 = '203.0.113.16';
  const app = await streamApp(clock);
  try {
    // Every run of the production assembly is refunded, so nothing is consumed yet.
    const a1 = await expectAccepted(guestClient(app, a, IP1), { userId: null }, 'a@IP1');
    const a2 = await expectAccepted(guestClient(app, a, IP2), { userId: null }, 'a@IP2');
    const b1 = await expectAccepted(guestClient(app, b, IP1), { userId: null }, 'b@IP1');
    const sa1 = await subjectsOf(a1);
    const sa2 = await subjectsOf(a2);
    const sb1 = await subjectsOf(b1);
    for (const subjects of [sa1, sa2, sb1]) {
      expect(subjects.map(([kind]) => kind).sort()).toEqual(['device', 'ip']);
      expect(JSON.stringify(subjects)).not.toContain('203.0.113.');
    }
    expect(keyOf(sa2, 'device'), 'same device, other IP').toBe(keyOf(sa1, 'device'));
    expect(keyOf(sa2, 'ip'), 'same device, other IP').not.toBe(keyOf(sa1, 'ip'));
    expect(keyOf(sb1, 'device'), 'other device, same IP').not.toBe(keyOf(sa1, 'device'));
    expect(keyOf(sb1, 'ip'), 'other device, same IP').toBe(keyOf(sa1, 'ip'));

    // Consume: one more run, already counted, with the same subjects as a's first run (device a,
    // IP1). Settled runs are write-once (agent_runs_no_rewrite), so it is inserted, not updated.
    await insertCountedRun(clock, a1);

    const before = await agentSnapshot(pg.db);
    for (const [caller, ip, what] of [
      [a, IP3, 'same device, new IP: device limit'],
      [b, IP1, 'other device, same IP: IP limit'],
    ] as const) {
      const sent = await guestClient(app, caller, ip)(
        'POST',
        `/v1/agent/sessions/${caller === a ? a2 : b1}/messages`,
        { client_msg_id: randomUUID(), text: '帮我找个保温杯' },
      );
      expect(json(sent)['code'], `${what}: ${sent.body}`).toBe(30502);
    }
    expect(await agentSnapshot(pg.db)).toBe(before);
    await expectAccepted(guestClient(app, c, IP4), { userId: null }, 'new device, new IP');

    // An account without a bound phone counts as a guest: device and IP, no member key; its
    // device limit applies the same way (a new IP does not reset it).
    const token = await accessToken(app, clock, unbound);
    const u1 = await expectAccepted(client(app, token, IP5), { userId: unbound.userId }, 'u@IP5');
    const su1 = await subjectsOf(u1);
    expect(su1.map(([kind]) => kind).sort()).toEqual(['device', 'ip']);
    expect(keyOf(su1, 'device')).not.toBe(keyOf(sa1, 'device'));
    await insertCountedRun(clock, u1);
    const again = await client(app, token, IP6)('POST', `/v1/agent/sessions/${u1}/messages`, {
      client_msg_id: randomUUID(),
      text: '帮我找个保温杯',
    });
    expect(json(again)['code'], again.body).toBe(30502);
    expect(
      await runsOf(pg.db, u1),
      'the accepted run and the counted one, no new run',
    ).toHaveLength(2);
  } finally {
    await app.close();
  }
}, 120_000);
