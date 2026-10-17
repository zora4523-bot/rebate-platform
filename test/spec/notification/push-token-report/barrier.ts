// B1-12c: deterministic stop points and fault injection for the push token report rule tests
// (r1 review S1: no fixed sleeps, no "it happened to interleave"). Everything here wraps the real
// Kysely handle that the reporter receives (createPushTokenReporter({ db })) with a test plugin:
// - gateAfter(): the reporter's transaction stops right after the first matching statement has
//   executed (its row locks / uncommitted index entries are in place), until release();
// - faultOnWrite(): every push_tokens write after the first one fails before it reaches the
//   database (a write failure between "revoke the holder" and "write the acquiring row");
// - waitBlocked(): polls pg_stat_activity until some backend of this test database waits on a
//   lock held by another backend (pg_blocking_pids), or the watched promise settled.
// No rule of the report lives here.
import { setTimeout as delay } from 'node:timers/promises';
import type { DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin, type RootOperationNode } from 'kysely';

const WRITE_KINDS = new Set([
  'InsertQueryNode',
  'UpdateQueryNode',
  'DeleteQueryNode',
  'MergeQueryNode',
]);

function rawText(node: RootOperationNode): string | undefined {
  return node.kind === 'RawNode' ? node.sqlFragments.join(' ? ') : undefined;
}

/** A statement that writes the named table (query builder or raw SQL). */
export function writesTable(node: RootOperationNode, table: string): boolean {
  const raw = rawText(node);
  if (raw !== undefined) {
    const name = `(?:"?app"?\\.)?"?${table}"?\\b`;
    return new RegExp(
      `\\b(?:insert\\s+into|update|delete\\s+from|merge\\s+into)\\s+${name}`,
      'i',
    ).test(raw);
  }
  if (!WRITE_KINDS.has(node.kind)) return false;
  const shape = node as unknown as Record<string, unknown>;
  const target = shape['into'] ?? shape['table'] ?? shape['from'];
  return JSON.stringify(target ?? null).includes(`"name":"${table}"`);
}

/** Any statement that mentions the named table (reads included). */
export function mentionsTable(node: RootOperationNode, table: string): boolean {
  const raw = rawText(node);
  if (raw !== undefined) return new RegExp(`\\b${table}\\b`, 'i').test(raw);
  return JSON.stringify(node).includes(`"name":"${table}"`);
}

export interface Gate {
  readonly handle: Kysely<DB>;
  /** Resolves once the first matching statement executed and the transaction is held. */
  readonly entered: Promise<void>;
  reached(): boolean;
  release(): void;
}

/** Stop the handle's work right after the first statement matching `match` has executed. */
export function gateAfter(db: Kysely<DB>, match: (node: RootOperationNode) => boolean): Gate {
  let reached = false;
  let enter!: () => void;
  let open!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const watched = new WeakSet<object>();
  const plugin: KyselyPlugin = {
    transformQuery: ({ node, queryId }) => {
      if (!reached && match(node)) watched.add(queryId);
      return node;
    },
    transformResult: async ({ queryId, result }) => {
      if (!reached && watched.has(queryId)) {
        reached = true;
        enter();
        await opened;
      }
      return result;
    },
  };
  return { handle: db.withPlugin(plugin), entered, reached: () => reached, release: () => open() };
}

export const INJECTED_FAULT = 'injected push_tokens write fault (B1-12c rule test)';

export interface Fault {
  readonly handle: Kysely<DB>;
  /** push_tokens writes attempted through the handle (the failing ones included). */
  writes(): number;
}

/** The first push_tokens write goes through; every later one fails before reaching PostgreSQL. */
export function faultOnWrite(db: Kysely<DB>): Fault {
  let writes = 0;
  const plugin: KyselyPlugin = {
    transformQuery: ({ node }) => {
      if (writesTable(node, 'push_tokens')) {
        writes += 1;
        if (writes >= 2) throw new Error(INJECTED_FAULT);
      }
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  return { handle: db.withPlugin(plugin), writes: () => writes };
}

/** Track whether a promise settled, without an unhandled rejection while it is pending. */
export function track<T>(promise: Promise<T>) {
  let settled = false;
  const done = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  void done.catch(() => undefined);
  return { done, settled: () => settled };
}

/**
 * Poll until a backend of this database waits on a lock held by another backend (true), or the
 * watched work settled / the bound passed (false). Polling with a bound, not a fixed sleep.
 */
export async function waitBlocked(
  db: Kysely<DB>,
  settled: () => boolean,
  boundMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (settled()) return false;
    const { rows } = await sql<{ blocked: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
      ) AS blocked
    `.execute(db);
    if (rows[0]!.blocked) return true;
    await delay(10);
  }
  return false;
}
