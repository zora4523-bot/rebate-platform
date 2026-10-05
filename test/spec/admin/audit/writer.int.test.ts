import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import type {
  AuditInput,
  AuditPort,
} from '../../../../apps/api/src/modules/platform/audit/port.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

// Global setup manages database provisioning and supplies couli_app credentials.
// This file must only run in the orchestrator's isolated container.
let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
});

afterAll(async () => {
  if (db !== undefined) await destroyDb(db);
  if (database !== undefined) await database.drop();
});

async function input(): Promise<AuditInput> {
  const id = randomUUID();
  await db
    .insertInto('admin_users')
    .values({
      id,
      app_id: 'couli',
      login_name: `audit-rule-${id}`,
      password_hash: 'fixture-unused-hash',
      is_super: true,
      status: 'fixture-enabled',
    })
    .execute();
  return {
    appId: 'couli',
    actor: id,
    action: 'fixture.permission.grant',
    target: `admin:${id}`,
    before: { permissions: [], phone_masked: '138****0000' },
    after: { permissions: ['fixture.permission'], phone_masked: '138****0000' },
    ip: '192.0.2.17',
  };
}

function rows(actor: string) {
  return db
    .selectFrom('audit_logs')
    .selectAll()
    .where('admin_id', '=', actor)
    .orderBy('id')
    .execute();
}

it('[AC-F1-06b-AUDIT#1] append persists exactly one row with actor and all fields aligned', async () => {
  const clock = new FixedClock('2031-06-07T08:09:10.123Z');
  const writer: AuditPort = createAuditWriter({ db, clock });
  const event = await input();
  await writer.append(event);
  const actual = await rows(event.actor);
  expect(actual).toHaveLength(1);
  expect(actual[0]).toMatchObject({
    app_id: event.appId,
    admin_id: event.actor,
    action: event.action,
    target: event.target,
    before: event.before,
    after: event.after,
    ip: event.ip,
    at: clock.now(),
  });
  expect(typeof actual[0]!.id).toBe('bigint');
});

it('[AC-F1-06b-AUDIT#2] each append reads Clock; a caller-supplied at cannot replace it', async () => {
  const clock = new FixedClock('2032-01-02T03:04:05.678Z');
  const writer: AuditPort = createAuditWriter({ db, clock });
  const event = await input();
  const forged = { ...event, at: new Date('2000-01-01T00:00:00Z') };
  await writer.append(forged);
  const first = (await rows(event.actor))[0]!;
  expect(first.at).toEqual(clock.now());
  clock.advanceMs(12_345);
  await writer.append({ ...event, action: 'fixture.permission.revoke' });
  const actual = await rows(event.actor);
  expect(actual).toHaveLength(2);
  expect(actual[0]).toEqual(first);
  expect(actual[1]!.at).toEqual(clock.now());
  expect(actual[1]!.action).toBe('fixture.permission.revoke');
});

it('[AC-F1-06b-AUDIT#3] absence of snapshots, target and IP is preserved as SQL NULL', async () => {
  const clock = new FixedClock('2031-06-07T08:09:10Z');
  const writer: AuditPort = createAuditWriter({ db, clock });
  const event = { ...(await input()), target: null, before: null, after: null, ip: null };
  await writer.append(event);
  const actual = await rows(event.actor);
  expect(actual).toHaveLength(1);
  expect(actual[0]).toMatchObject({ target: null, before: null, after: null, ip: null });
});

it('[AC-F1-06b-AUDIT#4] audit capability exposes append and no update or delete operation', () => {
  const writer: AuditPort = createAuditWriter({
    db,
    clock: new FixedClock('2031-06-07T08:09:10Z'),
  });
  const methods = new Set<string>();
  let object: object | null = writer;
  while (object !== null && object !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (name !== 'constructor' && typeof descriptor?.value === 'function') methods.add(name);
    }
    object = Object.getPrototypeOf(object) as object | null;
  }
  expect([...methods].sort()).toEqual(['append']);
  // Type-level port boundary: these accesses must remain errors after implementation.
  // @ts-expect-error audit is append-only
  expect(writer.update).toBeUndefined();
  // @ts-expect-error audit is append-only
  expect(writer.delete).toBeUndefined();
});
