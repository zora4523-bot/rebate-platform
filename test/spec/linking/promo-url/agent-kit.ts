// B1-06zd rule-test kit: a logged-in Agent user on the real stream AppModule, its JOB_QUEUE really
// running, so a prefetch job is a row of pgboss.job. Built like stream-assembly/regression-kit.ts
// production(), which cannot be used here: its caller is a guest and its queue a stand-in. As there,
// only the pending input check and copy are substituted. The App is the stream kits' APP, with an
// active agent promotion slot and an active Taobao binding of the user.
// Only *.int.test.ts import @couli/db/testing and hand the connections in.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  agentStreamToken,
  type AgentStreamRuntime,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import * as mountTexts from '../../../../apps/api/src/modules/agent/stream/mount/texts.ts';
import * as businessAssembly from '../../../../apps/api/src/modules/agent/stream/mount/assembly.ts';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import { APP, fixture, passInput } from '../../agent/stream-assembly/kit.ts';
import { newMember, setConfig } from '../../agent/stream-mount/kit.ts';
import { PREFETCH_SWITCH, relationId, slot } from './kit.ts';

interface StreamApp {
  init(): Promise<unknown>;
  close(): Promise<void>;
  get(token: unknown, options: { strict: boolean }): unknown;
}

const src = (path: string) => new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;

/** A member with an active relation_id, on a stream entry with the prefetch switch on. */
export async function agentEntry(db: Kysely<DB>, connection: { database: string; redis: string }) {
  const f = await fixture(db, await newMember(db));
  const now = f.time.clock.now();
  const userId = String(f.caller.userId);
  for (const [key, value] of [
    [PREFETCH_SWITCH, true],
    ['agent.page_guide.routes', ['Wallet']],
    ['search.enabled.jd', false],
    ['search.enabled.pdd', false],
    ['convert.enabled.taobao', true],
    ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
    ['rebate.taobao.compare_rate_ratio_bp', 5000],
    ['demo.rebate_quote_rule', { reserve_bp: 0, self_share_bp: 10000 }],
  ] as const)
    await setConfig(db, APP, key, value);
  await db
    .updateTable('platforms')
    .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: now })
    .where('code', '=', 'taobao')
    .execute();

  const accountId = randomUUID();
  const relation = relationId();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: APP,
      platform: 'taobao',
      account_name: 'synthetic-promo-agent',
      status: 'active',
      auth_status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: APP,
      platform: 'taobao',
      union_account_id: accountId,
      site_id: 'synthetic-agent-site',
      pid: slot(),
      pid_scene: 'agent',
      status: 'active',
      hjy_ignore_confirmed_at: now,
      hjy_ignore_evidence_path: 'https://example.test/synthetic-evidence',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: APP,
      user_id: userId,
      platform: 'taobao',
      union_account_id: accountId,
      relation_id: relation,
      status: 'active',
      bound_at: now,
      blocked_reason: null,
      released_at: null,
      cooldown_until: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('user_risk_state')
    .values({
      app_id: APP,
      user_id: userId,
      state: 'normal',
      changed_by: 'synthetic',
      changed_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();

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

  const boot = (await import(src('bootstrap.ts'))) as {
    createHttpApp(entry: 'stream', overrides: object): Promise<StreamApp>;
  };
  const platform = (await import(src('modules/platform/index.ts'))) as typeof Platform;
  const app = await boot.createHttpApp('stream', {
    config: platform.loadConfig({ APP_ENV: 'test' }),
    clock: f.time.clock,
    logger: f.logs.logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: platform.loadConnectionConfig('stream', {
      DATABASE_URL: connection.database,
      REDIS_URL: connection.redis,
    }).redisUrl,
    startQueue: true,
  });
  try {
    await app.init();
    expect(bodies).toHaveLength(1);
    const runtime = app.get(agentStreamToken(), { strict: false }) as AgentStreamRuntime;
    return { ...f, app, body: bodies[0]!, runtime, relationId: relation };
  } catch (error) {
    await app.close();
    throw error;
  }
}
