import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  APP_UPDATES,
  AT,
  PAYOUT_UPDATES,
  ROLES,
  SHAPES,
  TIMEOUT,
  close,
  hold,
  insert,
  open,
  person,
  ready,
  sqlState,
  stored,
  update,
  withdrawal,
  type Harness,
  type Row,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

for (const table of ['withdrawals', 'withdraw_holds'] as const) {
  it(`[AC-B2-05b#13] ${table} 四角色表级及逐列有效权限精确匹配最小授权`, async () => {
    await ready(h.app, table);
    for (const role of ROLES) {
      const readable = role !== 'couli_maint';
      const insertable = role === 'couli_app';
      const updates =
        table === 'withdrawals'
          ? role === 'couli_app'
            ? APP_UPDATES
            : role === 'couli_payout'
              ? PAYOUT_UPDATES
              : []
          : role === 'couli_app'
            ? ['released_at', 'released_by']
            : [];
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
        'MAINTAIN',
      ]) {
        const expected =
          privilege === 'SELECT' ? readable : privilege === 'INSERT' ? insertable : false;
        const found = await sql<{ granted: boolean }>`SELECT
          has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS granted`.execute(h.app);
        expect(found.rows, `${role}/${table}/${privilege}`).toEqual([{ granted: expected }]);
      }
      for (const column of Object.keys(SHAPES[table])) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const expected =
            privilege === 'SELECT'
              ? readable
              : privilege === 'INSERT'
                ? insertable
                : privilege === 'UPDATE'
                  ? updates.includes(column)
                  : false;
          const found = await sql<{ granted: boolean }>`SELECT
            has_column_privilege(${role}, ${`app.${table}`}, ${column}, ${privilege}) AS granted`.execute(
            h.app,
          );
          expect(found.rows, `${role}/${table}/${column}/${privilege}`).toEqual([
            { granted: expected },
          ]);
        }
      }
    }
  });

  it(`[AC-B2-05b#14] ${table} 业务角色可读，只有 app 可插入，DELETE/TRUNCATE 一律被拒`, async () => {
    await ready(h.app, table);
    const owner = await person(h.app);
    const row = table === 'withdrawals' ? withdrawal(owner) : hold(owner);
    expect(await sqlState(insert(h.app, table, row))).toBe('ok');
    const before = await stored(h.app, table, row['id']);
    expect(before).toHaveLength(1);
    for (const role of ROLES) {
      const db = h.roles[role];
      if (role === 'couli_maint')
        expect(await sqlState(stored(db, table, row['id']))).toBe('42501');
      else expect(await stored(db, table, row['id'])).toEqual(before);
      if (role !== 'couli_app') {
        const next = table === 'withdrawals' ? withdrawal(owner) : hold(owner);
        expect(await sqlState(insert(db, table, next)), role).toBe('42501');
      }
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db),
        ),
        role,
      ).toBe('42501');
      expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(db)), role).toBe(
        '42501',
      );
      expect(await stored(h.app, table, row['id'])).toEqual(before);
    }
  });
}

