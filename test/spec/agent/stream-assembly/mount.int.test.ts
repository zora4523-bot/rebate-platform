// The real composition root must pass business ports, and the provider/runtime must consume
// them. The legacy four-argument provider still builds without business ports or startup I/O.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  agentStreamProvider,
  agentStreamToken,
  type AgentStreamModuleOptions,
  type AgentStreamRuntime,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { AgentModule } from '../../../../apps/api/src/modules/agent/agent.module.ts';
import {
  framesOf,
  message,
  newGuest,
  openSession,
  send,
  usePgEach,
  type Row,
} from '../stream-mount/kit.ts';
import { APP, fixture } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-03j#10] 可选工厂缺省保持旧挂载；提供后 provider 必须使用同一 tools/intents/deterministic/texts', async () => {
  const f = await fixture(pg.db);
  const body = vi.spyOn(core, 'createAgentRunBody');
  const legacy = agentStreamProvider({ consentReader: f.consentReader }).useFactory(
    f.time.clock,
    f.logs.logger,
    pg.db,
    undefined,
  ) as AgentStreamRuntime;
  try {
    expect(body).toHaveBeenCalledTimes(1);
    expect(await body.mock.calls[0]![0].tools.definitions(APP, f.caller)).toEqual([]);
    expect(body.mock.calls[0]![0].deterministic).toBeUndefined();
  } finally {
    await legacy.close();
  }

  const assembly = f.build();
  const factory = vi.fn(() => assembly);
  const wired = agentStreamProvider({
    consentReader: f.consentReader,
    assembly: factory,
  }).useFactory(f.time.clock, f.logs.logger, pg.db, undefined) as AgentStreamRuntime;
  try {
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ db: pg.db, clock: f.time.clock, logger: f.logs.logger }),
    );
    expect(body.mock.calls.at(-1)?.[0]).toMatchObject({
      tools: assembly.tools,
      intents: assembly.intents,
      deterministic: assembly.deterministic,
      texts: assembly.texts,
    });
    // New optional ports do not bypass the still fail-closed input check (B3-03m owns it).
    const r = { runtime: wired, time: f.time, logs: f.logs };
    const sessionId = await openSession(r, f.caller);
    expect(
      framesOf((await send(r, f.caller, sessionId, message('保温杯'))).chunks).at(-1)?.data[
        'finish_reason'
      ],
    ).toBe('safety');
    expect(f.searchProducts).not.toHaveBeenCalled();
  } finally {
    await wired.close();
  }
}, 120_000);

interface App {
  init(): Promise<unknown>;
  close(): Promise<void>;
  get(token: unknown, options: { strict: boolean }): unknown;
  inject(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: unknown;
  }): Promise<{ statusCode: number; body: string }>;
}

it('[AC-B3-03j#11][BR-AI-02] 真实 stream AppModule + PG：生产 forStream 提供业务工厂并挂入 core，HTTP 路由仍可用', async () => {
  const guest = await newGuest(pg.db);
  const f = await fixture(pg.db, guest);
  const options: AgentStreamModuleOptions[] = [];
  const originalStream = AgentModule.forStream.bind(AgentModule);
  vi.spyOn(AgentModule, 'forStream').mockImplementation((value) => {
    options.push(value);
    return originalStream(value);
  });
  const body = vi.spyOn(core, 'createAgentRunBody');
  const src = (path: string) => new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
  const boot = (await import(src('bootstrap.ts'))) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
  };
  const platform = (await import(src('modules/platform/index.ts'))) as {
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  };
  const originalPlatform = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((value) => {
    const module = originalPlatform(value);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === platform.JOB_QUEUE
          ? {
              provide: platform.JOB_QUEUE,
              useValue: {
                send: async () => null,
                register: vi.fn(),
                start: async () => undefined,
                stop: async () => undefined,
              },
            }
          : provider,
      ),
    };
  });
  const app = await boot.createHttpApp('stream', {
    config: platform.loadConfig({ APP_ENV: 'test' }),
    clock: f.time.clock,
    logger: f.logs.logger,
    dbHandles: { db: pg.db, dbRead: null, close: async () => undefined },
  });
  try {
    await app.init();
    expect(options).toHaveLength(1);
    expect(options[0]?.assembly).toBeTypeOf('function');
    expect(app.get(agentStreamToken(), { strict: false })).not.toBeNull();
    expect(body).toHaveBeenCalledTimes(1);
    const mounted = body.mock.calls[0]![0];
    expect(mounted.intents).toBeDefined();
    expect(mounted.deterministic).toBeDefined();
    expect((await mounted.tools.definitions(APP, guest)).map((d) => d.name)).toEqual(
      expect.arrayContaining(['search_products', 'get_rebate_quote']),
    );
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent/sessions',
      headers: {
        'x-app-id': APP,
        'x-device-id': guest.deviceId,
        'x-platform': 'ios',
        'x-channel': 'appstore',
        'x-app-version': '2.0.0',
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect((JSON.parse(created.body) as Row)['code']).toBe(0);
  } finally {
    await app.close();
  }
}, 120_000);
