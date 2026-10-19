import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger } from '../../platform/index.ts';
import type { BankCardVerifierPort } from '../ports/bank-card-verifier.ts';
import {
  VERIFY_INFLIGHT_KEY,
  VERIFY_PER_DAY_KEY,
  VERIFY_RECHECK_KEY,
  VERIFY_REUSE_KEY,
  callVendor,
  createPayoutAccountVerifyAttempts,
  isLegalTransition,
  leaseExpired,
  queryAttempt,
  recheckDue,
  reusable,
  verifySettings,
  type VerifyAttemptStatus,
} from './payout-account-verify-attempts.ts';
import type { PayoutAccountConfigPort } from './payout-account.ts';

const NOW = '2026-10-18T04:00:00.000Z';
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

function logs() {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { lines, logger };
}

/** A database that answers the attempt read with `row` and every UPDATE with `updated` rows. */
async function database(row: Record<string, unknown> | undefined, updated = 1n) {
  const queries: CompiledQuery[] = [];
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
    queries.push(query);
    if (query.sql.startsWith('update')) return { rows: [], numAffectedRows: updated };
    if (query.sql.includes('"payout_account_verify_attempts"')) {
      return { rows: (row === undefined ? [] : [row]) as R[] };
    }
    return { rows: [] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  return { db, queries, updates: () => queries.filter((q) => q.sql.startsWith('update')) };
}

function attempt(status: VerifyAttemptStatus, overrides: Record<string, unknown> = {}) {
  return {
    id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
    app_id: 'app_a',
    user_id: '00000000-0000-7000-8000-000000000001',
    verify_date: '2026-10-18',
    status,
    vendor_request_id: '0199a3b4-0000-7000-8000-00000000abcd',
    reserved_at: new Date(NOW),
    unknown_at: status === 'unknown' ? new Date(NOW) : null,
    resolved_at: null,
    idempotency_key: 'key-00000001',
    row_version: 2,
    ...overrides,
  };
}

function configPort(values: Readonly<Record<string, unknown>> = {}): PayoutAccountConfigPort {
  return {
    configValue: (_appId, key) =>
      Promise.resolve(Object.hasOwn(values, key) ? { value: values[key] } : null),
  };
}

function verifierWith(query: BankCardVerifierPort['query']) {
  const verify = vi.fn<BankCardVerifierPort['verify']>();
  return { verify, query: vi.fn(query) };
}

const subject = { appId: 'app_a', id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b' };

it('[AC-B1-13f] the transition table: released and final states have no way in or out', () => {
  expect(isLegalTransition('reserved', 'unknown')).toBe(true);
  expect(isLegalTransition('reserved', 'matched')).toBe(true);
  expect(isLegalTransition('unknown', 'expired_unresolved')).toBe(true);
  expect(isLegalTransition('reserved', 'expired_unresolved')).toBe(false);
  expect(isLegalTransition('unknown', 'reserved')).toBe(false);
  for (const from of ['reserved', 'unknown', 'matched'] as const) {
    expect(isLegalTransition(from, 'released')).toBe(false);
  }
  for (const final of ['matched', 'mismatched', 'expired_unresolved', 'released'] as const) {
    for (const to of ['reserved', 'unknown', 'matched', 'mismatched'] as const) {
      expect(isLegalTransition(final, to)).toBe(false);
    }
  }
});

it('[AC-B1-13f] lease, recheck deadline and reuse period boundaries', () => {
  const at = (iso: string) => new Date(iso);
  const reserved = { reserved_at: at(NOW), unknown_at: null };
  expect(leaseExpired(reserved, at('2026-10-18T04:00:59.999Z'), 60)).toBe(false);
  expect(leaseExpired(reserved, at('2026-10-18T04:01:00.000Z'), 60)).toBe(true);
  const unknown = { reserved_at: at('2026-10-18T03:00:00Z'), unknown_at: at(NOW) };
  expect(recheckDue(unknown, at('2026-10-18T04:29:59.999Z'), 30)).toBe(false);
  expect(recheckDue(unknown, at('2026-10-18T04:30:00.000Z'), 30)).toBe(true);
  // A row without unknown_at measures from reserved_at.
  expect(recheckDue(reserved, at('2026-10-18T04:30:00.000Z'), 30)).toBe(true);
  const matched = { status: 'matched' as const, resolved_at: at(NOW) };
  expect(reusable(matched, at('2026-10-19T03:59:59.999Z'), 24)).toBe(true);
  expect(reusable(matched, at('2026-10-19T04:00:00.000Z'), 24)).toBe(false);
  expect(reusable({ ...matched, status: 'mismatched' }, at(NOW), 24)).toBe(false);
  expect(reusable({ ...matched, resolved_at: null }, at(NOW), 24)).toBe(false);
});

it.each([0, -1, 1.5, '2', null, undefined])(
  '[AC-B1-13f] verification setting %j falls back to the default with a config_key-only warning',
  (value) => {
    const { lines, logger } = logs();
    const config = new Map<string, unknown>(
      value === undefined ? [] : [[VERIFY_PER_DAY_KEY, value]],
    );
    config.set(VERIFY_INFLIGHT_KEY, 20);
    config.set(VERIFY_RECHECK_KEY, 1);
    config.set(VERIFY_REUSE_KEY, 2);
    expect(verifySettings(config, logger)).toEqual({
      perDay: 3,
      inflightSeconds: 20,
      recheckMinutes: 1,
      reuseHours: 2,
    });
    const warnings = lines.filter((line) => line['level'] === 40);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ config_key: VERIFY_PER_DAY_KEY });
    expect(warnings[0]).not.toHaveProperty('value');
    expect(warnings[0]).not.toHaveProperty('user_id');
  },
);

