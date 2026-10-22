import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  LATER,
  batch,
  beneficiaryItem,
  bill,
  credit,
  harness,
  insert,
  item,
  job,
  parents,
  ready,
  scenario,
  sqlState,
  update,
} from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B2-04a#6] 同一名义任务只存一次，app、job、platform、run_at 各自隔离', async () => {
  await ready(h.app);
  const row = job();
  expect(await sqlState(insert(h.app, 'settle_jobs', row))).toBe('ok');
  expect(await sqlState(insert(h.app, 'settle_jobs', { ...row, id: randomUUID() }))).toBe('23505');
  for (const change of [
    { app_id: randomUUID() },
    { job: 'settle_adjust' },
    { platform: 'jd' },
    { run_at: LATER },
  ]) {
    expect(
      await sqlState(insert(h.app, 'settle_jobs', { ...row, ...change, id: randomUUID() })),
    ).toBe('ok');
  }
  const stored =
    await sql`SELECT processed_count, skipped_count FROM app.settle_jobs WHERE id = ${row['id']}`.execute(
      h.app,
    );
  expect(stored.rows).toEqual([{ processed_count: 0, skipped_count: 0 }]);
});

it('[AC-B2-04a#7] 月账单按 app 与账单月去重，出账开始可先登记、完成时补 generated_at', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const row = bill(p);
  expect(await sqlState(insert(h.app, 'settle_bills', row))).toBe('ok');
  expect(await sqlState(insert(h.app, 'settle_bills', row))).toBe('23505');
  expect(await sqlState(insert(h.app, 'settle_bills', bill(p, { bill_id: '2032-07' })))).toBe('ok');
  expect(await sqlState(insert(h.app, 'settle_bills', bill(p, { app_id: randomUUID() })))).toBe(
    'ok',
  );
  expect(
    await sqlState(
      update(
        h.app,
        'settle_bills',
        { app_id: p.appId, bill_id: '2032-06' },
        { generated_at: LATER },
      ),
    ),
  ).toBe('ok');
  const stored =
    await sql`SELECT generated_at FROM app.settle_bills WHERE app_id = ${p.appId} AND bill_id = '2032-06'`.execute(
      h.app,
    );
  expect(stored.rows).toEqual([{ generated_at: new Date(LATER) }]);
});

it('[AC-B2-04a#8] 子订单明细同批不能重复；可跨批、且与该单多个受益人补记项并存', async () => {
  await ready(h.app);
  const { p, b, c } = await scenario(h.app);
  const first = item(p, b);
  expect(await sqlState(insert(h.app, 'settle_batch_items', first))).toBe('ok');
  expect(await sqlState(insert(h.app, 'settle_batch_items', item(p, b)))).toBe('23505');
  const secondBatch = batch(p, { kind: 'supplement' });
  await insert(h.app, 'settle_batches', secondBatch);
  expect(await sqlState(insert(h.app, 'settle_batch_items', item(p, secondBatch)))).toBe('ok');
  expect(await sqlState(insert(h.app, 'settle_batch_items', beneficiaryItem(p, b, c)))).toBe('ok');
  const otherRole = credit(p, { role: 'share' });
  await insert(h.app, 'beneficiary_credits', otherRole);
  expect(
    await sqlState(insert(h.app, 'settle_batch_items', beneficiaryItem(p, b, otherRole))),
  ).toBe('ok');
  const count =
    await sql`SELECT count(*) AS n FROM app.settle_batch_items WHERE batch_id = ${b['batch_id']}`.execute(
      h.app,
    );
  expect(count.rows).toEqual([{ n: 3n }]);
});

