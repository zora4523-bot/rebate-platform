// Child process of the pool-error rule tests (ADR-0001 §4.2 第 11 项; ADR-0002 §5「出错后重建连接」;
// 规划/02 §14 PostgreSQL 主库一行: 各进程断线后自动重连). It is started with
// `node --conditions=couli-src <this file>`: a plain Node process (type stripping) in which an
// 'error' event nobody listens to ends the process, unlike a Vitest worker that catches it.
// Only text crosses the process boundary: one JSON request on stdin, one JSON reply on stdout,
// nothing on stderr. The module under test logs into memory; the reply carries the raw lines.
//
// For each handle of the entry (db, then dbRead for admin), as the role the handle connects as:
//   idle         a query, then the server ends that session (pg_terminate_backend) while the
//                connection sits idle in the pool; wait for the log line; another query
//   transaction  inside a transaction, the server ends the session between two queries (the
//                connection is checked out, no query running); wait for the log line; the next
//                query of the transaction; then a query outside it
// Any failure is replied as { "error": "<name>: <message>" }. Import only the types of this
// file (`import type`): importing it for real would run it and wait for stdin.
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

type DbModule = typeof import('../../../../apps/api/src/modules/platform/db/index.ts');
type LoggerModule = typeof import('../../../../apps/api/src/modules/platform/logging/logger.ts');

const MODULE_UNDER_TEST = '../../../../apps/api/src/modules/platform/db/index.ts';
const LOGGER_MODULE = '../../../../apps/api/src/modules/platform/logging/logger.ts';

export type ChildEntry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';

export interface ChildRequest {
  readonly entry: ChildEntry;
  /** The variables given to loadConnectionConfig. */
  readonly env: Readonly<Record<string, string>>;
  /** Per handle, a URL of the role that handle connects as, used to end its sessions. */
  readonly killers: { readonly db: string; readonly dbRead: string | null };
}

/** What happened in the two scenarios of one handle. */
export interface HandleSteps {
  /** `new connection` when the query after the idle failure ran on another session. */
  readonly idle: string;
  /** `rejected` when the transaction whose session ended rejected. */
  readonly transaction: string;
  /** `new connection` when the query after the transaction ran on another session. */
  readonly afterTransaction: string;
}

export type ChildReply =
  | { readonly error: string }
  | {
      readonly pid: number;
      /** process.uptime() in ms right before the reply was written. */
      readonly uptimeMs: number;
      readonly lines: string[];
      readonly steps: Record<string, HandleSteps>;
    };

const WAIT_MS = 3000;
const SETTLE_MS = 200;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits until `lines` holds at least `count` lines (or the limit passes), then a little more. */
async function waitLines(lines: readonly string[], count: number): Promise<void> {
  const stop = performance.now() + WAIT_MS;
  while (lines.length < count && performance.now() < stop) await sleep(20);
  await sleep(SETTLE_MS);
}

async function pidOf(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('no pid');
  return pid;
}

async function terminate(killer: Kysely<DB>, pid: number): Promise<void> {
  const result = await sql<{ done: boolean }>`SELECT pg_terminate_backend(${pid}) AS done`.execute(
    killer,
  );
  if (result.rows[0]?.done !== true) throw new Error(`could not end session ${String(pid)}`);
}

async function scenarios(
  db: Kysely<DB>,
  killer: Kysely<DB>,
  lines: readonly string[],
): Promise<HandleSteps> {
  const first = await pidOf(db);
  const linesBefore = lines.length;
  await terminate(killer, first);
  await waitLines(lines, linesBefore + 1);
  const second = await pidOf(db);

  let inside = 0;
  const transaction = await db
    .transaction()
    .execute(async (trx) => {
      inside = await pidOf(trx);
      const before = lines.length;
      await terminate(killer, inside);
      await waitLines(lines, before + 1);
      await sql`SELECT 1`.execute(trx);
      return 'resolved';
    })
    .then(
      (value) => value,
      () => 'rejected',
    );
  const after = await pidOf(db);
  return {
    idle: second === first ? 'same connection' : 'new connection',
    transaction,
    afterTransaction: after === inside ? 'same connection' : 'new connection',
  };
}

async function handle(request: ChildRequest): Promise<ChildReply> {
  const mod = (await import(MODULE_UNDER_TEST)) as DbModule;
  const logging = (await import(LOGGER_MODULE)) as LoggerModule;
  const lines: string[] = [];
  const logger = logging.createRootLogger(
    { level: 'info', entry: request.entry, appEnv: 'test' },
    {
      write(text: string) {
        lines.push(text);
      },
    },
  );
  const handles = mod.createDbHandles(mod.loadConnectionConfig(request.entry, request.env), {
    logger,
  });
  const killers: Kysely<DB>[] = [];
  const steps: Record<string, HandleSteps> = {};
  try {
    const dbKiller = createDb({ connectionString: request.killers.db, max: 1 });
    killers.push(dbKiller);
    steps['db'] = await scenarios(handles.db, dbKiller, lines);
    if (handles.dbRead !== null && request.killers.dbRead !== null) {
      const readKiller = createDb({ connectionString: request.killers.dbRead, max: 1 });
      killers.push(readKiller);
      steps['dbRead'] = await scenarios(handles.dbRead, readKiller, lines);
    }
  } finally {
    await handles.close();
    for (const killer of killers) await destroyDb(killer);
  }
  return { pid: process.pid, uptimeMs: process.uptime() * 1000, lines, steps };
}

let reply: ChildReply;
try {
  reply = await handle(JSON.parse(await readStdin()) as ChildRequest);
} catch (error) {
  reply = {
    error: error instanceof Error ? `${error.name}: ${error.message}` : `thrown ${String(error)}`,
  };
}
process.stdout.write(JSON.stringify(reply));
