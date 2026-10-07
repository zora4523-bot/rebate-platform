// Unit tests of the refresh rotation without a database or Redis (B1-02k): Kysely runs on a scripted
// driver that answers each compiled statement and records it with the transaction events, Redis is
// an in-memory namespace whose set / get can fail. They pin what the rule tests cannot provoke on a
// real PostgreSQL: the 23505 second guard of a concurrent rotation (retried once, then the grace),
// and that a failed Redis write or read rolls the attempt back. The SQL itself runs against
// PostgreSQL and Redis in the rule tests (test/spec/identity/session).
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type FieldCrypto,
  type RedisHandle,
  type RedisNamespace,
} from '../../platform/index.ts';
import { createTokenKeyProvider, createTokenService } from './access-tokens.ts';
import { createRefreshService, type RefreshPair } from './refresh.ts';

const SID = 'sid-unit';
const DEVICE_ID = '01920000-0000-7000-8000-000000000002';
const USER_ID = '01920000-0000-7000-8000-000000000001';
const STORED: RefreshPair = {
  access_token: 'stored-access',
  access_expires_at: '2026-10-08T06:00:00.000Z',
  refresh_token: 'stored-refresh',
  refresh_expires_at: '2026-11-07T04:00:00.000Z',
  session_scope: 'deletion_only',
};

interface State {
  rotatedAt: Date | null;
  expireAt: Date;
  /** Errors the next refresh_tokens inserts throw, in order. */
  insertErrors: unknown[];
  successorRotatedAt: Date | null | undefined;
  /** Whether a failed insert's competing rotation shows on the next read (default true). */
  competitorVisible: boolean;
}

function parentConflict(): Error {
  return Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint: 'refresh_tokens_parent_hash_key',
  });
}