it('[AC-B1-13f] callVendor: value, rejection and hang never throw; a late answer is ignored', async () => {
  expect(await callVendor(() => Promise.resolve('match'))).toEqual({ value: 'match' });
  expect(await callVendor(() => Promise.reject(new Error('card 6222020000000000')))).toEqual({
    failure: 'error',
  });
  expect(
    await callVendor(() => {
      throw new Error('synchronous');
    }),
  ).toEqual({ failure: 'error' });
  let resolve!: (value: string) => void;
  const late = new Promise<string>((done) => {
    resolve = done;
  });
  expect(await callVendor(() => late, 5)).toEqual({ failure: 'timeout' });
  resolve('match');
  await late;
});

it('[AC-B1-13f] queryAttempt maps errors and unexpected answers to unknown without the message', async () => {
  const { lines, logger } = logs();
  const row = attempt('unknown');
  const failing = verifierWith(() => Promise.reject(new Error('id demo-id-secret')));
  expect(await queryAttempt(failing, row, logger)).toBe('unknown');
  const odd = verifierWith(() => Promise.resolve('maybe' as never));
  expect(await queryAttempt(odd, row, logger)).toBe('unknown');
  expect(JSON.stringify(lines)).not.toContain('demo-id-secret');
  expect(lines.map((line) => line['vendor_request_id'])).toEqual([
    row.vendor_request_id,
    row.vendor_request_id,
  ]);
});

it('[AC-B1-13f] takeover: a reserved row past its lease becomes unknown by CAS', async () => {
  const f = await database(attempt('reserved', { reserved_at: new Date('2026-10-18T03:58:59Z') }));
  const { logger } = logs();
  const verifier = verifierWith(() => Promise.resolve('match'));
  const service = createPayoutAccountVerifyAttempts({
    db: f.db,
    clock: new FixedClock(NOW),
    logger,
    verifier,
    config: configPort(),
  });
  await service.takeover(subject);
  const updates = f.updates();
  expect(updates).toHaveLength(1);
  expect(updates[0]!.sql).toBe(
    'update "app"."payout_account_verify_attempts" set "status" = $1, "row_version" = $2, "updated_at" = $3, "unknown_at" = $4 where "app_id" = $5 and "id" = $6 and "status" = $7 and "row_version" = $8',
  );
  expect(updates[0]!.parameters).toEqual([
    'unknown',
    3,
    new Date(NOW),
    new Date(NOW),
    'app_a',
    subject.id,
    'reserved',
    2,
  ]);
  expect(f.queries[0]!.sql).toContain('where "app_id" = $1 and "id" = $2');
  expect(verifier.query).not.toHaveBeenCalled();
});

it.each([
  ['in lease', attempt('reserved', { reserved_at: new Date('2026-10-18T03:59:30Z') }), {}],
  [
    'configured lease',
    attempt('reserved', { reserved_at: new Date('2026-10-18T03:59:30Z') }),
    {
      [VERIFY_INFLIGHT_KEY]: 40,
    },
  ],
  ['unknown', attempt('unknown'), {}],
  ['matched', attempt('matched'), {}],
  ['missing', undefined, {}],
] as const)('[AC-B1-13f] takeover leaves a row %s untouched', async (_name, row, values) => {
  const f = await database(row);
  const { logger } = logs();
  await createPayoutAccountVerifyAttempts({
    db: f.db,
    clock: new FixedClock(NOW),
    logger,
    verifier: null,
    config: configPort(values),
  }).takeover(subject);
  expect(f.updates()).toEqual([]);
});

