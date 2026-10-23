import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  TIMEOUT,
  close,
  insert,
  open,
  sqlState,
  withdrawal,
  update as updateWithdrawal,
  stored as storedWithdrawal,
  type Harness,
  type Row,
} from './kit.ts';
import { attempt, batch, fixture, item, ready, stored, update, watermark } from './core-kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06a#6] 人工批次必须有非空录入人，自动批次必须没有录入人', async () => {
  await ready(h.app);
  const appId = `b206a-${randomUUID()}`;
  for (const values of [
    { kind: 'manual', created_by: 'finance:fixture' },
    { kind: 'auto', created_by: null },
  ]) {
    const row = batch(appId, values);
    expect(await sqlState(insert(h.app, 'payout_batches', row))).toBe('ok');
    expect((await stored(h.app, 'payout_batches', row['id']))[0]).toMatchObject(values);
  }
  for (const values of [
    { kind: 'manual', created_by: null },
    { kind: 'manual', created_by: '' },
    { kind: 'auto', created_by: '' },
    { kind: 'auto', created_by: 'finance:fixture' },
    { kind: '' },
    { kind: 'MANUAL' },
    { kind: 'unknown' },
  ])
    expect(
      await sqlState(insert(h.app, 'payout_batches', batch(appId, values))),
      JSON.stringify(values),
    ).toBe('23514');
});

it('[AC-B2-06a#7] 成员四种结果可记历史；跳过与受阻必须有原因，移出必须指向不同批次', async () => {
  await ready(h.app);
  const f = await fixture(h);
  for (const values of [
    { result: 'paying' },
    { result: 'skipped', reason: 'not_approved' },
    { result: 'blocked', reason: 'channel_disabled' },
    { result: 'moved_out', moved_to_batch_id: f.target['id'] },
  ]) {
    const row = item(f, values);
    expect(await sqlState(insert(h.app, 'payout_batch_items', row))).toBe('ok');
    expect((await stored(h.app, 'payout_batch_items', row['id']))[0]).toMatchObject(values);
  }
  const invalid: Row[] = [
    { result: '' },
    { result: 'success' },
    { result: 'PAYING' },
    ...['skipped', 'blocked'].flatMap((result) => [
      { result, reason: null },
      { result, reason: '' },
    ]),
    { result: 'moved_out', moved_to_batch_id: null },
    { result: 'moved_out', moved_to_batch_id: f.source['id'] },
    { result: 'paying', reason: 'not_allowed' },
    { result: 'paying', reason: '' },
    { result: 'paying', moved_to_batch_id: f.target['id'] },
  ];
  for (const values of invalid) {
    expect(
      await sqlState(insert(h.app, 'payout_batch_items', item(f, values))),
      JSON.stringify(values),
    ).toBe('23514');
  }
});

it('[AC-B2-06a#8] 改挂只更新 withdrawals.batch_id，原批次成员记录保留，单据状态不变', async () => {
  await ready(h.app);
  const f = await fixture(h);
  const original = item(f, { result: 'blocked', reason: 'watermark_low' });
  await insert(h.app, 'payout_batch_items', original);
  const before = await stored(h.app, 'payout_batch_items', original['id']);
  const moved = item(f, { result: 'moved_out', moved_to_batch_id: f.target['id'] });
  await h.app.transaction().execute(async (tx) => {
    await updateWithdrawal(tx, 'withdrawals', f.wd['id'], { batch_id: f.target['id'] });
    await insert(tx, 'payout_batch_items', moved);
  });
  expect(await stored(h.app, 'payout_batch_items', original['id'])).toEqual(before);
  expect((await stored(h.app, 'payout_batch_items', moved['id']))[0]).toMatchObject(moved);
  expect((await storedWithdrawal(h.app, 'withdrawals', f.wd['id']))[0]).toMatchObject({
    batch_id: f.target['id'],
    status: 'APPROVED',
  });
});

