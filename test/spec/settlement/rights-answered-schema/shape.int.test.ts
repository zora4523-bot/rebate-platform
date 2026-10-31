// B2-04lb rule tests (money r1 S0; 编排裁定 D10-483): app.order_rights.answered_at on a migrated
// test database: the column exists, timestamptz, NULL allowed, no default; main's columns are
// unchanged; a row written the way main writes it (answered_at not named) stores NULL, and the
// writer can set and keep the instant.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ANSWERED_AT,
  SHAPE,
  TIMEOUT,
  close,
  columns,
  insert,
  open,
  orderKey,
  ready,
  rights,
  sqlState,
  stored,
  update,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-04lb#27] D10-483 order_rights.answered_at：列存在、类型 timestamptz、可空、无默认值；其余列名、类型、可空性与默认值与主干一致', async () => {
  await ready(h.app);
  const found = await columns(h.app);
  expect(found.map((c) => c.name).sort()).toEqual(Object.keys(SHAPE).sort());
  expect(found).toContainEqual({
    name: 'answered_at',
    type: 'timestamptz',
    nullable: true,
    default_expr: null,
  });
  for (const [name, [type, nullable, default_expr]] of Object.entries(SHAPE)) {
    expect(found, name).toContainEqual({ name, type, nullable, default_expr });
  }
});

it('[AC-B2-04lb#28] D10-483 只加列、不回填：按主干写法插入（不写 answered_at）的维权记录该列为空；迁移后库内没有 answered_at 非空的存量行', async () => {
  await ready(h.app);
  const { appId, orderId } = await orderKey(h.app);
  const rows = [
    rights(appId, orderId),
    rights(appId, orderId, { status: 'WAIT_COMMISSION', deduction_commission_fen: null }),
    rights(appId, orderId, { status: 'PROCESSING', deduction_commission_fen: null }),
    rights(appId, orderId, { status: 'FAILED' }),
  ];
  for (const row of rows) {
    expect(await sqlState(insert(h.app, row)), String(row['status'])).toBe('ok');
    expect(await stored(h.app, row['id']), String(row['status'])).toEqual([
      expect.objectContaining({ id: row['id'], answered_at: null }),
    ]);
  }
  const others = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.order_rights
    WHERE answered_at IS NOT NULL AND app_id <> ${appId}`.execute(h.app);
  expect(others.rows).toEqual([{ n: '0' }]);
});

it('[AC-B2-04lb#29] D10-483 settlement 写入角色 couli_app 可把 answered_at 置为联盟回传时刻并原样读回（timestamptz 不丢时区），也可在同一行再改；其余列不受影响', async () => {
  await ready(h.app);
  const { appId, orderId } = await orderKey(h.app);
  const row = rights(appId, orderId);
  await insert(h.app, row);
  const before = (await stored(h.app, row['id']))[0] ?? {};
  expect(before['answered_at']).toBeNull();
  expect(await sqlState(update(h.app, row['id'], { answered_at: ANSWERED_AT }))).toBe('ok');
  expect(await stored(h.app, row['id'])).toEqual([{ ...before, answered_at: ANSWERED_AT }]);
  const later = new Date(ANSWERED_AT.getTime() + 1);
  expect(await sqlState(update(h.app, row['id'], { answered_at: later }))).toBe('ok');
  expect((await stored(h.app, row['id']))[0]?.['answered_at']).toEqual(later);
});
