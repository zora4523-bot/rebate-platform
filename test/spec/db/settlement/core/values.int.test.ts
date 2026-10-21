import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  AT,
  JOB_STATES,
  LATER,
  adjustBatch,
  adjustment,
  batch,
  beneficiaryItem,
  bill,
  credit,
  enumValues,
  harness,
  insert,
  item,
  job,
  parents,
  ready,
  recon,
  scenario,
  sqlState,
} from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B2-04a#13] 批次状态与结算方式接受 fund.yaml 全值，拒绝未知值和错误大小写', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  await insert(h.app, 'settle_bills', bill(p));
  for (const [column, enumeration] of [
    ['status', 'settle_batch_status'],
    ['settle_mode', 'settle_mode'],
  ] as const) {
    for (const value of enumValues(enumeration)) {
      const row = batch(p, { [column]: value });
      if (column === 'status' && value !== 'DRAFT')
        Object.assign(row, { confirmed_by: p.adminId, confirmed_at: AT });
      if (value === 'CANCELLED') row['cancelled_reason'] = '人工驳回';
      if (value === 'SCHEDULED') row['scheduled_at'] = LATER;
      expect(await sqlState(insert(h.app, 'settle_batches', row)), `${column}/${value}`).toBe('ok');
    }
    for (const value of ['unknown', '', column === 'status' ? 'draft' : 'immediate']) {
      expect(await sqlState(insert(h.app, 'settle_batches', batch(p, { [column]: value })))).toBe(
        '23514',
      );
    }
  }
});

it('[AC-B2-04a#14] 义务 kind、status、role 接受契约全值，拒绝表外取值', async () => {
  await ready(h.app);
  for (const [column, enumeration] of [
    ['kind', 'beneficiary_credit_kind'],
    ['status', 'beneficiary_credit_status'],
    ['role', 'beneficiary_role'],
  ] as const) {
    for (const value of enumValues(enumeration)) {
      const p = await parents(h.app);
      const row = credit(p, { [column]: value });
      if (column === 'kind' && value === 'deferred')
        Object.assign(row, {
          opened_by: 'R10',
          opened_ref: '1',
          origin_ledger_type: 'SETTLE_ADJUST',
          origin_sub_type: 'SETTLE_DIFF',
        });
      if (column === 'kind' && value === 'reassign_credit') row['opened_by'] = 'R14';
      if (column === 'status' && value !== 'open')
        Object.assign(row, {
          closed_by: value === 'voided' ? 'R8' : 'R10',
          closed_ref: '1',
          closed_at: LATER,
        });
      expect(await sqlState(insert(h.app, 'beneficiary_credits', row)), `${column}/${value}`).toBe(
        'ok',
      );
    }
    const p = await parents(h.app);
    for (const value of ['unknown', '', enumValues(enumeration)[0]!.toUpperCase()]) {
      expect(
        await sqlState(insert(h.app, 'beneficiary_credits', credit(p, { [column]: value }))),
      ).toBe('23514');
    }
  }
});

it('[AC-B2-04a#15] 补差候选接受全部状态和平台空受益人行，并保留原 seq 与差额', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const ab = adjustBatch(p);
  await insert(h.app, 'settle_adjust_batches', ab);
  for (const status of enumValues('settle_adjustment_status')) {
    // 每个候选有独立订单，避免跨状态测试误撞业务去重键。
    const other = await parents(h.app, p.appId);
    const row = adjustment(other, ab, {
      status,
      approver: status === 'pending' ? null : p.adminId,
      decided_at: status === 'pending' ? null : LATER,
    });
    expect(await sqlState(insert(h.app, 'settle_adjustments', row)), status).toBe('ok');
    const stored =
      await sql`SELECT status, settle_seq, diff_fen FROM app.settle_adjustments WHERE id = ${row['id']}`.execute(
        h.app,
      );
    expect(stored.rows).toEqual([{ status, settle_seq: 1, diff_fen: 100n }]);
  }
  for (const status of ['unknown', '', 'PENDING', 'voided']) {
    expect(await sqlState(insert(h.app, 'settle_adjustments', adjustment(p, ab, { status })))).toBe(
      '23514',
    );
  }
  const platform = adjustment(p, ab, { user_id: null, role: null, diff_fen: 9007199254740993n });
  expect(await sqlState(insert(h.app, 'settle_adjustments', platform))).toBe('ok');
  const stored =
    await sql`SELECT user_id, role, diff_fen FROM app.settle_adjustments WHERE id = ${platform['id']}`.execute(
      h.app,
    );
  expect(stored.rows).toEqual([{ user_id: null, role: null, diff_fen: 9007199254740993n }]);
});