it('[AC-B2-06a#9] 三类调用与四种结果均可记录，超时响应可空，负耗时和未知枚举被拒', async () => {
  await ready(h.app);
  const f = await fixture(h);
  for (const kind of ['transfer', 'query', 'cancel']) {
    for (const result of ['pending', 'success', 'fail', 'unknown']) {
      const row = attempt(f, {
        kind,
        result,
        response: result === 'pending' || result === 'unknown' ? null : '{"fixture":true}',
        resp_code: result === 'pending' ? null : 'fixture-code',
        resp_sub_code: result === 'pending' ? null : 'fixture-sub-code',
        latency_ms: result === 'pending' ? null : result === 'unknown' ? 10000 : 0,
      });
      expect(await sqlState(insert(h.roles.couli_payout, 'payout_attempts', row))).toBe('ok');
      expect((await stored(h.app, 'payout_attempts', row['id']))[0]).toMatchObject({
        kind,
        result,
        request: { logon_id: 'f***@example.invalid' },
        response: row['response'] === null ? null : { fixture: true },
        resp_code: row['resp_code'],
        resp_sub_code: row['resp_sub_code'],
        latency_ms: row['latency_ms'],
        at: AT,
      });
    }
  }
  for (const values of [
    { kind: '' },
    { kind: 'TRANSFER' },
    { kind: 'refund' },
    { result: '' },
    { result: 'SUCCESS' },
    { result: 'failed' },
    { latency_ms: -1 },
  ])
    expect(
      await sqlState(insert(h.roles.couli_payout, 'payout_attempts', attempt(f, values))),
    ).toBe('23514');
});

it('[AC-B2-06a#10] 各通道水位保留每次录入，按取数时刻取最新值，金额整数精度不丢失', async () => {
  await ready(h.app);
  const appId = `b206a-${randomUUID()}`;
  const earlier = new Date('2032-06-15T01:00:00Z');
  const rows: Row[] = [];
  for (const [channel, available_fen] of [
    ['alipay', 9007199254740993n],
    ['bank_card', 1n],
    ['wechat', 0n],
  ] as const) {
    const newest = watermark(appId, { channel, available_fen });
    // Insert older measurement last: created_at / insertion order must not choose the balance.
    const older = watermark(appId, { channel, available_fen: 2n, measured_at: earlier });
    for (const row of [newest, older]) {
      expect(await sqlState(insert(h.app, 'payout_watermarks', row))).toBe('ok');
      rows.push(row);
    }
    const latest = await sql<Row>`SELECT * FROM app.payout_watermarks
      WHERE app_id = ${appId} AND channel = ${channel} ORDER BY measured_at DESC LIMIT 1`.execute(
      h.app,
    );
    expect(latest.rows).toEqual([expect.objectContaining(newest)]);
  }
  await insert(
    h.app,
    'payout_watermarks',
    watermark(`other-${randomUUID()}`, { available_fen: 999n }),
  );
  for (const row of rows)
    expect((await stored(h.app, 'payout_watermarks', row['id']))[0]).toMatchObject(row);
  for (const values of [
    { channel: '' },
    { channel: 'cash' },
    { channel: 'ALIPAY' },
    { entered_by: '' },
    { available_fen: -1n },
  ])
    expect(await sqlState(insert(h.app, 'payout_watermarks', watermark(appId, values)))).toBe(
      '23514',
    );
});

it('[AC-B2-06a#11] 成员与尝试拒绝不存在的引用，withdrawals 拒绝挂到不存在的批次', async () => {
  await ready(h.app);
  const f = await fixture(h);
  for (const values of [
    { batch_id: randomUUID() },
    { withdrawal_id: randomUUID() },
    { result: 'moved_out', moved_to_batch_id: randomUUID() },
  ])
    expect(await sqlState(insert(h.app, 'payout_batch_items', item(f, values)))).toBe('23503');
  expect(
    await sqlState(
      insert(h.roles.couli_payout, 'payout_attempts', attempt(f, { withdrawal_id: randomUUID() })),
    ),
  ).toBe('23503');
  expect(
    await sqlState(insert(h.app, 'withdrawals', withdrawal(f.owner, { batch_id: randomUUID() }))),
  ).toBe('23503');
  expect(
    await sqlState(updateWithdrawal(h.app, 'withdrawals', f.wd['id'], { batch_id: randomUUID() })),
  ).toBe('23503');
  expect((await storedWithdrawal(h.app, 'withdrawals', f.wd['id']))[0]?.['batch_id']).toBe(
    f.source['id'],
  );
});

