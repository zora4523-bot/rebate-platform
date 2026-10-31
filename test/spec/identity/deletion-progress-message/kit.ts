// B1-15i rule-test fixture (08 BR-TEXT-23 细则模板表 DELETION_PROGRESS, BR-ID-27, BR-TEXT-11,
// BR-TEXT-10, BR-TEXT-09 细则标题表; orchestrator brief §9.2 / §9.3).
//
// Two entries, both exactly as app.module assembles them (no port of identity or notification is
// replaced, so the tests never depend on how app.module names the notice option):
// - HTTP: the real AppModule over the business role couli_app of a cloned test database and a real
//   Redis (POST /v1/me/deletion, POST /v1/me/deletion/cancel), users and step-up tokens from
//   B1-15d's kit. The application's database handle carries `failure`, a plugin that can be armed
//   to fail an INSERT into inbox_messages or notify_logs AFTER PostgreSQL executed it (as
//   notification/risk-state-message's failInsert, armable): the business transaction around it
//   must roll everything back.
// - Expiry: IdentityDeletionExpiryModule built from the options app.module passes on the worker
//   entry (B1-15f's assembled runner), in a harness with CLOCK, ROOT_LOGGER, APP_CONFIG and a DB
//   handle that may carry the same armable failure.
// Rows are always read through the plain handle. Only *.int.test.ts files open a database.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import {
  PostgresQueryCompiler,
  type Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type Selectable,
  type UnknownRow,
} from 'kysely';
import { expect, vi } from 'vitest';
import type { TokenKeyProvider } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as IdentityTokensApi from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type * as PlatformApi from '../../../../apps/api/src/modules/platform/index.ts';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/index.ts';
import type * as RiskApi from '../../../../apps/api/src/modules/risk/index.ts';
import type { RiskStateService } from '../../../../apps/api/src/modules/risk/index.ts';
import type * as DeletionMessageApi from '../../../../apps/api/src/modules/notification/application/deletion-progress-message.ts';
import { ROOT } from '../../risk/signature/kit.ts';
import { closeKit, openKit } from '../registration/kit.ts';
import { buildApp } from '../sms-codes/http-kit.ts';
import { acquireRedis, memoryLogger } from '../sms-codes/kit.ts';
import { INSTANT, type Fixture as RequestFixture } from '../deletion-request/kit.ts';
import {
  capturedWorkerOptions,
  identity,
  ports,
  workerHarness,
  type Runner,
} from '../deletion-expiry/kit.ts';
import { CODE, TITLE, dedupeKey, type Variant } from './texts.ts';

export {
  AMOUNTS,
  CANCELLED_BODY,
  CODE,
  TITLE,
  dedupeKey,
  negativeBody,
  requestedBody,
  type Variant,
} from './texts.ts';

export type InboxRow = Selectable<DB['inbox_messages']>;
export type LogRow = Selectable<DB['notify_logs']>;

// ---- armable failure after an INSERT ---------------------------------------------------------

export type FailTable = 'inbox_messages' | 'notify_logs';

/**
 * A plugin that, while armed for a table, lets every INSERT into it run and then fails with a
 * PostgreSQL-shaped error (22012) instead of returning its result: the caller's transaction fails
 * after the row was written and must roll it back. Disarmed it changes nothing.
 */
export function armableFailure() {
  let armed: FailTable | null = null;
  let fired = 0;
  const matched = new Set<unknown>();
  const compiler = new PostgresQueryCompiler();
  const plugin: KyselyPlugin = {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      if (armed !== null) {
        const statement = compiler.compileQuery(args.node, args.queryId).sql;
        if (
          new RegExp(`\\binsert\\s+into\\s+(?:"?app"?\\.)?"?${armed}"?\\b`, 'i').test(statement)
        ) {
          matched.add(args.queryId);
        }
      }
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      if (matched.delete(args.queryId)) {
        fired += 1;
        throw Object.assign(new Error('injected failure after the insert'), { code: '22012' });
      }
      return args.result;
    },
  };
  return {
    plugin,
    arm(table: FailTable) {
      armed = table;
    },
    disarm() {
      armed = null;
      matched.clear();
    },
    fired: () => fired,
  };
}
export type ArmableFailure = ReturnType<typeof armableFailure>;

// ---- HTTP: the assembled application ---------------------------------------------------------

export interface HttpFixture extends RequestFixture {
  readonly failure: ArmableFailure;
}

/** True when identity exports DELETION_STAGE_CHECKS and the application provides its checks. */
function deletionGuardAssembled(app: RequestFixture['app'], token: unknown): boolean {
  if (typeof token !== 'symbol') return false;
  try {
    const checks = app.get<{ guard?: unknown; postMiss?: unknown } | null>(token);
    return typeof checks === 'object' && checks !== null && typeof checks.postMiss === 'function';
  } catch {
    return false;
  }
}