it('[AC-B2-05b#15] app 可审核和冻结、payout 可写打款结果，禁止金额/归属/快照/业务号变动', async () => {
  await ready(h.app);
  const row = withdrawal(await person(h.app));
  await insert(h.app, 'withdrawals', row);
  await update(h.app, 'withdrawals', row['id'], {
    status: 'APPROVED',
    review_mode: 'manual',
    reviewed_at: AT,
    hold_reason: 'member_blocked',
    hold_at: AT,
    blocked_reason: 'NEGATIVE_BALANCE',
  });
  expect((await stored(h.app, 'withdrawals', row['id']))[0]).toMatchObject({
    status: 'APPROVED',
    hold_reason: 'member_blocked',
  });
  await update(h.roles.couli_payout, 'withdrawals', row['id'], {
    status: 'PAYING',
    hold_reason: null,
    hold_at: null,
  });
  const channelOrder = `paid-${randomUUID()}`;
  await update(h.roles.couli_payout, 'withdrawals', row['id'], {
    status: 'PAID_API',
    paid_at: AT,
    channel_order_id: channelOrder,
  });
  const before = await stored(h.app, 'withdrawals', row['id']);
  expect(before[0]).toMatchObject({
    status: 'PAID_API',
    paid_at: AT,
    channel_order_id: channelOrder,
  });
  const forbidden: Row[] = [
    { amount_fen: 1001n, net_fen: 1001n },
    { fee_fen: 1n, net_fen: 999n },
    { tax_fen: 1n, net_fen: 999n },
    { net_fen: 1000n },
    { app_id: row['app_id'] },
    { user_id: row['user_id'] },
    { created_at: AT },
    { payee_name: '另一个人' },
    { payee_hmac: 'different-hmac' },
    { payee_account_cipher: Buffer.from('changed') },
    { payout_method: 'alipay' },
    { income_type: 'SERVICE_FEE' },
    { fee_rule_id: null },
    { tax_rule_version: 'v2' },
    // Both changing and assigning the same business number must be rejected.
    { out_biz_no: 'REPLACED' },
    { out_biz_no: row['out_biz_no'] },
  ];
  for (const role of ['couli_app', 'couli_payout'] as const) {
    for (const values of forbidden) {
      expect(
        await sqlState(update(h.roles[role], 'withdrawals', row['id'], values)),
        `${role}/${Object.keys(values).join(',')}`,
      ).toBe('42501');
      expect(await stored(h.app, 'withdrawals', row['id'])).toEqual(before);
    }
  }
  const manualRow = withdrawal(await person(h.app), { status: 'PAYING', needs_manual: true });
  await insert(h.app, 'withdrawals', manualRow);
  const operatorId = randomUUID();
  const resolution = {
    status: 'PAID_MANUAL',
    paid_at: AT,
    channel_order_id: `manual-${randomUUID()}`,
    fail_code: 'UNKNOWN_RESULT',
    manual_resolution: 'paid',
    resolver_ids: JSON.stringify([operatorId]),
    proof_file: 'fixture-proof',
    manual_entry_by: operatorId,
    manual_confirm_by: operatorId,
  };
  expect(await sqlState(update(h.app, 'withdrawals', manualRow['id'], resolution))).toBe('ok');
  expect((await stored(h.app, 'withdrawals', manualRow['id']))[0]).toMatchObject({
    ...resolution,
    resolver_ids: [operatorId],
  });
  expect(
    await sqlState(update(h.roles.couli_payout, 'withdrawals', row['id'], { review_mode: 'auto' })),
  ).toBe('42501');
  for (const role of ['couli_readonly', 'couli_maint'] as const) {
    expect(
      await sqlState(update(h.roles[role], 'withdrawals', row['id'], { status: 'FAILED' })),
    ).toBe('42501');
  }
});

it('[AC-B2-05b#16] withdraw_holds 只能由 app 成对写解除字段，不能改冻结原因或期限', async () => {
  await ready(h.app, 'withdraw_holds');
  const row = hold(await person(h.app));
  await insert(h.app, 'withdraw_holds', row);
  expect(await sqlState(update(h.app, 'withdraw_holds', row['id'], { released_at: AT }))).toBe(
    '23514',
  );
  expect(
    await sqlState(update(h.app, 'withdraw_holds', row['id'], { released_by: 'system:release' })),
  ).toBe('23514');
  for (const role of ['couli_payout', 'couli_readonly', 'couli_maint'] as const) {
    expect(
      await sqlState(
        update(h.roles[role], 'withdraw_holds', row['id'], {
          released_at: AT,
          released_by: 'system:release',
        }),
      ),
    ).toBe('42501');
  }
  for (const values of [
    { reason: 'recon_diff' },
    { hold_until: AT },
    { user_id: row['user_id'] },
    { source_ref: 'replacement' },
    { created_by: 'other' },
  ]) {
    expect(await sqlState(update(h.app, 'withdraw_holds', row['id'], values))).toBe('42501');
  }
  await update(h.app, 'withdraw_holds', row['id'], {
    released_at: AT,
    released_by: 'system:release',
  });
  expect(await stored(h.app, 'withdraw_holds', row['id'])).toEqual([
    expect.objectContaining({ ...row, released_at: AT, released_by: 'system:release' }),
  ]);
});
