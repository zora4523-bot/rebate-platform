import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  HOLD_REASONS,
  REASONS,
  REJECT_REASONS,
  STATUSES,
  TIMEOUT,
  close,
  hold,
  insert,
  open,
  person,
  ready,
  sqlState,
  statusFields,
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

it('[AC-B2-05b#7] out_biz_no 在 app 内唯一，跨 app 可复用，ASCII 字母数字长度 1–32', async () => {
  await ready(h.app);
  const owner = await person(h.app);
  const row = withdrawal(owner);
  await insert(h.app, 'withdrawals', row);
  const peer = await person(h.app, owner.app_id);
  expect(
    await sqlState(
      insert(h.app, 'withdrawals', withdrawal(peer, { out_biz_no: row['out_biz_no'] })),
    ),
  ).toBe('23505');
  expect(
    await sqlState(
      insert(
        h.app,
        'withdrawals',
        withdrawal(await person(h.app), { out_biz_no: row['out_biz_no'] }),
      ),
    ),
  ).toBe('ok');
  for (const out_biz_no of ['', 'A'.repeat(33), '提现001', 'a-b', 'a_b', 'abc\n', 'a b', 'Ａ1']) {
    expect(
      await sqlState(insert(h.app, 'withdrawals', withdrawal(owner, { out_biz_no }))),
      JSON.stringify(out_biz_no),
    ).toBe('23514');
  }
  for (const out_biz_no of ['a', 'Z09a'.repeat(8)]) {
    expect(await sqlState(insert(h.app, 'withdrawals', withdrawal(owner, { out_biz_no })))).toBe(
      'ok',
    );
  }
});

it('[AC-B2-05b#8] channel_order_id 部分唯一：同 app 拒重、跨 app 与多个 NULL 放行', async () => {
  await ready(h.app);
  const owner = await person(h.app);
  const channel_order_id = `channel-${randomUUID()}`;
  await insert(h.app, 'withdrawals', withdrawal(owner, { channel_order_id }));
  expect(
    await sqlState(
      insert(
        h.app,
        'withdrawals',
        withdrawal(await person(h.app, owner.app_id), { channel_order_id }),
      ),
    ),
  ).toBe('23505');
  expect(
    await sqlState(
      insert(h.app, 'withdrawals', withdrawal(await person(h.app), { channel_order_id })),
    ),
  ).toBe('ok');
  for (let n = 0; n < 2; n++)
    expect(await sqlState(insert(h.app, 'withdrawals', withdrawal(owner)))).toBe('ok');
  const indexes = await sql<{
    name: string;
    keys: string[];
    predicate: string | null;
    valid: boolean;
    ready: boolean;
  }>`
    SELECT idx.relname::text AS name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
      pg_get_expr(i.indpred, i.indrelid) AS predicate, i.indisvalid AS valid, i.indisready AS ready
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('app.withdrawals') AND i.indisunique`.execute(h.app);
  const index = indexes.rows.find((r) => r.keys.join(',') === 'app_id,channel_order_id');
  expect(index).toMatchObject({ valid: true, ready: true });
  expect(index?.name).toBeTruthy();
  expect(index?.predicate).toMatch(/^\(?channel_order_id IS NOT NULL\)?$/i);
});

const INVALID: [string, Row][] = [
  ['amount zero', { amount_fen: 0n, net_fen: 0n }],
  ['amount negative', { amount_fen: -1n, net_fen: -1n }],
  ['negative fee', { fee_fen: -1n, net_fen: 1001n }],
  ['negative tax', { tax_fen: -1n, net_fen: 1001n }],
  ['negative net', { tax_fen: 1001n, net_fen: -1n }],
  ['net equation', { fee_fen: 1n, tax_fen: 2n, net_fen: 1000n }],
  ['income', { income_type: 'INCIDENTAL' }],
  ['status', { status: 'SUCCESS' }],
  ['method', { payout_method: 'cash' }],
  ['channel', { payout_channel: 'cash' }],
  ['review', { review_mode: 'system' }],
  ['channel state', { channel_state: 'done' }],
  ['reject code', { reject_reason_code: 'UNKNOWN' }],
  ['hold code', { hold_reason: 'unknown', hold_at: AT }],
  ['blocked code', { blocked_reason: 'NEGATIVE_BALANCE_OTHER' }],
  ['resolution', { manual_resolution: 'unknown' }],
  ['execute seq', { execute_seq: -1 }],
  ['bank required', { payout_method: 'bank_card', payout_channel: 'bank_card' }],
  ['bank forbidden', { bank_name: 'fixture-bank' }],
  ['wechat app required', { payout_method: 'wechat', payout_channel: 'wechat' }],
  ['rejected reason required', { status: 'REJECTED' }],
  ['api paid timestamp required', { status: 'PAID_API' }],
  [
    'manual paid timestamp required',
    { status: 'PAID_MANUAL', manual_entry_by: randomUUID(), manual_confirm_by: randomUUID() },
  ],
  [
    'manual entry required',
    { status: 'PAID_MANUAL', paid_at: AT, manual_confirm_by: randomUUID() },
  ],
  [
    'manual confirmation required',
    { status: 'PAID_MANUAL', paid_at: AT, manual_entry_by: randomUUID() },
  ],
  ['manual pending', { needs_manual: true }],
  ['manual approved', { status: 'APPROVED', needs_manual: true }],
  ['hold timestamp required', { hold_reason: 'member_blocked' }],
  ['hold reason required', { hold_at: AT }],
  ['auto_decision object', { auto_decision: '[]' }],
  ['resolver_ids array', { resolver_ids: '{}' }],
  ['risk_flags array', { risk_flags: '{}' }],
];
for (const [label, values] of INVALID) {
  it(`[AC-B2-05b#9] CHECK 拒绝 ${label}`, async () => {
    await ready(h.app);
    expect(
      await sqlState(insert(h.app, 'withdrawals', withdrawal(await person(h.app), values))),
    ).toBe('23514');
  });
}

