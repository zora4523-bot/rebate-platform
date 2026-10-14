import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { vi } from 'vitest';

export interface Clock {
  now(): Date;
  set(value: Date | string): void;
  advanceMs(value: number): void;
}
export interface Command {
  app_id: string;
  user_id: string;
  state: 'normal' | 'frozen' | 'appealing' | 'banned';
  reason: string | null;
  reason_category: 'other' | null;
  frozen_until: Date | null;
  changed_by: string;
}
export interface RiskState {
  setRiskState(trx: Transaction<DB>, command: Command): Promise<void>;
}
export interface Job {
  id: string;
  queue: string;
  name: string;
  payload: Record<string, never>;
  attempt: number;
}
export interface SendOptions {
  trx: Transaction<DB> | null;
  singletonKey?: string;
  delaySeconds?: number;
}
export interface Scan {
  expireFrozen(): Promise<void>;
  dailyAlerts(): Promise<void>;
  seed(): Promise<void>;
  handle(job: Job): Promise<void>;
}
export interface Options {
  db: Kysely<DB>;
  clock: Clock;
  riskState: RiskState;
  queue: {
    send(
      queue: string,
      name: string,
      payload: unknown,
      options: SendOptions,
    ): Promise<string | null>;
  };
  logger: unknown;
}
export async function createScan(options: Options): Promise<Scan> {
  const { createRiskScan } = (await import(
    new URL('../../../../apps/api/src/modules/risk/application/risk-scan.ts', import.meta.url).href
  )) as { createRiskScan(options: Options): Scan };
  return createRiskScan(options);
}

export async function ports() {
  const { FixedClock } = (await import(
    new URL('../../../../apps/api/src/modules/platform/clock/index.ts', import.meta.url).href
  )) as { FixedClock: new (now: string) => Clock };
  const lines: string[] = [];
  const { createRootLogger } = (await import(
    new URL('../../../../apps/api/src/modules/platform/logging/logger.ts', import.meta.url).href
  )) as { createRootLogger(options: object, destination: { write(line: string): void }): unknown };
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line) => void lines.push(line) },
  );
  const clock = new FixedClock('2026-10-15T00:00:00+08:00');
  const send = vi.fn<Options['queue']['send']>(async () => randomUUID());
  return { clock, logger, lines, send, queue: { send } };
}

export const DAY = 86_400_000;
export const PRIVATE_REASON = 'private-freeze-reason-do-not-log';
export const PRIVATE_CONTENT = 'private-appeal-content-do-not-log';

// Each integration test owns a migrated database: scans intentionally cross every app_id.
// Existing globalSetup reads TEST_PG_ADMIN_URL; never connect directly to another database.
export async function fixture() {
  const { createTestDatabase } = (await import(
    new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
  )) as { createTestDatabase(): Promise<{ urlFor(role: string): string; drop(): Promise<void> }> };
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 }).withSchema('app');
  const p = await ports();
  // event_log partitions follow the test database's date, so use that date for persisted events.
  const time = await sql<{ now: Date }>`SELECT now() AS now`.execute(db);
  p.clock.set(time.rows[0]!.now);
  const { createEventBus } = (await import(
    new URL('../../../../apps/api/src/modules/platform/events/events.ts', import.meta.url).href
  )) as {
    createEventBus(options: object): {
      publish(trx: Transaction<DB>, event: unknown): Promise<unknown>;
    };
  };
  const events = createEventBus({ clock: p.clock, queue: p.queue, subscriptions: [] });
  const publishEvent = events.publish.bind(events);
  const publish = vi.spyOn(events, 'publish');
  const { createRiskStateService, RiskStateConflictError } = (await import(
    new URL('../../../../apps/api/src/modules/risk/application/risk-state.ts', import.meta.url).href
  )) as {
    createRiskStateService(options: object): RiskState;
    RiskStateConflictError: new () => Error;
  };
  const riskState = createRiskStateService({ db, clock: p.clock, events });
  const writeState = riskState.setRiskState.bind(riskState);
  const setRiskState = vi.spyOn(riskState, 'setRiskState');
  const options: Options = { ...p, db, riskState };
  return {
    ...p,
    db,
    options,
    riskState,
    setRiskState,
    publish,
    publishEvent,
    writeState,
    RiskStateConflictError,
    service: () => createScan(options),
    async close() {
      await destroyDb(db);
      await database.drop();
    },
    async user(input: Partial<Command> & { changed_at?: Date } = {}) {
      const app_id = input.app_id ?? `scan_${randomBytes(8).toString('hex')}`;
      const user_id = randomUUID();
      await db
        .insertInto('users')
        .values({
          id: user_id,
          app_id,
          nickname: 'fixture',
          avatar: 'fixture',
          invite_code: randomBytes(8).toString('hex'),
          attr_code: randomBytes(8).toString('hex'),
          level: 'L1',
          register_method: 'sms',
          status: 'normal',
        })
        .execute();
      const state = input.state ?? 'frozen';
      await db
        .insertInto('user_risk_state')
        .values({
          app_id,
          user_id,
          state,
          reason: state === 'normal' ? null : PRIVATE_REASON,
          reason_category: state === 'normal' ? null : 'other',
          frozen_until: input.frozen_until === undefined ? p.clock.now() : input.frozen_until,
          changed_by: 'fixture',
          changed_at: input.changed_at ?? p.clock.now(),
          row_version: 7,
        })
        .execute();
      return { app_id, user_id };
    },
    states: () => db.selectFrom('user_risk_state').selectAll().orderBy('user_id').execute(),
    eventRows: () => db.selectFrom('event_log').selectAll().orderBy('id').execute(),
    appeals: () => db.selectFrom('appeals').selectAll().orderBy('id').execute(),
    async appeal(
      subject: { app_id: string; user_id: string },
      input: {
        deadline_at: Date;
        status?: 'processing' | 'upheld' | 'revoked';
        target_type?: 'account' | 'order' | 'blocked_request';
      },
    ) {
      const id = randomUUID();
      const status = input.status ?? 'processing';
      const target_type = input.target_type ?? 'account';
      await db
        .insertInto('appeals')
        .values({
          id,
          ...subject,
          status,
          target_type,
          target_id: target_type === 'account' ? subject.user_id : randomUUID(),
          prev_risk_state: target_type === 'account' ? 'frozen' : null,
          request_type: target_type === 'blocked_request' ? 'withdraw' : null,
          content: PRIVATE_CONTENT,
          deadline_at: input.deadline_at,
          handler_id: status === 'processing' ? null : 'fixture-admin',
          closed_at: status === 'processing' ? null : p.clock.now(),
        })
        .execute();
      return id;
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function warnings(lines: string[], message: string): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['level'] === 40 && line['msg'] === message);
}
export function job(name: 'freeze-expiry' | 'daily-alerts'): Job {
  return { id: randomUUID(), queue: 'risk-scan', name, payload: {}, attempt: 1 };
}
