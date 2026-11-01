import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { at, ATTR, pipeline, RECEIVED, snapshot } from '../attribution/kit.ts';
import { jdStatusMap, UNMAPPED } from './kit.ts';
import { jdFixture } from './pipeline-kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

const INSERTED: readonly (readonly [string, Omit<Partial<UnionOrder>, 'platform'>, string])[] = [
  ['16', {}, 'PAID'],
  ['24', { deposit_paid_at: at(ATTR), paid_at: null }, 'DEPOSIT_PAID'],
  ['17', { received_at: at(RECEIVED) }, 'RECEIVED'],
  ['2', {}, 'INVALID'],
  ['35', {}, 'INVALID'],
];

it.each(INSERTED)(
  '[AC-B1-04zg#21] 真实 jd.csv 接流水线：%s 入库后平台状态正确',
  async (rawStatus, patch, status) => {
    const map = jdStatusMap();
    const f = await jdFixture(db, { raw_status: rawStatus, ...patch }, map);
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const s = await snapshot(db, f.ctx.app_id);
    expect(s.orders).toEqual([
      expect.objectContaining({ platform: 'jd', platform_status: status }),
    ]);
    expect(s.pending).toEqual([]);
  },
);

it.each(UNMAPPED)(
  '[AC-B1-04zg#22] 真实 jd.csv 接流水线：表外码 %s 只进待处理，不建单',
  async (rawStatus) => {
    const map = jdStatusMap();
    const f = await jdFixture(db, { raw_status: rawStatus }, map);
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toEqual({
      kind: 'pending',
      reason: 'UNMAPPED_STATUS',
    });
    const s = await snapshot(db, f.ctx.app_id);
    expect(s.keys).toEqual([]);
    expect(s.orders).toEqual([]);
    expect(s.pending).toEqual([
      expect.objectContaining({ reason: 'UNMAPPED_STATUS', raw_status: rawStatus }),
    ]);
  },
);
