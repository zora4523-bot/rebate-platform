import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { connect, newAccount, newUser, sqlState } from '../linking-bindings/kit.ts';
import {
  LATER,
  OCCURRED,
  RESOLVED,
  TIMEOUT,
  accepted,
  fixture,
  insert,
  requireShape,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
}, TIMEOUT);

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
}, TIMEOUT);

type Subject = { app_id: string; user_id: string; platform: string };

// Storage query from the task excerpt; this does not claim coverage of the recovery API.
async function unresolvedAt(subject: Subject, at: Date): Promise<string[]> {
  const result = await sql<{ id: string }>`SELECT id FROM app.union_binding_conflicts
    WHERE app_id = ${subject.app_id} AND user_id = ${subject.user_id} AND platform = ${subject.platform}
      AND occurred_at <= ${at} AND (resolved_at IS NULL OR resolved_at > ${at})
    ORDER BY id`.execute(app);
  return result.rows.map((row) => row.id);
}

it(
  '[AC-B1-06y#23] attr_at includes occurrence, excludes resolution, and never includes immediate already_active rows',
  async () => {
    await requireShape();
    const base = await fixture();
    const ids = new Map<string, string>();
    for (const entry of [
      {
        label: 'open',
        kind: 'occupied',
        occurred_at: OCCURRED,
        resolved_at: null,
        resolution: null,
      },
      {
        label: 'later-resolved',
        kind: 'cooling',
        occurred_at: OCCURRED,
        resolved_at: RESOLVED,
        resolution: 'bound_active',
      },
      { label: 'future', kind: 'rebind', occurred_at: LATER, resolved_at: null, resolution: null },
      {
        label: 'immediate',
        kind: 'occupied',
        occurred_at: OCCURRED,
        resolved_at: OCCURRED,
        resolution: 'already_active',
      },
      {
        label: 'immediate-later',
        kind: 'cooling',
        occurred_at: RESOLVED,
        resolved_at: RESOLVED,
        resolution: 'already_active',
      },
      {
        label: 'new-at-resolution',
        kind: 'rebind',
        occurred_at: RESOLVED,
        resolved_at: LATER,
        resolution: 'bound_active',
      },
    ]) {
      const { label, ...values } = entry;
      const id = randomUUID();
      ids.set(label, id);
      expect(await sqlState(insert(app, { ...base, id, ...values })), label).toBe('no error');
    }
    const cases: { at: Date; expected: string[] }[] = [
      { at: new Date('2026-10-09T00:59:59.999Z'), expected: [] },
      { at: OCCURRED, expected: ['open', 'later-resolved'] },
      { at: new Date('2026-10-09T01:00:00.001Z'), expected: ['open', 'later-resolved'] },
      { at: new Date('2026-10-09T01:59:59.999Z'), expected: ['open', 'later-resolved'] },
      { at: RESOLVED, expected: ['open', 'new-at-resolution'] },
      { at: new Date('2026-10-09T02:59:59.999Z'), expected: ['open', 'new-at-resolution'] },
      { at: LATER, expected: ['open', 'future'] },
      { at: new Date('2026-10-10T00:00:00.000Z'), expected: ['open', 'future'] },
    ];
    for (const { at, expected } of cases) {
      expect(await unresolvedAt(base, at), at.toISOString()).toEqual(
        expected.map((label) => ids.get(label)!).sort(),
      );
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#24] later resolution preserves the earlier attr_at evidence while removing current conflict',
  async () => {
    await requireShape();
    const row = await accepted(app);
    expect(await unresolvedAt(row, OCCURRED)).toEqual([row.id]);
    expect(await unresolvedAt(row, LATER)).toEqual([row.id]);
    expect(
      await sqlState(
        sql`UPDATE app.union_binding_conflicts
    SET resolved_at = ${RESOLVED}, resolution = 'bound_active' WHERE id = ${row.id}`.execute(app),
      ),
    ).toBe('no error');
    expect(await unresolvedAt(row, OCCURRED)).toEqual([row.id]);
    expect(await unresolvedAt(row, RESOLVED)).toEqual([]);
    expect(await unresolvedAt(row, LATER)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#25] current and historical queries isolate app, user and platform',
  async () => {
    await requireShape();
    const own = await accepted(app);
    const otherUser = { ...own, id: randomUUID(), user_id: await newUser() };
    const otherPlatform = {
      ...own,
      id: randomUUID(),
      platform: 'pdd',
      union_account_id: await newAccount('couli', 'pdd'),
    };
    expect(await sqlState(insert(app, otherUser))).toBe('no error');
    expect(await sqlState(insert(app, otherPlatform))).toBe('no error');
    const otherApp = await accepted(app, { app_id: 'couli_fixture_other' });
    for (const subject of [own, otherUser, otherPlatform, otherApp]) {
      expect(await unresolvedAt(subject, OCCURRED)).toEqual([subject.id]);
      const current = await sql<{ id: string }>`SELECT id FROM app.union_binding_conflicts
      WHERE app_id = ${subject.app_id} AND user_id = ${subject.user_id}
        AND platform = ${subject.platform} AND resolved_at IS NULL`.execute(app);
      expect(current.rows).toEqual([{ id: subject.id }]);
    }
    expect(await unresolvedAt({ ...own, app_id: 'couli_fixture_absent' }, OCCURRED)).toEqual([]);
  },
  TIMEOUT,
);