it('[AC-B2-04a#9] 补记明细按义务身份同批唯一；跨批仍引用同一个 beneficiary_credit_id', async () => {
  await ready(h.app);
  const { p, b, c } = await scenario(h.app);
  const first = beneficiaryItem(p, b, c);
  expect(await sqlState(insert(h.app, 'settle_batch_items', first))).toBe('ok');
  expect(await sqlState(insert(h.app, 'settle_batch_items', { ...first, id: randomUUID() }))).toBe(
    '23505',
  );
  const nextBatch = batch(p, { kind: 'supplement' });
  await insert(h.app, 'settle_batches', nextBatch);
  expect(
    await sqlState(insert(h.app, 'settle_batch_items', beneficiaryItem(p, nextBatch, c))),
  ).toBe('ok');
  const stored = await sql`SELECT beneficiary_credit_id FROM app.settle_batch_items
    WHERE app_id = ${p.appId} AND item_type = 'beneficiary'`.execute(h.app);
  expect(stored.rows).toEqual([
    { beneficiary_credit_id: c['beneficiary_credit_id'] },
    { beneficiary_credit_id: c['beneficiary_credit_id'] },
  ]);
});

it('[AC-B2-04a#10] open 义务同订单受益人角色只一条，关闭后新 ID 可重新开立', async () => {
  await ready(h.app);
  for (const status of ['done', 'forfeited', 'voided']) {
    const p = await parents(h.app);
    const first = credit(p);
    expect(await sqlState(insert(h.app, 'beneficiary_credits', first))).toBe('ok');
    expect(await sqlState(insert(h.app, 'beneficiary_credits', credit(p)))).toBe('23505');
    // 仅验证存储：0 元关闭允许无凭证；关闭事件选择 04 中明确列出的 R8 / R10。
    expect(
      await sqlState(
        update(
          h.app,
          'beneficiary_credits',
          { beneficiary_credit_id: first['beneficiary_credit_id'] },
          {
            status,
            closed_by: status === 'voided' ? 'R8' : 'R10',
            closed_ref: '1',
            closed_at: LATER,
            voucher_id: null,
          },
        ),
      ),
    ).toBe('ok');
    const next = credit(p);
    expect(next['beneficiary_credit_id']).not.toBe(first['beneficiary_credit_id']);
    expect(await sqlState(insert(h.app, 'beneficiary_credits', next))).toBe('ok');
    expect(await sqlState(insert(h.app, 'beneficiary_credits', credit(p, { role: 'share' })))).toBe(
      'ok',
    );
    const other = await parents(h.app, p.appId);
    expect(
      await sqlState(insert(h.app, 'beneficiary_credits', credit(p, { user_id: other.userId }))),
    ).toBe('ok');
    expect(
      await sqlState(insert(h.app, 'beneficiary_credits', credit(p, { order_id: other.orderId }))),
    ).toBe('ok');
  }
});

it('[AC-B2-04a#11] 并发创建相同 open 义务只能一个成功，PG 唯一约束兜底', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const outcomes = await Promise.all([
    sqlState(insert(h.app, 'beneficiary_credits', credit(p))),
    sqlState(insert(h.app, 'beneficiary_credits', credit(p))),
  ]);
  expect(outcomes.sort()).toEqual(['23505', 'ok']);
  const stored = await sql`SELECT count(*) AS n FROM app.beneficiary_credits
    WHERE app_id = ${p.appId} AND order_id = ${p.orderId} AND user_id = ${p.userId} AND role = 'self' AND status = 'open'`.execute(
    h.app,
  );
  expect(stored.rows).toEqual([{ n: 1n }]);
});

it('[AC-B2-04a#12] 两类明细不能用 NULL 或混用受益人字段绕过部分唯一', async () => {
  await ready(h.app);
  const { p, b, c } = await scenario(h.app);
  for (const field of ['user_id', 'role', 'beneficiary_credit_id']) {
    expect(
      await sqlState(
        insert(h.app, 'settle_batch_items', beneficiaryItem(p, b, c, { [field]: null })),
      ),
      field,
    ).toBe('23514');
  }
  for (const change of [
    { user_id: p.userId },
    { role: 'self' },
    { beneficiary_credit_id: c['beneficiary_credit_id'] },
  ]) {
    expect(await sqlState(insert(h.app, 'settle_batch_items', item(p, b, change)))).toBe('23514');
  }
});
