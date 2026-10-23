// B3-08k fixture (no database, no Nest application, no network). Pieces:
// - FakeContentReader: the AgentContentReader app.module provides (configValue / freshConfigValue),
//   recording every read in order; values set per (appId, key), a key never set is missing (null),
//   a failing key rejects;
// - compileOnlyDb: a Kysely over DummyDriver that only compiles and records the SQL it is asked to
//   run (every query answers no rows), as test/spec/agent/stream-mount/module.test.ts does: a
//   config_items query in it means agent built a content reader over its own handle;
// - callFactory: calls a Nest factory provider with the values of its inject tokens (by token,
//   never by position), so the provider's own token list decides what it receives.
// Everything under test is built inside the tests (never in hooks), so the skeleton's
// NotImplemented reddens each test itself.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect } from 'vitest';

import type { ContentConfig } from '../../../../apps/api/src/modules/content/index.ts';
import {
  FixedClock,
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type {
  AgentContentReader,
  agentStreamProvider,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';

/** The app of the tests. */
export const APP = 'couli';

/** The three keys of the daily limits (BR-AI-15; stream/pg/limits.ts). */
export const LIMIT_KEYS = [
  'agent.member_daily_quota',
  'agent.guest_daily_quota',
  'agent.guest_ip_daily_quota',
] as const;

export type ReadKind = 'configValue' | 'freshConfigValue';

export interface ContentRead {
  readonly kind: ReadKind;
  readonly appId: string;
  readonly key: string;
}

/** app.module's content reads, as a stand-in that records every read. */
export class FakeContentReader implements AgentContentReader {
  readonly reads: ContentRead[] = [];
  readonly #values = new Map<string, ContentConfig['value']>();
  readonly #failing = new Set<string>();

  /** (appId, key) = value (version 1); undefined removes it (the key is missing). */
  set(appId: string, key: string, value: ContentConfig['value'] | undefined): this {
    const id = JSON.stringify([appId, key]);
    if (value === undefined) this.#values.delete(id);
    else this.#values.set(id, value);
    return this;
  }

  /** Every later read of (appId, key) rejects. */
  fail(appId: string, key: string): this {
    this.#failing.add(JSON.stringify([appId, key]));
    return this;
  }

  /** The value object stored for (appId, key) (the very object every read hands out). */
  stored(appId: string, key: string): ContentConfig['value'] | undefined {
    return this.#values.get(JSON.stringify([appId, key]));
  }

  configValue(appId: string, key: string): Promise<ContentConfig | null> {
    return this.#read('configValue', appId, key);
  }

  freshConfigValue(appId: string, key: string): Promise<ContentConfig | null> {
    return this.#read('freshConfigValue', appId, key);
  }

  /** The keys read through one method, in order (repeats kept). */
  keys(kind: ReadKind, appId: string = APP): string[] {
    return this.reads.filter((r) => r.kind === kind && r.appId === appId).map((r) => r.key);
  }

  /** How many reads of (appId, key) went through one method. */
  count(kind: ReadKind, appId: string, key: string): number {
    return this.reads.filter((r) => r.kind === kind && r.appId === appId && r.key === key).length;
  }

  #read(kind: ReadKind, appId: string, key: string): Promise<ContentConfig | null> {
    this.reads.push({ kind, appId, key });
    const id = JSON.stringify([appId, key]);
    if (this.#failing.has(id)) return Promise.reject(new Error('fixture: config read failed'));
    if (!this.#values.has(id)) return Promise.resolve(null);
    return Promise.resolve({ value: this.#values.get(id)!, version: 1 });
  }
}

/** A Kysely that only compiles: each query it is asked to run is recorded and answers no rows. */
export function compileOnlyDb(queries: string[]): Kysely<DB> {
  return new Kysely<DB>({
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
}

/** The recorded queries that read content's config_items table. */
export function configQueries(queries: readonly string[]): string[] {
  return queries.filter((query) => /config_items/u.test(query));
}

export function fixedClock(): FixedClock {
  return new FixedClock('2026-10-24T00:00:00.000Z');
}

/** A real pino root logger writing into `lines` (parsed JSON objects). */
export function logs(): { logger: RootLogger; lines: () => { level: number; msg: string }[] } {
  const raw: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        raw.push(line);
      },
    },
  );
  return {
    logger,
    lines: () => raw.map((line) => JSON.parse(line) as { level: number; msg: string }),
  };
}

let traceNo = 0;

/** A logged-in caller with a bound phone (the HTTP layer is reached directly, no token check). */
export function member(appId: string = APP): AgentCaller {
  traceNo += 1;
  return {
    appId,
    traceId: `trace_b3_08k_${String(traceNo)}`,
    deviceId: '0192f3a0-0000-7000-8000-00000000b308',
    deviceHash: 'dh-b3-08k',
    ipKey: 'ipk-b3-08k',
    userId: '0192f3a0-0000-7000-8000-00000000c308',
    phoneBound: true,
  };
}

/** A reply that keeps every JSON answer; this suite never expects a stream. */
export class JsonReply {
  readonly jsons: { status: number; body: Record<string, unknown> }[] = [];
  json(status: number, _headers: Readonly<Record<string, string>>, body: unknown): void {
    this.jsons.push({ status, body: body as Record<string, unknown> });
  }
  stream(): never {
    throw new Error('fixture: no stream expected');
  }
  codes(): unknown[] {
    return this.jsons.map((answer) => answer.body['code']);
  }
}

export type FactoryProvider = ReturnType<typeof agentStreamProvider>;
type InjectEntry = NonNullable<FactoryProvider['inject']>[number];

function tokenOf(entry: InjectEntry): unknown {
  return typeof entry === 'object' && entry !== null && 'token' in entry ? entry.token : entry;
}

function optionalOf(entry: InjectEntry): boolean {
  return (
    typeof entry === 'object' && entry !== null && 'optional' in entry && entry.optional === true
  );
}

/** The tokens a factory provider injects, in its order. */
export function injectTokens(provider: FactoryProvider): unknown[] {
  return (provider.inject ?? []).map(tokenOf);
}

/**
 * provider.useFactory called with, for each inject entry, values.get(token); a required entry
 * whose token is not in `values` fails the test (an optional one gets undefined).
 */
export function callFactory(provider: FactoryProvider, values: ReadonlyMap<unknown, unknown>) {
  const args = (provider.inject ?? []).map((entry) => {
    const token = tokenOf(entry);
    expect(values.has(token) || optionalOf(entry), `required injection ${String(token)}`).toBe(
      true,
    );
    return values.get(token);
  });
  return (provider.useFactory as (...values: unknown[]) => unknown)(...args);
}

/** The factory provider of `token` among a dynamic module's providers. */
export function providerOf(
  providers: readonly unknown[] | undefined,
  token: unknown,
): FactoryProvider {
  const found = (providers ?? []).find(
    (provider) =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === token &&
      'useFactory' in provider,
  );
  expect(found, `factory provider of ${String(token)}`).toBeDefined();
  return found as FactoryProvider;
}