it('[AC-B2-05b#10] 合法金额边界、七态和所有枚举均可存储，金额不损失整数精度', async () => {
  await ready(h.app);
  const owner = await person(h.app);
  const valid: Row[] = [
    { amount_fen: 1n, net_fen: 1n },
    // Database allows zero net; application-level BR-WDR-19 minimum is outside this migration.
    { amount_fen: 10n, fee_fen: 3n, tax_fen: 7n, net_fen: 0n },
    { amount_fen: 9007199254740993n, fee_fen: 2n, tax_fen: 3n, net_fen: 9007199254740988n },
    ...STATUSES.map(statusFields),
    ...['PAYING', 'REJECTED', 'PAID_API', 'PAID_MANUAL', 'FAILED'].map((status) => ({
      ...statusFields(status),
      needs_manual: true,
    })),
    ...REJECT_REASONS.map((reject_reason_code) => ({ status: 'REJECTED', reject_reason_code })),
    ...HOLD_REASONS.map((hold_reason) => ({ status: 'APPROVED', hold_reason, hold_at: AT })),
    ...['auto', 'manual'].map((review_mode) => ({ review_mode })),
    ...['paid', 'failed'].map((manual_resolution) => ({
      status: 'PAYING',
      needs_manual: true,
      manual_resolution,
      resolver_ids: '[]',
    })),
    ...['processing', 'wait_user_confirm', 'canceling'].map((channel_state) => ({
      status: 'PAYING',
      payout_method: 'wechat',
      payout_channel: 'wechat',
      wechat_app_id: 'fixture-app',
      channel_state,
      confirm_deadline: AT,
      wechat_launch_cipher: Buffer.from('synthetic-launch'),
    })),
    { payout_method: 'bank_card', payout_channel: 'bank_card', bank_name: 'fixture-bank' },
    { auto_decision: '{}', risk_flags: '[]', blocked_reason: 'NEGATIVE_BALANCE' },
  ];
  for (const values of valid) {
    const row = withdrawal(owner, values);
    expect(await sqlState(insert(h.app, 'withdrawals', row)), String(values['status'])).toBe('ok');
    expect((await stored(h.app, 'withdrawals', row['id']))[0]).toMatchObject({
      amount_fen: row['amount_fen'],
      fee_fen: row['fee_fen'],
      tax_fen: row['tax_fen'],
      net_fen: row['net_fen'],
    });
  }
});

it('[AC-B2-05b#11] 冻结原因只允许四种，解除人与解除时间必须成对', async () => {
  await ready(h.app, 'withdraw_holds');
  const owner = await person(h.app);
  for (const values of [
    { reason: 'invariant_fail' },
    { released_at: AT },
    { released_by: 'system:fixture' },
  ]) {
    expect(await sqlState(insert(h.app, 'withdraw_holds', hold(owner, values)))).toBe('23514');
  }
  for (const reason of REASONS) {
    expect(await sqlState(insert(h.app, 'withdraw_holds', hold(owner, { reason })))).toBe('ok');
  }
});

it('[AC-B2-05b#12] 多原因和同原因可叠加，按 id 解除一条不影响其余冻结', async () => {
  await ready(h.app, 'withdraw_holds');
  const owner = await person(h.app);
  const rows = [...REASONS, 'manual'].map((reason) => hold(owner, { reason }));
  for (const row of rows) await insert(h.app, 'withdraw_holds', row);
  const first = rows[0]!;
  await update(h.app, 'withdraw_holds', first['id'], {
    released_at: AT,
    released_by: 'system:release',
  });
  expect(await stored(h.app, 'withdraw_holds', first['id'])).toEqual([
    expect.objectContaining({ ...first, released_at: AT, released_by: 'system:release' }),
  ]);
  for (const row of rows.slice(1)) {
    expect(await stored(h.app, 'withdraw_holds', row['id'])).toEqual([
      expect.objectContaining({ ...row, released_at: null, released_by: null }),
    ]);
  }
  // Expiry is stored as data; active-at-time calculation belongs to the application.
  for (const hold_until of [
    new Date('2032-06-14T02:00:00Z'),
    AT,
    new Date('2032-06-16T02:00:00Z'),
    null,
  ]) {
    const row = hold(owner, { hold_until });
    expect(await sqlState(insert(h.app, 'withdraw_holds', row))).toBe('ok');
    expect((await stored(h.app, 'withdraw_holds', row['id']))[0]).toMatchObject({ hold_until });
  }
});