it('[AC-B2-04a#16] 明细类型和结果 CHECK 接受全部契约值，未执行结果可空', async () => {
  await ready(h.app);
  for (const itemType of enumValues('settle_batch_item_type')) {
    const { p, b, c } = await scenario(h.app);
    const row = itemType === 'beneficiary' ? beneficiaryItem(p, b, c) : item(p, b);
    expect(row['item_type']).toBe(itemType);
    expect(await sqlState(insert(h.app, 'settle_batch_items', row))).toBe('ok');
  }
  for (const result of enumValues('settle_batch_item_result')) {
    const { p, b, c } = await scenario(h.app);
    expect(
      await sqlState(
        insert(
          h.app,
          'settle_batch_items',
          beneficiaryItem(p, b, c, {
            result,
            amount_fen: result === 'credited' ? 100n : null,
            skip_reason: result === 'credited' ? null : '受益人状态复核',
          }),
        ),
      ),
      result,
    ).toBe('ok');
  }
  const { p, b } = await scenario(h.app);
  for (const [column, values] of [
    ['item_type', ['unknown', '', 'ORDER']],
    ['result', ['unknown', '', 'CREDITED']],
  ] as const) {
    for (const value of values)
      expect(
        await sqlState(insert(h.app, 'settle_batch_items', item(p, b, { [column]: value }))),
      ).toBe('23514');
  }
});

it('[AC-B2-04a#17] S7 任务仅运行完成失败三态，job 不含旧 credit、clawback 或批次执行', async () => {
  await ready(h.app);
  for (const status of JOB_STATES) {
    expect(
      await sqlState(
        insert(
          h.app,
          'settle_jobs',
          job({ status, finished_at: status === 'running' ? null : LATER }),
        ),
      ),
    ).toBe('ok');
  }
  for (const status of ['pending', 'unknown', '', 'RUNNING'])
    expect(await sqlState(insert(h.app, 'settle_jobs', job({ status })))).toBe('23514');
  for (const name of ['bill', 'settle_adjust', 'recon_union', 'recon_monthly'])
    expect(await sqlState(insert(h.app, 'settle_jobs', job({ job: name })))).toBe('ok');
  for (const name of ['credit', 'clawback', 'batch_execute', 'unknown', ''])
    expect(await sqlState(insert(h.app, 'settle_jobs', job({ job: name })))).toBe('23514');
});

it('[AC-B2-04a#18] 订单外键拒绝缺单与跨 app 引用，批次及义务不能串 app', async () => {
  await ready(h.app);
  const { p, b, c, ab } = await scenario(h.app);
  const foreign = await scenario(h.app);
  for (const orderId of [randomUUID(), foreign.p.orderId]) {
    expect(
      await sqlState(insert(h.app, 'beneficiary_credits', credit(p, { order_id: orderId }))),
    ).toBe('23503');
    expect(
      await sqlState(insert(h.app, 'settle_batch_items', item(p, b, { order_id: orderId }))),
    ).toBe('23503');
    expect(
      await sqlState(insert(h.app, 'settle_adjustments', adjustment(p, ab, { order_id: orderId }))),
    ).toBe('23503');
  }
  for (const batchId of [randomUUID(), foreign.b['batch_id']])
    expect(
      await sqlState(insert(h.app, 'settle_batch_items', item(p, b, { batch_id: batchId }))),
    ).toBe('23503');
  for (const obligationId of [randomUUID(), foreign.c['beneficiary_credit_id']])
    expect(
      await sqlState(
        insert(
          h.app,
          'settle_batch_items',
          beneficiaryItem(p, b, c, { beneficiary_credit_id: obligationId }),
        ),
      ),
    ).toBe('23503');
  expect(
    await sqlState(
      insert(h.app, 'settle_adjustments', adjustment(p, ab, { batch_id: foreign.ab['batch_id'] })),
    ),
  ).toBe('23503');
});

it('[AC-B2-04a#19] 联盟对账保留带符号差额与 bigint 精度，支持我方无单的原始业务键', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  for (const diff of [-1n, 0n, 1n]) {
    const row = recon(p, {
      our_value: 9007199254740993n + diff,
      union_value: 9007199254740993n,
      diff_fen: diff,
      result: diff === 0n ? 'matched' : 'mismatch',
    });
    expect(await sqlState(insert(h.app, 'recon_union', row))).toBe('ok');
    const stored =
      await sql`SELECT our_value, union_value, diff_fen FROM app.recon_union WHERE id = ${row['id']}`.execute(
        h.app,
      );
    expect(stored.rows).toEqual([
      { our_value: row['our_value'], union_value: 9007199254740993n, diff_fen: diff },
    ]);
  }
});
