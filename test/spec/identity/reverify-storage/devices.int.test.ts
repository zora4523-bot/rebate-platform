// B1-02zo 编排 §9.2 #1 / §9.3: app.reverified_devices records a device that passed reverify
// (BR-WDR-01 细则: long-lived, the account flag stays). One row per (app, user, device_hash);
// source is self or admin; the owner reference stays inside the same app and never cascades.
// Top-level it() only; each test preflights the table contract first.
import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  NOT_NULL_VIOLATION,
  NO_ERROR,
  UNIQUE_VIOLATION,
  close,
  devicesOf,
  expectDeviceTable,
  hash,
  insertDevice,
  open,
  person,
  sqlState,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open();
}, 180_000);
afterAll(async () => {
  await close(h);
});

it('[AC-B1-02zo#4] reverified_devices 列为 id / app_id / user_id / device_hash / source / created_at，全部 NOT NULL，主键 id，created_at 有默认值', async () => {
  await expectDeviceTable(h.app);
  const primary = await sql<{ keys: string[] }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.pos) AS keys
    FROM pg_constraint c
    WHERE c.conrelid = 'app.reverified_devices'::regclass AND c.contype = 'p'`.execute(h.app);
  expect(primary.rows).toEqual([{ keys: ['id'] }]);

  const owner = await person(h.app);
  const id = randomUUID();
  const device = hash();
  const result = await insertDevice(h.app, owner, device, 'self', id);
  expect(result.rows).toEqual([
    {
      id,
      app_id: owner.app_id,
      user_id: owner.user_id,
      device_hash: device,
      source: 'self',
      created_at: expect.any(Date),
    },
  ]);
  for (const column of ['id', 'app_id', 'user_id', 'device_hash']) {
    const values: Record<string, unknown> = {
      id: randomUUID(),
      app_id: owner.app_id,
      user_id: owner.user_id,
      device_hash: hash(),
      source: 'admin',
      [column]: null,
    };
    const statement = sql`INSERT INTO app.reverified_devices (id, app_id, user_id, device_hash, source)
      VALUES (${values['id']}::uuid, ${values['app_id']}::text, ${values['user_id']}::uuid,
        ${values['device_hash']}::text, ${values['source']})`;
    expect(await sqlState(statement.execute(h.app)), column).toBe(NOT_NULL_VIOLATION);
  }
  expect(await devicesOf(h.app, owner)).toEqual([{ device_hash: device, source: 'self' }]);
});

it('[AC-B1-02zo#5] 同 (app_id, user_id, device_hash) 第二次插入冲突（换 id、换 source 也冲突）；同用户别的设备、同 app 别的用户、别的 app 的用户各自独立', async () => {
  await expectDeviceTable(h.app);
  const app = `reverify_${randomUUID().replaceAll('-', '')}`;
  const other = `reverify_${randomUUID().replaceAll('-', '')}`;
  const a = await person(h.app, app);
  const b = await person(h.app, app);
  const c = await person(h.app, other);
  const first = hash();
  const second = hash();

  expect(await sqlState(insertDevice(h.app, a, first, 'self'))).toBe(NO_ERROR);
  expect(await sqlState(insertDevice(h.app, a, first, 'self'))).toBe(UNIQUE_VIOLATION);
  expect(await sqlState(insertDevice(h.app, a, first, 'admin'))).toBe(UNIQUE_VIOLATION);
  expect(await sqlState(insertDevice(h.app, a, second, 'admin'))).toBe(NO_ERROR);
  expect(await sqlState(insertDevice(h.app, b, first, 'self'))).toBe(NO_ERROR);
  expect(await sqlState(insertDevice(h.app, c, first, 'self'))).toBe(NO_ERROR);

  // Order-free comparison: the database collation decides ORDER BY, not this test.
  const ofA = await devicesOf(h.app, a);
  expect(ofA).toHaveLength(2);
  expect(ofA).toEqual(
    expect.arrayContaining([
      { device_hash: first, source: 'self' },
      { device_hash: second, source: 'admin' },
    ]),
  );
  expect(await devicesOf(h.app, b)).toEqual([{ device_hash: first, source: 'self' }]);
  expect(await devicesOf(h.app, c)).toEqual([{ device_hash: first, source: 'self' }]);
  const perApp = await sql<{ app_id: string; n: number }>`
    SELECT app_id, count(*)::int AS n FROM app.reverified_devices
    WHERE app_id IN (${app}, ${other}) GROUP BY app_id ORDER BY n DESC`.execute(h.app);
  expect(perApp.rows).toEqual([
    { app_id: app, n: 3 },
    { app_id: other, n: 1 },
  ]);
});

it('[AC-B1-02zo#6] source 只接受 self 与 admin：大小写、空白、空串、其他值被 CHECK 拒绝，NULL 被 NOT NULL 拒绝', async () => {
  await expectDeviceTable(h.app);
  const owner = await person(h.app);
  for (const source of ['self', 'admin']) {
    expect(await sqlState(insertDevice(h.app, owner, hash(), source)), source).toBe(NO_ERROR);
  }
  for (const source of ['SELF', 'Admin', ' self', 'admin ', '', 'system', 'manual', 'oauth']) {
    expect(await sqlState(insertDevice(h.app, owner, hash(), source)), JSON.stringify(source)).toBe(
      CHECK_VIOLATION,
    );
  }
  expect(await sqlState(insertDevice(h.app, owner, hash(), null))).toBe(NOT_NULL_VIOLATION);
  expect((await devicesOf(h.app, owner)).map((row) => row.source).sort()).toEqual([
    'admin',
    'self',
  ]);
});

it('[AC-B1-02zo#7] 外键 (app_id, user_id) → users (app_id, id) 不级联：不存在的用户、别的 app 的用户被拒，有已加验设备的用户不能被删', async () => {
  await expectDeviceTable(h.app);
  const fk = await sql`SELECT c.confrelid::regclass::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.pos) AS keys,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.pos) AS target_keys,
      c.confdeltype IN ('a', 'r') AS no_delete_action,
      c.confupdtype IN ('a', 'r') AS no_update_action,
      c.convalidated AS validated
    FROM pg_constraint c
    WHERE c.conrelid = 'app.reverified_devices'::regclass AND c.contype = 'f'`.execute(h.app);
  expect(fk.rows).toEqual([
    {
      target: 'app.users',
      keys: ['app_id', 'user_id'],
      target_keys: ['app_id', 'id'],
      no_delete_action: true,
      no_update_action: true,
      validated: true,
    },
  ]);

  const owner = await person(h.app);
  const elsewhere = await person(h.app);
  const ghost = { app_id: owner.app_id, user_id: randomUUID() };
  expect(await sqlState(insertDevice(h.app, ghost, hash(), 'self'))).toBe(FOREIGN_KEY_VIOLATION);
  // The user exists, but in another app: the reference must include app_id.
  const crossApp = { app_id: elsewhere.app_id, user_id: owner.user_id };
  expect(await sqlState(insertDevice(h.app, crossApp, hash(), 'self'))).toBe(FOREIGN_KEY_VIOLATION);
  expect(await devicesOf(h.app, crossApp)).toEqual([]);

  const device = hash();
  expect(await sqlState(insertDevice(h.app, owner, device, 'admin'))).toBe(NO_ERROR);
  const remove = sql`DELETE FROM app.users WHERE id = ${owner.user_id}`;
  expect(await sqlState(remove.execute(h.app))).toBe(FOREIGN_KEY_VIOLATION);
  expect(await devicesOf(h.app, owner)).toEqual([{ device_hash: device, source: 'admin' }]);
  const still = await sql`SELECT id FROM app.users WHERE id = ${owner.user_id}`.execute(h.app);
  expect(still.rows).toHaveLength(1);
});