/** The real AppModule ('api' entry) over the test database, no option replaced. */
export async function openHttp(): Promise<HttpFixture> {
  const kit = await openKit();
  const server = await acquireRedis();
  expect(server, 'no test Redis').toBeDefined();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'spec-b1-15i-'));
  const { logger, lines } = memoryLogger();
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof PlatformApi;
  const identityIndex = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as { DELETION_STAGE_CHECKS?: unknown };
  const identityTokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof IdentityTokensApi;
  const riskIndex = (await import(
    new URL('apps/api/src/modules/risk/index.ts', ROOT).href
  )) as typeof RiskApi;
  const clock = new platform.FixedClock(INSTANT);
  const failure = armableFailure();
  let app: RequestFixture['app'] | undefined;
  try {
    app = (await buildApp(
      kit.db.withPlugin(failure.plugin),
      dir,
      server!.url,
      clock,
      logger,
    )) as unknown as RequestFixture['app'];
    await app.init();
    const running = app;
    return {
      kit,
      db: kit.db,
      app: running,
      clock,
      lines,
      keys: running.get<TokenKeyProvider>(identityTokens.TOKEN_KEYS),
      idempotency: running.get<Idempotency>(platform.IDEMPOTENCY),
      risk: running.get<RiskStateService>(riskIndex.riskStateServiceToken()),
      deletionGuard: deletionGuardAssembled(running, identityIndex.DELETION_STAGE_CHECKS),
      failure,
      async close() {
        try {
          await running.close();
        } finally {
          try {
            await server!.stop();
          } finally {
            await closeKit(kit);
            rmSync(dir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    await app?.close();
    await server!.stop();
    await closeKit(kit);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// ---- expiry: the assembled worker runner -----------------------------------------------------

/** B1-15f's assembled runner (app.module's worker options), on `db` (may carry a plugin). */
export async function assembledExpiry(db: Kysely<DB>) {
  const api = await identity();
  const p = await ports();
  try {
    const options = await capturedWorkerOptions(api, p);
    const module = api.IdentityDeletionExpiryModule.forWorker(options as never);
    const context = await workerHarness(p, module, 'test', db);
    const runner = context.get(api.deletionExpiryToken()) as Runner;
    return { p, runner, close: () => context.close() };
  } finally {
    vi.restoreAllMocks();
  }
}

// ---- notification's writer, called directly --------------------------------------------------

export async function messageApi(): Promise<typeof DeletionMessageApi> {
  return (await import(
    new URL('apps/api/src/modules/notification/index.ts', ROOT).href
  )) as typeof DeletionMessageApi;
}

// ---- reading and seeding ---------------------------------------------------------------------

/** The app's inbox messages (optionally of one user), oldest first. */
export async function inbox(db: Kysely<DB>, appId: string, userId?: string): Promise<InboxRow[]> {
  let query = db
    .withSchema('app')
    .selectFrom('inbox_messages')
    .selectAll()
    .where('app_id', '=', appId);
  if (userId !== undefined) query = query.where('user_id', '=', userId);
  return query.orderBy('created_at').orderBy('message_id').execute();
}

/** The app's notify_logs rows (optionally of one user), oldest first. */
export async function logs(db: Kysely<DB>, appId: string, userId?: string): Promise<LogRow[]> {
  let query = db
    .withSchema('app')
    .selectFrom('notify_logs')
    .selectAll()
    .where('app_id', '=', appId);
  if (userId !== undefined) query = query.where('user_id', '=', userId);
  return query.orderBy('created_at').orderBy('dedupe_key').execute();
}

/** One inbox message of DELETION_PROGRESS as BR-TEXT-23 / BR-TEXT-09 define it. */
export function expectedMessage(input: {
  readonly appId: string;
  readonly userId: string;
  readonly body: string;
  readonly at: Date;
  readonly title?: string;
}) {
  return {
    app_id: input.appId,
    user_id: input.userId,
    code: CODE,
    title: input.title ?? TITLE,
    body: input.body,
    route: null,
    read_at: null,
    created_at: input.at,
    updated_at: input.at,
  };
}

/** Its notify_logs row: inbox channel only, delivered at once, deduplicated by request + variant. */
export function expectedLog(input: {
  readonly appId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly variant: Variant;
  readonly at: Date;
}) {
  return {
    app_id: input.appId,
    user_id: input.userId,
    code: CODE,
    channel: 'inbox',
    dedupe_key: dedupeKey(input.requestId, input.variant),
    status: 'success',
    planned_at: input.at,
    sent_at: input.at,
    suppress_reason: null,
    sms_biz_id: null,
  };
}

/** No push and no SMS: every notify_logs row of the app is on the inbox channel. */
export async function expectInboxOnly(db: Kysely<DB>, appId: string): Promise<void> {
  const rows = await logs(db, appId);
  expect(rows.filter((row) => row.channel !== 'inbox')).toEqual([]);
}

/** A notify_templates override of (app, DELETION_PROGRESS, variant). */
export async function template(
  db: Kysely<DB>,
  appId: string,
  variant: Variant | 'default',
  override: { readonly title_override?: string | null; readonly body_override?: string | null },
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('notify_templates')
    .values({
      app_id: appId,
      code: CODE,
      variant,
      category: 'service',
      channels: ['inbox'],
      route: null,
      title_override: override.title_override ?? null,
      body_override: override.body_override ?? null,
    })
    .execute();
}

/** A notify_logs row already holding the dedupe key (an earlier delivery of the same notice). */
export async function seedLog(
  db: Kysely<DB>,
  input: {
    readonly appId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly variant: Variant;
    readonly at: Date;
  },
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('notify_logs')
    .values({
      id: randomUUID(),
      app_id: input.appId,
      user_id: input.userId,
      code: CODE,
      channel: 'inbox',
      dedupe_key: dedupeKey(input.requestId, input.variant),
      planned_at: input.at,
      sent_at: input.at,
      status: 'success',
      created_at: input.at,
      updated_at: input.at,
    })
    .execute();
}