async function setup(init: Partial<State> = {}, redisFails: { get?: boolean; set?: boolean } = {}) {
  const clock = new FixedClock('2026-10-08T04:00:00.000Z');
  const state: State = {
    rotatedAt: null,
    expireAt: new Date(clock.now().getTime() + 86400_000),
    insertErrors: [],
    successorRotatedAt: undefined,
    competitorVisible: true,
    ...init,
  };
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      events.push(text.split(' ')[0] ?? '');
      const answer = ((): QueryResult<unknown> => {
        if (text.startsWith('select') && text.includes('from "refresh_tokens"')) {
          if (text.includes('"parent_hash" =')) {
            return {
              rows:
                state.successorRotatedAt === undefined
                  ? []
                  : [{ rotated_at: state.successorRotatedAt }],
            };
          }
          return { rows: [{ sid: SID, rotated_at: state.rotatedAt, expire_at: state.expireAt }] };
        }
        if (text.startsWith('select') && text.includes('from "sessions"')) {
          return { rows: [{ sid: SID, user_id: USER_ID, device_id: DEVICE_ID, revoked_at: null }] };
        }
        if (text.startsWith('update "refresh_tokens"')) {
          return { rows: [], numAffectedRows: state.rotatedAt === null ? 1n : 0n };
        }
        if (text.startsWith('insert into "refresh_tokens"')) {
          const error = state.insertErrors.shift();
          if (error !== undefined) {
            if (state.competitorVisible) {
              // The competing rotation committed meanwhile.
              state.rotatedAt = clock.now();
              state.successorRotatedAt = null;
            }
            throw error;
          }
          return { rows: [], numAffectedRows: 1n };
        }
        if (text.startsWith('update "sessions"')) return { rows: [], numAffectedRows: 1n };
        return { rows: [] };
      })();
      return Promise.resolve(answer as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => void events.push('begin'),
    commitTransaction: async () => void events.push('commit'),
    rollbackTransaction: async () => void events.push('rollback'),
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const store = new Map<string, string>();
  const namespaces: string[] = [];
  const namespace: RedisNamespace = {
    async get(key) {
      if (redisFails.get === true) throw new Error('unit Redis unavailable');
      return store.get(key) ?? null;
    },
    async set(key, value) {
      if (redisFails.set === true) throw new Error('unit Redis unavailable');
      store.set(key, value);
    },
    async eval() {
      throw new Error('not used');
    },
  };
  const redis = {
    namespace(name: string) {
      namespaces.push(name);
      return namespace;
    },
  } as unknown as RedisHandle;
  const crypto = {
    encrypt: (plaintext: string, context: string) => `${context}|${plaintext}`,
    decrypt: (ciphertext: string, context: string) => {
      if (!ciphertext.startsWith(`${context}|`)) throw new Error('wrong context');
      return ciphertext.slice(context.length + 1);
    },
  } as unknown as FieldCrypto;
  const sids: (readonly string[])[] = [];
  const service = createRefreshService({
    db,
    clock,
    tokens: createTokenService({ clock, keys: await createTokenKeyProvider('test', null) }),
    crypto,
    redis,
    versions: { minSupportedVersion: async () => null },
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    afterRevoked: async (_trx, revoked) => void sids.push(revoked),
  });
  const refresh = () =>
    service.refresh({
      refresh_token: 'presented-refresh',
      verifiedDevice: { deviceId: DEVICE_ID, appId: 'couli' },
      platform: 'ios',
      channel: 'store',
      version: '2.0.0',
    });
  return { clock, state, events, store, namespaces, sids, refresh };
}

const TRANSACTION_EVENTS = new Set(['begin', 'commit', 'rollback']);
const transactions = (events: readonly string[]) =>
  events.filter((event) => TRANSACTION_EVENTS.has(event));

it('[BR-ID-07] a rotation writes the encrypted pair to refresh_grace before the commit', async () => {
  const f = await setup();
  const result = await f.refresh();
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable');
  expect(f.namespaces).toContain('refresh_grace');
  expect(f.store.size).toBe(1);
  const [stored] = [...f.store.values()];
  expect(JSON.parse(stored!.slice('identity.refresh_grace|'.length))).toEqual(result.data);
  expect(f.events.slice(-1)).toEqual(['commit']);
  expect(f.events.indexOf('update')).toBeLessThan(f.events.indexOf('insert'));
});

it('[BR-ID-07] a failed Redis write rolls the rotation back and answers 50001', async () => {
  const f = await setup({}, { set: true });
  expect(await f.refresh()).toEqual({ code: 50001 });
  expect(f.events).toContain('insert');
  expect(transactions(f.events)).toEqual(['begin', 'rollback']);
});

it('[BR-ID-07] a 23505 on the single-successor constraint is retried once and meets the grace', async () => {
  const f = await setup({ insertErrors: [parentConflict()] });
  f.store.set(
    // The grace key is the presented token's SHA-256 (hex).
    createHash('sha256').update('presented-refresh').digest('hex'),
    `identity.refresh_grace|${JSON.stringify(STORED)}`,
  );
  expect(await f.refresh()).toEqual({ code: 0, data: STORED });
  expect(transactions(f.events)).toEqual(['begin', 'rollback', 'begin', 'commit']);
  expect(f.sids).toEqual([]);
});

it('[BR-ID-07] a second 23505 is not retried again: 50001', async () => {
  const f = await setup({
    insertErrors: [parentConflict(), parentConflict()],
    competitorVisible: false,
  });
  expect(await f.refresh()).toEqual({ code: 50001 });
  expect(transactions(f.events)).toEqual(['begin', 'rollback', 'begin', 'rollback']);
});

it('[BR-ID-07] a failed grace read answers 50001 and revokes nothing', async () => {
  const f = await setup({ successorRotatedAt: null }, { get: true });
  f.state.rotatedAt = f.clock.now();
  expect(await f.refresh()).toEqual({ code: 50001 });
  expect(f.events).not.toContain('update');
  expect(f.sids).toEqual([]);
  expect(transactions(f.events)).toEqual(['begin', 'rollback']);
});

it('[BR-ID-07] a missing grace entry is reuse: the sid is revoked and the hook gets it', async () => {
  const f = await setup({ successorRotatedAt: null });
  f.state.rotatedAt = f.clock.now();
  expect(await f.refresh()).toEqual({ code: 10404 });
  expect(f.sids).toEqual([[SID]]);
  expect(transactions(f.events)).toEqual(['begin', 'commit']);
});

it('[BR-ID-07] an expired token is 10404 without any write or revocation', async () => {
  const f = await setup();
  f.state.expireAt = f.clock.now();
  expect(await f.refresh()).toEqual({ code: 10404 });
  expect(f.events.filter((event) => event === 'update' || event === 'insert')).toEqual([]);
  expect(f.sids).toEqual([]);
});