for (const result of ['success', 'fail', 'unknown']) {
  it(`[AC-B2-06a#12] pending 可一次补完为 ${result}，五个结果字段一起保存，此后拒绝任何更新`, async () => {
    await ready(h.app);
    const f = await fixture(h);
    const row = attempt(f);
    const db = h.roles.couli_payout;
    await insert(db, 'payout_attempts', row);
    const values = {
      result,
      response: result === 'unknown' ? null : '{"fixture":true}',
      resp_code: 'fixture-code',
      resp_sub_code: 'fixture-sub-code',
      latency_ms: 10,
    };
    expect(await sqlState(update(db, 'payout_attempts', row['id'], values))).toBe('ok');
    const before = await stored(h.app, 'payout_attempts', row['id']);
    expect(before).toEqual([
      expect.objectContaining({
        ...row,
        ...values,
        request: { logon_id: 'f***@example.invalid' },
        response: result === 'unknown' ? null : { fixture: true },
      }),
    ]);
    for (const next of [
      { result: 'pending' },
      { result: 'success' },
      { result: 'fail' },
      { result: 'unknown' },
      { response: '{"changed":true}' },
      { resp_code: 'changed' },
      { resp_sub_code: 'changed' },
      { latency_ms: 11 },
      { result },
    ]) {
      expect(await sqlState(update(db, 'payout_attempts', row['id'], next))).toBe('23001');
      expect(await stored(h.app, 'payout_attempts', row['id'])).toEqual(before);
    }
  });
}

it('[AC-B2-06a#13] pending 不能保持 pending 而改响应，失败补完不得消耗唯一更新机会', async () => {
  await ready(h.app);
  const row = attempt(await fixture(h));
  const db = h.roles.couli_payout;
  await insert(db, 'payout_attempts', row);
  const before = await stored(h.app, 'payout_attempts', row['id']);
  for (const values of [
    { result: 'pending' },
    { response: '{}' },
    { resp_code: 'fixture' },
    { resp_sub_code: 'fixture' },
    { latency_ms: 1 },
  ]) {
    expect(await sqlState(update(db, 'payout_attempts', row['id'], values))).toBe('23001');
    expect(await stored(h.app, 'payout_attempts', row['id'])).toEqual(before);
  }
  expect(
    await sqlState(update(db, 'payout_attempts', row['id'], { result: 'success', latency_ms: -1 })),
  ).toBe('23514');
  expect(await stored(h.app, 'payout_attempts', row['id'])).toEqual(before);
  expect(
    await sqlState(update(db, 'payout_attempts', row['id'], { result: 'success', latency_ms: 0 })),
  ).toBe('ok');
});

it('[AC-B2-06a#14] 并发补完同一 pending 只有一个成功，另一个被拒且不能覆盖结果', async () => {
  await ready(h.app);
  const row = attempt(await fixture(h));
  const db = h.roles.couli_payout;
  await insert(db, 'payout_attempts', row);
  const results = await Promise.all(
    ['success', 'fail'].map((result) =>
      sqlState(update(db, 'payout_attempts', row['id'], { result, resp_code: result })),
    ),
  );
  expect([...results].sort()).toEqual(['23001', 'ok']);
  const winner = ['success', 'fail'][results.indexOf('ok')];
  expect((await stored(h.app, 'payout_attempts', row['id']))[0]).toMatchObject({
    result: winner,
    resp_code: winner,
  });
});
