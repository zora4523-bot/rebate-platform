// The real AppModule of one entry with an in-memory queue and a recording database driver (real
// Kysely PostgreSQL compilation, as test/spec/orders/rights-port/kit.ts); never polls a queue, opens
// a port or reaches a database. Every statement is recorded with its parameters and answered by
// the test's responder (default: no rows); the only built-in answer is PostgreSQL's default
// isolation level `read committed`, which platform's event bus checks before publishing. The
// payout entry also gets a fake field cipher (the payee snapshot).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { vi } from 'vitest';
import {
  payoutRuntimeToken,
  type PayoutRuntime,
} from '../../../../apps/api/src/modules/payout/payout-runtime.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  JobHandler,
  QueueRuntime,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';

export type EntryName = 'api' | 'stream' | 'admin' | 'worker' | 'payout';

/** The instant the assembled entry's FixedClock starts at. */
export const START = '2026-10-27T02:00:00.000Z';

export interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Rows for a statement; undefined answers no rows. */
export type Responder = (statement: Statement) => readonly unknown[] | undefined;

interface Context {
  get(token: unknown, options?: { strict?: boolean }): unknown;
  close(): Promise<void>;
}

const src = (path: string): string =>
  new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;

const fakeCrypto = {
  currentKeyVersion: 1,
  encrypt: (plaintext: string) => plaintext,
  decrypt: (ciphertext: string) => ciphertext,
  keyVersionOf: () => 1,
  needsReencrypt: () => false,
  reencrypt: (ciphertext: string) => ciphertext,
  blindIndex: (value: string) => value,
};

export async function assemble(entry: EntryName) {
  // The token the payout entry resolves (B2-06f).
  const token = payoutRuntimeToken();
  // URL imports keep parameter decorators in API controllers out of test's erasable TS project.
  const { AppModule } = (await import(src('app.module.ts'))) as {
    AppModule: { forEntry(options: object): { imports?: unknown[] } };
  };
  const { PlatformModule, JOB_QUEUE, FIELD_CRYPTO, loadConfig } = (await import(
    src('modules/platform/index.ts')
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    FIELD_CRYPTO: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(module: unknown, options: object): Promise<Context>;
    };
  };

  const queries: string[] = [];
  const statements: Statement[] = [];
  let responder: Responder = () => undefined;
  class RecordingDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(query: Statement): Promise<QueryResult<R>> {
          const statement = { sql: query.sql, parameters: [...query.parameters] };
          queries.push(statement.sql);
          statements.push(statement);
          const rows = /current_setting\('transaction_isolation'\)/.test(statement.sql)
            ? [{ level: 'read committed' }]
            : [...(responder(statement) ?? [])];
          return Promise.resolve(
            /^\s*(insert|update|delete)\b/i.test(statement.sql)
              ? { rows: rows as R[], numAffectedRows: 1n }
              : { rows: rows as R[] },
          );
        },
        streamQuery() {
          throw new Error('unexpected stream query');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const clock = new FixedClock(START);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry, appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const registrations: Array<{ name: string; handler: JobHandler }> = [];
  const sends = vi.fn<QueueRuntime['send']>(async () => 'fixture-job');
  const queue: QueueRuntime = {
    register(name, handler) {
      registrations.push({ name, handler });
    },
    send: sends,
    async start() {},
    async stop() {},
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  const spy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
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
  let context: Context;
  try {
    const root = AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
      // The payout entry never reads Redis (ADR-0001 §4.2 #20): entry.ts passes null.
      ...(entry === 'payout' ? { redisUrl: null } : {}),
    });
    const module =
      entry === 'payout'
        ? {
            ...root,
            imports: [
              ...(root.imports ?? []),
              {
                module: class FakeFieldCryptoModule {},
                global: true,
                providers: [{ provide: FIELD_CRYPTO, useValue: fakeCrypto }],
                exports: [FIELD_CRYPTO],
              },
            ],
          }
        : root;
    context = await NestFactory.createApplicationContext(module, {
      logger: false,
      abortOnError: false,
    });
  } finally {
    spy.mockRestore();
  }

  return {
    /** The SQL of every statement, in order. */
    queries,
    /** Every statement with its parameters, in order. */
    statements,
    lines,
    registrations,
    sends,
    /** The entry's injected clock (FixedClock: tests move it). */
    clock,
    /** Answers the following statements (replaces the previous responder). */
    respond(next: Responder): void {
      responder = next;
    },
    msgs: (): string[] => lines.map((line) => (JSON.parse(line) as { msg: string }).msg),
    /** The parsed log lines with this message. */
    logged: (msg: string): Array<Record<string, unknown>> =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line['msg'] === msg),
    /** The runtime under payoutRuntimeToken(), or undefined when the entry has none. */
    runtime(): Partial<PayoutRuntime> | null | undefined {
      try {
        return context.get(token, { strict: false }) as Partial<PayoutRuntime> | null | undefined;
      } catch {
        return undefined;
      }
    },
    /** The handlers registered on queue `payout`. */
    payoutHandlers(): JobHandler[] {
      return registrations.filter((r) => r.name === 'payout').map((r) => r.handler);
    },
    async close(): Promise<void> {
      try {
        await context.close();
      } finally {
        await db.destroy();
      }
    },
  };
}

/** A job as the queue hands it to a handler (frozen, exactly these properties). */
export function job(name: string, payload: Record<string, unknown>): ReceivedJob {
  return Object.freeze({
    id: `job-b2-06f-${name}`,
    queue: 'payout',
    name,
    payload,
    attempt: 1,
  }) as ReceivedJob;
}
