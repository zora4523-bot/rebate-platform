import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  AT,
  LATER,
  TABLES,
  adjustment,
  columns,
  harness,
  insert,
  item,
  job,
  ready,
  recon,
  scenario,
  sqlState,
  update,
  type Row,
  type Table,
} from './kit.ts';

const h = harness(createTestDatabase);

// 仅列出任务中确定的可变字段；未固定名称的账单汇总字段留给迁移设计。
const MUTABLE: Record<Table, string[]> = {
  settle_jobs: ['status', 'processed_count', 'skipped_count', 'finished_at'],
  settle_bills: ['generated_at'],
  settle_batches: [
    'status',
    'settle_mode',
    'scheduled_at',
    'confirmed_by',
    'confirmed_at',
    'cancelled_reason',
    'settle_run_id',
    'started_at',
    'finished_at',
    'paused_by_switch_at',
  ],
  settle_batch_items: ['result', 'skip_reason'],
  beneficiary_credits: ['status', 'closed_by', 'closed_ref', 'voucher_id', 'closed_at'],
  settle_adjust_batches: ['confirmed_by', 'confirmed_at'],
  settle_adjustments: ['status', 'approver', 'decided_at', 'reason'],
  recon_union: [],
};
const IMMUTABLE: Record<Table, string[]> = {
  settle_jobs: ['app_id', 'job', 'platform', 'run_at'],
  settle_bills: ['app_id', 'bill_id'],
  settle_batches: ['app_id', 'batch_id', 'bill_id', 'platform', 'kind'],
  settle_batch_items: [
    'app_id',
    'batch_id',
    'order_id',
    'item_type',
    'user_id',
    'role',
    'beneficiary_credit_id',
    'settle_seq',
  ],
  beneficiary_credits: [
    'app_id',
    'beneficiary_credit_id',
    'order_id',
    'user_id',
    'role',
    'kind',
    'opened_by',
    'opened_ref',
    'split_ref',
    'origin_ledger_type',
    'origin_sub_type',
    'opened_at',
  ],
  settle_adjust_batches: ['app_id', 'batch_id'],
  settle_adjustments: [
    'app_id',
    'batch_id',
    'order_id',
    'user_id',
    'role',
    'commission_version',
    'settle_seq',
  ],
  recon_union: ['app_id', 'platform', 'period', 'order_key'],
};

it('[AC-B2-04a#20] couli_app 只有 SELECT、INSERT 和所需列级 UPDATE，没有整表改删或管理权限', async () => {
  await ready(h.app);
  const identity =
    await sql`SELECT current_user, current_setting('is_superuser') AS superuser`.execute(h.app);
  expect(identity.rows).toEqual([{ current_user: 'couli_app', superuser: 'off' }]);
  for (const table of TABLES) {
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ]) {
      const result =
        await sql`SELECT has_table_privilege('couli_app', ${`app.${table}`}, ${privilege}) AS granted`.execute(
          h.app,
        );
      expect(result.rows, `${table}/${privilege}`).toEqual([
        { granted: ['SELECT', 'INSERT'].includes(privilege) },
      ]);
    }
    const amounts = (await columns(h.app, table))
      .filter((c) => c.name.endsWith('_fen') || ['our_value', 'union_value'].includes(c.name))
      .map((c) => c.name);
    // 按任务第 9 节：包括明细金额在内，金额列不授 UPDATE。
    for (const column of [...MUTABLE[table], ...IMMUTABLE[table], ...amounts]) {
      const result =
        await sql`SELECT has_column_privilege('couli_app', ${`app.${table}`}, ${column}, 'UPDATE') AS granted`.execute(
          h.app,
        );
      expect(result.rows, `${table}.${column}`).toEqual([
        { granted: MUTABLE[table].includes(column) },
      ]);
    }
  }
});

