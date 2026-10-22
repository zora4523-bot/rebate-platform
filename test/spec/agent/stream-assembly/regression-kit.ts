import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { AgentModule } from '../../../../apps/api/src/modules/agent/agent.module.ts';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { openCardCall } from '../../../../apps/api/src/modules/agent/orchestrator/core/card-references.ts';
import {
  agentStreamToken,
  type AgentStreamModuleOptions,
  type AgentStreamRuntime,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import * as mountTexts from '../../../../apps/api/src/modules/agent/stream/mount/texts.ts';
import * as businessAssembly from '../../../../apps/api/src/modules/agent/stream/mount/assembly.ts';
import { APP, newGuest, setConfig } from '../stream-mount/kit.ts';
import { fixture, passInput } from './kit.ts';

export async function callTool(
  tools: core.OrchestratorTools,
  context: core.ToolContext,
  name: string,
  args: unknown,
) {
  const id = randomUUID();
  const scope = openCardCall(id, context.placeholders);
  try {
    return await tools.execute({ id, name, args }, context);
  } finally {
    scope.close();
  }
}

interface StreamApp {
  init(): Promise<unknown>;
  close(): Promise<void>;
  get(token: unknown, options: { strict: boolean }): unknown;
}

// Called in each test body so a missing assembly fails an assertion, never an import or hook.
// Boot the real AppModule and keep its runtime and business ports intact. Only the pending
// input check/copy and unrelated background queue are substituted (B3-03j §9, B3-03m).
export async function production(db: Kysely<DB>, routes: readonly string[] = ['Wallet']) {
  const caller = await newGuest(db);
  const f = await fixture(db, caller);
  for (const [key, value] of [
    ['agent.page_guide.routes', routes],
    ['search.enabled.jd', false],
    ['search.enabled.pdd', false],
    ['parse.enabled.taobao', true],
    ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
    ['rebate.taobao.compare_rate_ratio_bp', 5000],
    ['demo.rebate_quote_rule', { reserve_bp: 0, self_share_bp: 10000 }],
  ] as const)
    await setConfig(db, APP, key, value);
  await db
    .updateTable('platforms')
    .set({
      search_support: 'supported',
      key_stability: 'stable_24h',
      updated_at: f.time.clock.now(),
    })
    .where('code', '=', 'taobao')
    .execute();

  const options: AgentStreamModuleOptions[] = [];
  const originalStream = AgentModule.forStream.bind(AgentModule);
  vi.spyOn(AgentModule, 'forStream').mockImplementation((value) => {
    options.push(value);
    return originalStream(value);
  });
  vi.spyOn(mountTexts, 'agentText').mockImplementation((key) => `合成文案:${key}`);
  const originalAssembly = businessAssembly.createAgentStreamAssembly;
  vi.spyOn(businessAssembly, 'createAgentStreamAssembly').mockImplementation((deps) =>
    originalAssembly({ ...deps, texts: f.deps.texts, scheduler: f.time.scheduler }),
  );
  const originalBody = core.createAgentRunBody;
  const bodies: Parameters<typeof core.createAgentRunBody>[0][] = [];
  vi.spyOn(core, 'createAgentRunBody').mockImplementation((deps) => {
    bodies.push(deps);
    return originalBody({ ...deps, inputCheck: passInput });
  });

  // URL imports follow B3-03f / the first B3-03j mount test: Nest source belongs to api's
  // decorator-enabled compilation, not the rule-test project's erasable-syntax compilation.
  const src = (path: string) => new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
  const boot = (await import(src('bootstrap.ts'))) as {
    createHttpApp(entry: string, overrides: object): Promise<StreamApp>;
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
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
  try {
    await app.init();
    expect(options).toHaveLength(1);
    expect(
      options[0]?.assembly,
      'app.module must supply its production business factory',
    ).toBeTypeOf('function');
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.intents).toBeDefined();
    expect(body.deterministic).toBeDefined();
    const runtime = app.get(agentStreamToken(), { strict: false }) as AgentStreamRuntime;
    expect(runtime).not.toBeNull();
    return { ...f, app, body, runtime };
  } catch (error) {
    await app.close();
    throw error;
  }
}
