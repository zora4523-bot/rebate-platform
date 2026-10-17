import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { TIMEOUT, close, insert, open, ready, sqlState, voucherRow, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-02c#22] BR-FUND-16 同 app 与 uniq_key 的凭证即使其他业务字段全变仍被拒绝', async () => {
  await ready(h.app);
  const original = voucherRow(`ledger-${randomUUID()}`, {
    order_key: randomUUID(),
    beneficiary_user_id: randomUUID(),
    role: 'self',
    voucher_kind: 'ORIGINAL',
  });
  const changed = voucherRow(original['app_id'], {
    uniq_key: original['uniq_key'],
    biz_type: 'REBATE_CREDIT',
    biz_id: randomUUID(),
    operator: 'synthetic-other-operator',
    memo: 'different synthetic voucher',
    accounting_date: '2032-07-16',
    order_key: randomUUID(),
    beneficiary_user_id: randomUUID(),
    role: 'direct',
    voucher_kind: 'REVERSE',
  });
  expect(await sqlState(insert(h.app, 'ledger_vouchers', original))).toBe('ok');
  // Prove the alternate field values are valid independently of the colliding key.
  expect(
    await sqlState(
      insert(h.app, 'ledger_vouchers', {
        ...changed,
        id: randomUUID(),
        uniq_key: `ADJ:${randomUUID()}`,
      }),
    ),
  ).toBe('ok');
  expect(await sqlState(insert(h.app, 'ledger_vouchers', changed))).toBe('23505');
});

it('[AC-B2-02c#23] BR-FUND-16 覆盖 uniq_key 的唯一约束列集合恰好为 app_id 与 uniq_key', async () => {
  await ready(h.app);
  const constraints = await sql<{ names: string[] }>`
    SELECT ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) AS k(num)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
      ORDER BY a.attname
    ) AS names
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.ledger_vouchers') AND c.contype IN ('u', 'p')
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) AND a.attname = 'uniq_key'
      )
  `.execute(h.app);
  expect(constraints.rows.length, '必须存在覆盖 uniq_key 的数据库唯一约束').toBeGreaterThan(0);
  for (const constraint of constraints.rows) {
    expect(constraint.names, '不得加入 biz_type、会计日或其他额外列').toEqual([
      'app_id',
      'uniq_key',
    ]);
  }
});

it('[AC-B2-02c#24] BR-FUND-16 不同 app_id 可使用相同 uniq_key', async () => {
  await ready(h.app);
  const original = voucherRow(`ledger-${randomUUID()}`);
  const otherApp = `ledger-${randomUUID()}`;
  expect(await sqlState(insert(h.app, 'ledger_vouchers', original))).toBe('ok');
  expect(
    await sqlState(
      insert(h.app, 'ledger_vouchers', { ...original, id: randomUUID(), app_id: otherApp }),
    ),
  ).toBe('ok');
  const stored = await sql<{ app_id: string }>`SELECT app_id FROM app.ledger_vouchers
    WHERE uniq_key = ${original['uniq_key']}`.execute(h.app);
  expect(stored.rows.map((row) => row.app_id).sort()).toEqual(
    [String(original['app_id']), otherApp].sort(),
  );
});