it('[AC-B2-04a#21] 任务进度、批次确认和 S8 停住时刻可以持久化并清除', async () => {
  await ready(h.app);
  const { p, b } = await scenario(h.app);
  const run = job({ app_id: p.appId });
  await insert(h.app, 'settle_jobs', run);
  expect(
    await sqlState(
      update(
        h.app,
        'settle_jobs',
        { id: run['id'] },
        { status: 'done', processed_count: 4, skipped_count: 1, finished_at: LATER },
      ),
    ),
  ).toBe('ok');
  const stored =
    await sql`SELECT status, processed_count, skipped_count, finished_at FROM app.settle_jobs WHERE id = ${run['id']}`.execute(
      h.app,
    );
  expect(stored.rows).toEqual([
    { status: 'done', processed_count: 4, skipped_count: 1, finished_at: new Date(LATER) },
  ]);
  expect(
    await sqlState(
      update(
        h.app,
        'settle_batches',
        { batch_id: b['batch_id'] },
        {
          status: 'CONFIRMED',
          settle_mode: 'SCHEDULED',
          scheduled_at: LATER,
          confirmed_by: p.adminId,
          confirmed_at: AT,
        },
      ),
    ),
  ).toBe('ok');
  expect(
    await sqlState(
      update(
        h.app,
        'settle_batches',
        { batch_id: b['batch_id'] },
        { status: 'PARTIAL', paused_by_switch_at: LATER },
      ),
    ),
  ).toBe('ok');
  const paused =
    await sql`SELECT status, paused_by_switch_at, scheduled_at, confirmed_by FROM app.settle_batches WHERE batch_id = ${b['batch_id']}`.execute(
      h.app,
    );
  expect(paused.rows).toEqual([
    {
      status: 'PARTIAL',
      paused_by_switch_at: new Date(LATER),
      scheduled_at: new Date(LATER),
      confirmed_by: p.adminId,
    },
  ]);
  expect(
    await sqlState(
      update(h.app, 'settle_batches', { batch_id: b['batch_id'] }, { paused_by_switch_at: null }),
    ),
  ).toBe('ok');
  const resumed =
    await sql`SELECT paused_by_switch_at FROM app.settle_batches WHERE batch_id = ${b['batch_id']}`.execute(
      h.app,
    );
  expect(resumed.rows).toEqual([{ paused_by_switch_at: null }]);
});

it('[AC-B2-04a#22] 明细执行结果、补差决定与拒绝理由可存储，候选金额和 seq 保留', async () => {
  await ready(h.app);
  const { p, b, ab } = await scenario(h.app);
  const detail = item(p, b);
  const candidate = adjustment(p, ab);
  await insert(h.app, 'settle_batch_items', detail);
  await insert(h.app, 'settle_adjustments', candidate);
  expect(
    await sqlState(
      update(
        h.app,
        'settle_batch_items',
        { id: detail['id'] },
        { result: 'skipped', skip_reason: '结算记录版本变化' },
      ),
    ),
  ).toBe('ok');
  const result =
    await sql`SELECT result, skip_reason FROM app.settle_batch_items WHERE id = ${detail['id']}`.execute(
      h.app,
    );
  expect(result.rows).toEqual([{ result: 'skipped', skip_reason: '结算记录版本变化' }]);
  expect(
    await sqlState(
      update(
        h.app,
        'settle_adjust_batches',
        { batch_id: ab['batch_id'] },
        { confirmed_by: p.adminId, confirmed_at: LATER },
      ),
    ),
  ).toBe('ok');
  expect(
    await sqlState(
      update(
        h.app,
        'settle_adjustments',
        { id: candidate['id'] },
        { status: 'rejected', approver: p.adminId, decided_at: LATER, reason: '核对后拒绝补差' },
      ),
    ),
  ).toBe('ok');
  const stored =
    await sql`SELECT status, approver, decided_at, reason, settle_seq, diff_fen FROM app.settle_adjustments WHERE id = ${candidate['id']}`.execute(
      h.app,
    );
  expect(stored.rows).toEqual([
    {
      status: 'rejected',
      approver: p.adminId,
      decided_at: new Date(LATER),
      reason: '核对后拒绝补差',
      settle_seq: 1,
      diff_fen: 100n,
    },
  ]);
});

it('[AC-B2-04a#23] 实际 UPDATE 金额与身份列被拒，DELETE、TRUNCATE、ALTER 被拒且数据保留', async () => {
  await ready(h.app);
  const { p, b, ab } = await scenario(h.app);
  const rows: [Table, Row][] = [
    ['settle_jobs', job({ app_id: p.appId })],
    ['settle_batch_items', item(p, b)],
    ['settle_adjustments', adjustment(p, ab)],
    ['recon_union', recon(p)],
  ];
  for (const [table, row] of rows) expect(await sqlState(insert(h.app, table, row))).toBe('ok');
  for (const table of TABLES) {
    const before =
      await sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE app_id = ${p.appId}`.execute(
        h.app,
      );
    expect(before.rows).toHaveLength(1);
    const amounts = (await columns(h.app, table))
      .filter((c) => c.name.endsWith('_fen') || ['our_value', 'union_value'].includes(c.name))
      .map((c) => c.name);
    for (const column of [...IMMUTABLE[table], ...amounts]) {
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET ${sql.ref(column)} = ${sql.ref(column)} WHERE app_id = ${p.appId}`.execute(
            h.app,
          ),
        ),
        `${table}.${column}`,
      ).toBe('42501');
    }
    expect(
      await sqlState(
        sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE app_id = ${p.appId}`.execute(h.app),
      ),
    ).toBe('42501');
    expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(h.app))).toBe('42501');
    expect(
      await sqlState(
        sql`ALTER TABLE ${sql.table(`app.${table}`)} ADD COLUMN unauthorized text`.execute(h.app),
      ),
    ).toBe('42501');
    const after =
      await sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE app_id = ${p.appId}`.execute(
        h.app,
      );
    expect(after.rows).toEqual(before.rows);
  }
});