it.each([
  ['match', 'matched'],
  ['mismatch', 'mismatched'],
  ['not_found', 'expired_unresolved'],
] as const)('[AC-B1-13f] recheck %s → %s by CAS with resolved_at', async (answer, status) => {
  const row = attempt('unknown');
  const f = await database(row);
  const { lines, logger } = logs();
  const verifier = verifierWith(() => Promise.resolve(answer));
  await createPayoutAccountVerifyAttempts({
    db: f.db,
    clock: new FixedClock('2026-10-18T04:05:00Z'),
    logger,
    verifier,
    config: configPort(),
  }).recheck(subject);
  expect(verifier.query).toHaveBeenCalledExactlyOnceWith(row.vendor_request_id);
  expect(verifier.verify).not.toHaveBeenCalled();
  const updates = f.updates();
  expect(updates).toHaveLength(1);
  expect(updates[0]!.sql).toContain('"resolved_at" = $4');
  expect(updates[0]!.parameters.slice(0, 2)).toEqual([status, 3]);
  expect(updates[0]!.parameters.slice(-2)).toEqual(['unknown', 2]);
  expect(lines.filter((line) => line['level'] === 50)).toEqual([]);
});

it('[AC-B1-13f] recheck without an answer before the deadline writes nothing', async () => {
  const f = await database(attempt('unknown'));
  const { logger } = logs();
  const verifier = verifierWith(() => Promise.resolve('unknown'));
  await createPayoutAccountVerifyAttempts({
    db: f.db,
    clock: new FixedClock('2026-10-18T04:29:59Z'),
    logger,
    verifier,
    config: configPort(),
  }).recheck(subject);
  expect(verifier.query).toHaveBeenCalledTimes(1);
  expect(f.updates()).toEqual([]);
});

it.each([true, false])(
  '[AC-B1-13f] recheck at the deadline (vendor assembled=%s) ends the row with one alarm line',
  async (assembled) => {
    const row = attempt('unknown');
    const f = await database(row);
    const { lines, logger } = logs();
    const verifier = verifierWith(() => Promise.resolve('unknown'));
    await createPayoutAccountVerifyAttempts({
      db: f.db,
      clock: new FixedClock('2026-10-18T04:30:00Z'),
      logger,
      verifier: assembled ? verifier : null,
      config: configPort(),
    }).recheck(subject);
    expect(verifier.query).toHaveBeenCalledTimes(assembled ? 1 : 0);
    expect(f.updates()[0]!.parameters.slice(0, 2)).toEqual(['expired_unresolved', 3]);
    const errors = lines.filter((line) => line['level'] === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      user_id: row.user_id,
      verify_date: '2026-10-18',
      vendor_request_id: row.vendor_request_id,
    });
    for (const field of ['app_id', 'request_fingerprint', 'idempotency_key', 'card_no']) {
      expect(errors[0]).not.toHaveProperty(field);
    }
  },
);

it('[AC-B1-13f] recheck that loses the CAS race raises no alarm', async () => {
  const f = await database(attempt('unknown'), 0n);
  const { lines, logger } = logs();
  await createPayoutAccountVerifyAttempts({
    db: f.db,
    clock: new FixedClock('2026-10-18T05:00:00Z'),
    logger,
    verifier: null,
    config: configPort(),
  }).recheck(subject);
  expect(f.updates()).toHaveLength(1);
  expect(lines.filter((line) => line['level'] === 50)).toEqual([]);
});

it.each(['reserved', 'matched', 'mismatched', 'expired_unresolved', 'released'] as const)(
  '[AC-B1-13f] recheck never queries a %s row',
  async (status) => {
    const f = await database(attempt(status));
    const { logger } = logs();
    const verifier = verifierWith(() => Promise.resolve('match'));
    await createPayoutAccountVerifyAttempts({
      db: f.db,
      clock: new FixedClock('2026-10-18T06:00:00Z'),
      logger,
      verifier,
      config: configPort(),
    }).recheck(subject);
    expect(verifier.query).not.toHaveBeenCalled();
    expect(f.updates()).toEqual([]);
  },
);
