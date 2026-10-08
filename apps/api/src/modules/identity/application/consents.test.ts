// Unit tests of the consent service without a database (B1-02f round 2 review items): Kysely runs on
// a scripted driver that answers each compiled statement and records it with the transaction events
// and the Clock reads. They pin the order the rule tests cannot provoke on a real PostgreSQL: a
// user-level write takes the user's consent lock before it reads the Clock and writes, and sets
// users.personalization_off by a CAS on the row_version read under the row lock; a privacy
// withdrawal locks the device row before it revokes the device's sessions (createSession's order).
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/identity/step-up).
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
import { FixedClock, type Clock, type TokenPrincipal } from '../../platform/index.ts';
import { createConsentService, type ConsentCommand } from './consents.ts';

const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};

interface Script {
  /** users.row_version answered to the locked read (undefined: no user row). */
  userRowVersion?: number | undefined;
  /** Rows the users CAS reports as updated. */
  casRows?: bigint;
  /** devices.revoked_at answered to the device read (undefined: no device row). */
  device?: { revoked_at: Date | null } | undefined;
}

/** A short label of one statement: what the order assertions compare. */
function label(text: string): string {
  if (text.includes('pg_advisory_xact_lock')) return 'lock:user-consents';
  if (text.startsWith('select') && text.includes('from "users"')) {
    return text.endsWith('for update') ? 'lock:users' : 'select:users';
  }
  if (text.startsWith('select') && text.includes('from "devices"')) {
    return text.endsWith('for update') ? 'lock:devices' : 'select:devices';
  }
  if (text.startsWith('insert into "consent_records"')) return 'insert:consent_records';
  if (text.startsWith('update "users"')) return 'update:users';
  if (text.startsWith('update "sessions"')) return 'update:sessions';
  if (text.startsWith('update "devices"')) return 'update:devices';
  if (text.startsWith('delete from "push_tokens"')) return 'delete:push_tokens';
  return `other:${text.split(' ')[0] ?? ''}`;
}

function setup(script: Script = {}) {
  const fixed = new FixedClock('2026-10-08T02:00:00.000Z');
  const events: string[] = [];
  const statements: CompiledQuery[] = [];
  const clock: Clock = {
    now: () => {
      events.push('clock');
      return fixed.now();
    },
  };
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const name = label(compiled.sql);
      events.push(name);
      statements.push(compiled);
      const answer = ((): QueryResult<unknown> => {
        if (name === 'lock:users' || name === 'select:users') {
          return {
            rows:
              script.userRowVersion === undefined ? [] : [{ row_version: script.userRowVersion }],
          };
        }
        if (name === 'lock:devices' || name === 'select:devices') {
          return { rows: script.device === undefined ? [] : [script.device] };
        }
        if (name === 'update:users') return { rows: [], numAffectedRows: script.casRows ?? 1n };
        if (name === 'update:sessions') return { rows: [{ sid: 'session-unit' }] };
        return { rows: [], numAffectedRows: 1n };
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
  return { service: createConsentService({ db, clock }), events, statements };
}

function command(
  body: Partial<ConsentCommand['body']> & Pick<ConsentCommand['body'], 'type' | 'accepted'>,
  principal: TokenPrincipal | null = PRINCIPAL,
): ConsentCommand {
  return {
    app_id: 'couli',
    device_id: PRINCIPAL.device_id,
    ...(principal === null ? {} : { principal }),
    body: {
      version: 3,
      channel: 'privacy_center',
      client_at: '2026-10-08T01:59:59.000Z',
      ...body,
    } as ConsentCommand['body'],
  };
}

it('[BR-ID-12][BR-ID-13] personalization: the user consent lock, then the Clock, the record and a users CAS', async () => {
  const context = setup({ userRowVersion: 7 });
  expect(
    await context.service.record(command({ type: 'personalization', accepted: false })),
  ).toEqual({ code: 0, data: {} });
  expect(context.events).toEqual([
    'begin',
    'lock:user-consents',
    'clock',
    'insert:consent_records',
    'lock:users',
    'update:users',
    'commit',
  ]);
  const cas = context.statements.find((statement) => label(statement.sql) === 'update:users');
  expect(cas?.sql).toContain('"row_version" = $');
  // personalization_off = !accepted, row_version 7 → 8, guarded by row_version = 7.
  expect(cas?.parameters).toEqual(expect.arrayContaining([true, 8, 7]));
});

it('[BR-ID-12] a users CAS that misses under the lock rolls the whole record back (50001)', async () => {
  const context = setup({ userRowVersion: 7, casRows: 0n });
  await expect(
    context.service.record(command({ type: 'personalization', accepted: true })),
  ).rejects.toThrow(/personalization_off/);
  expect(context.events.at(-1)).toBe('rollback');
  expect(context.events).not.toContain('commit');
});

it('[BR-ID-12] every user-level record takes the consent lock first; a device-level guest record does not', async () => {
  const user = setup();
  await user.service.record(command({ type: 'agreement', accepted: true }));
  expect(user.events).toEqual([
    'begin',
    'lock:user-consents',
    'clock',
    'insert:consent_records',
    'commit',
  ]);
  const guest = setup({ device: { revoked_at: null } });
  await guest.service.record(command({ type: 'agreement', accepted: true }, null));
  expect(guest.events).toEqual([
    'begin',
    'select:devices',
    'clock',
    'insert:consent_records',
    'commit',
  ]);
});

it('[BR-ID-13] a privacy withdrawal locks the device row before the sessions, then install_secret and push tokens', async () => {
  const context = setup({ device: { revoked_at: null } });
  expect(await context.service.record(command({ type: 'privacy', accepted: false }))).toEqual({
    code: 0,
    data: {},
  });
  expect(context.events).toEqual([
    'begin',
    'lock:devices',
    'clock',
    'insert:consent_records',
    'update:sessions',
    'update:devices',
    'delete:push_tokens',
    'commit',
  ]);
  // Device level, no user consent lock: the withdrawal never waits on a login's user lock.
  expect(context.events).not.toContain('lock:user-consents');
});

it('[BR-ID-13] a guest withdrawal on a revoked or unknown device is 20001 [X-Device-Id] after the device lock', async () => {
  for (const device of [{ revoked_at: new Date('2026-10-01T00:00:00.000Z') }, undefined]) {
    const context = setup({ device });
    expect(
      await context.service.record(command({ type: 'privacy', accepted: false }, null)),
    ).toEqual({ code: 20001, data: { fields: ['X-Device-Id'] } });
    expect(context.events).toEqual(['begin', 'lock:devices', 'commit']);
  }
});
