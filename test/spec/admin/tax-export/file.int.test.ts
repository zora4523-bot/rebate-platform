// B2-08e · what the real export worker writes (规划/08 BR-WDR-21; contract adminCreateExport, File;
// task §9.5 to §9.9): the admin entry creates the task and the worker entry's handler generates it,
// over the real payout reader (B2-08d) and identity's batch real-name port, on stored ciphers.
// Formats the contract leaves open are read by value: header labels are not pinned, times are
// compared as instants, the note's time to the minute.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  failedRealname,
  identity,
  NEW,
  OLD,
  OTHER,
  user,
  verified,
} from '../../identity/admin-realname/kit.ts';
import {
  ALIPAY_PHONE,
  ALIPAY_PHONE_MASKED,
  BANK_CARD,
  BANK_CARD_MASKED,
  seedMany,
} from '../../payout/tax-export/kit.ts';
import { parseCsv } from '../export-worker/kit.ts';
import { DOWNLOAD, ok, text, type Download, type View } from '../exports/kit.ts';
import {
  accountCipher,
  bank,
  COLUMN,
  correct,
  expectMaskedIdNo,
  FULL,
  FULL_POINT,
  harness,
  MASKED,
  MASKED_POINTS,
  MAX_ROWS_KEY,
  minuteOf,
  noteInstant,
  paid,
  person,
  Q4_END,
  Q4_START,
  rowOf,
  setMaxRows,
  started,
} from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

const SERVICE_FEE = 'SERVICE_FEE';
/** Above 2^53: a Number on the way to the file loses the last digit. */
const HUGE_FEN = 9_007_199_254_740_993n;

it('[AC-B2-08e#14] 范围：只含本 App 的 PAID_API / PAID_MANUAL，paid_at 落在 +08:00 自然季度，起点含、终点不含', async () => {
  const f = await started(h);
  const member = await person(h, f.appId, OLD);
  const start = await paid(h, member, {
    paid_at: Q4_START,
    // Applied in the quarter before: the quarter goes by paid_at.
    created_at: new Date('2026-09-20T01:00:00.000Z'),
  });
  const last = await paid(h, member, {
    status: 'PAID_MANUAL',
    paid_at: new Date(Q4_END.getTime() - 1),
  });
  await paid(h, member, { paid_at: new Date(Q4_START.getTime() - 1) });
  await paid(h, member, { paid_at: Q4_END });
  await paid(h, member, { status: 'FAILED', paid_at: Q4_START });
  await paid(h, member, { status: 'PAYING', paid_at: null });
  const foreign = await person(h, `tx_${randomUUID().replaceAll('-', '').slice(0, 24)}`, OTHER);
  await paid(h, foreign, { paid_at: Q4_START });

  const view = await ok<View>(await f.create(MASKED));
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 2 });
  const file = await f.file(view.id);
  expect(file.rows.map((cells) => cells[COLUMN.outBizNo]).sort()).toEqual(
    [start.out_biz_no, last.out_biz_no].sort(),
  );
  expect(Date.parse(rowOf(file, start.out_biz_no)[COLUMN.paidAt]!)).toBe(Q4_START.getTime());
  expect(Date.parse(rowOf(file, last.out_biz_no)[COLUMN.paidAt]!)).toBe(Q4_END.getTime() - 1);
});

it('[AC-B2-08e#15] 脱敏版文件：首行写账号名与导出时刻，第二行表头，列序按契约，证件号前 6 后 4，姓名全名，金额整数分', async () => {
  const f = await started(h);
  await h.db
    .updateTable('admin_users')
    .set({ display_name: '涉税展示名' })
    .where('id', '=', f.actor.id)
    .execute();
  const first = await person(h, f.appId, OLD);
  const second = await person(h, f.appId, OTHER);
  const small = await paid(h, first, {
    amount_fen: 12_345n,
    fee_fen: 123n,
    tax_fen: 456n,
    paid_at: new Date('2026-10-15T04:00:00.000Z'),
  });
  const huge = await paid(h, second, {
    ...bank(h),
    amount_fen: HUGE_FEN,
    fee_fen: 0n,
    tax_fen: 0n,
    paid_at: new Date('2026-10-16T04:00:00.000Z'),
  });
  const view = await ok<View>(await f.create(MASKED));
  f.clock.advanceMs(120_000);
  const row = await f.generate(view.id);
  expect(row).toMatchObject({ status: 'done', row_count: 2, masked: true, failure_reason: null });

  const file = await f.file(view.id);
  expect(file.line).toContain(f.actor.username);
  expect(noteInstant(file.line, f.actor.username)).toBe(minuteOf(row.generated_at!));
  expect(file.header).toHaveLength(9);
  expect(new Set(file.header).size).toBe(9);
  expect(file.header.every((cell) => cell.trim() !== '')).toBe(true);
  expect(file.rows).toHaveLength(2);
  expect(file.rows.every((cells) => cells.length === 9)).toBe(true);

  const a = rowOf(file, small.out_biz_no);
  expect(a[COLUMN.name]).toBe(OLD.name);
  expectMaskedIdNo(a[COLUMN.idNo], OLD.idNo);
  expect(a.slice(COLUMN.incomeType, COLUMN.paidAt)).toEqual([SERVICE_FEE, '12345', '456']);
  expect(Date.parse(a[COLUMN.paidAt]!)).toBe(small.paid_at!.getTime());
  expect(a[COLUMN.account]).toBe(ALIPAY_PHONE_MASKED);
  expect(a[COLUMN.corrected]).toBe('');

  const b = rowOf(file, huge.out_biz_no);
  expect(b[COLUMN.name]).toBe(OTHER.name);
  expectMaskedIdNo(b[COLUMN.idNo], OTHER.idNo);
  expect(b.slice(COLUMN.incomeType, COLUMN.paidAt)).toEqual([SERVICE_FEE, String(HUGE_FEN), '0']);
  expect(b[COLUMN.account]).toBe(BANK_CARD_MASKED);

  const all = text(file);
  for (const secret of [OLD.idNo, OTHER.idNo, ALIPAY_PHONE, BANK_CARD]) {
    expect(all).not.toContain(secret);
  }
});

it('[AC-B2-08e#16] 全量版文件：证件号完整，收款账户仍脱敏，首行与列序同脱敏版', async () => {
  const f = await started(h, [FULL_POINT]);
  const first = await person(h, f.appId, OLD);
  const second = await person(h, f.appId, OTHER);
  const alipay = await paid(h, first);
  const card = await paid(h, second, bank(h));
  const view = await ok<View>(await f.create(FULL, await f.token()));
  f.clock.advanceMs(120_000);
  const row = await f.generate(view.id);
  expect(row).toMatchObject({ status: 'done', row_count: 2, masked: false });
  const file = await f.file(view.id);
  expect(file.line).toContain(f.actor.username);
  expect(noteInstant(file.line, f.actor.username)).toBe(minuteOf(row.generated_at!));
  expect(file.header).toHaveLength(9);
  const a = rowOf(file, alipay.out_biz_no);
  expect(a[COLUMN.name]).toBe(OLD.name);
  expect(a[COLUMN.idNo]).toBe(OLD.idNo);
  expect(a[COLUMN.account]).toBe(ALIPAY_PHONE_MASKED);
  const b = rowOf(file, card.out_biz_no);
  expect(b[COLUMN.name]).toBe(OTHER.name);
  expect(b[COLUMN.idNo]).toBe(OTHER.idNo);
  expect(b[COLUMN.account]).toBe(BANK_CARD_MASKED);
  const all = text(file);
  expect(all).not.toContain(ALIPAY_PHONE);
  expect(all).not.toContain(BANK_CARD);
});

it('[AC-B2-08e#17] 全量版文件之外（日志、审计、任务 filters 与字段）不出现完整证件号', async () => {
  const f = await started(h, [FULL_POINT]);
  await paid(h, await person(h, f.appId, OLD));
  const view = await ok<View>(await f.create(FULL, await f.token()));
  await f.generate(view.id);
  expect(text(await f.file(view.id))).toContain(OLD.idNo);
  await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
  expect(f.lines.length).toBeGreaterThan(0);
  const tasks = await f.tasks();
  expect(tasks[0]).toMatchObject({ filters: { quarter: '2026-Q4' }, failure_reason: null });
  for (const outside of [text(f.lines), text(await f.audits()), text(tasks)]) {
    expect(outside).not.toContain(OLD.idNo);
  }
});

it('[AC-B2-08e#18] 全量版失败时 failure_reason 与日志也不带已读到的证件号', async () => {
  const f = await started(h, [FULL_POINT]);
  await paid(h, await person(h, f.appId, OLD));
  await paid(h, await user(h, f.appId));
  const view = await ok<View>(await f.create(FULL, await f.token()));
  const row = await f.generate(view.id);
  expect(row.status).toBe('failed');
  expect(row.failure_reason).not.toContain(OLD.idNo);
  for (const outside of [text(f.lines), text(await f.audits()), text(await f.tasks())]) {
    expect(outside).not.toContain(OLD.idNo);
  }
});

it('[AC-B2-08e#19] 首行说明只属于本 resource：users、audit_logs 的文件第一行仍是表头，也不写 export_generated', async () => {
  const f = await started(h, [...MASKED_POINTS, 'user.list']);
  const tax = await ok<View>(await f.create(MASKED));
  await f.generate(tax.id);
  const users = await ok<View>(await f.create({ resource: 'users', filters: {} }));
  await f.generate(users.id);
  const logs = await ok<View>(await f.create({ resource: 'audit_logs', filters: {} }));
  await f.generate(logs.id);
  expect(parseCsv(await f.stored(users.id))[0]).toEqual([
    'user_id',
    'nickname',
    'phone_masked',
    'level',
    'risk_state',
    'created_at',
  ]);
  expect(parseCsv(await f.stored(logs.id))[0]).toEqual([
    'id',
    'actor_id',
    'actor_name',
    'action',
    'target_type',
    'target_id',
    'permission',
    'ip',
    'at',
  ]);
  const generated = (await f.audits()).filter((row) => row.action === 'export_generated');
  expect(generated).toHaveLength(1);
  expect(text(generated)).toContain(tax.id);
});

it('[AC-B2-08e#20] 实名更正：所有行都是当前身份；到账后更正过的行写更正时刻，更正之后到账与没更正的行为空', async () => {
  const f = await started(h);
  const corrected = await person(h, f.appId, OLD);
  const other = await person(h, f.appId, OTHER);
  const before = await paid(h, corrected, { paid_at: new Date('2026-10-05T04:00:00.000Z') });
  const correctedAt = await correct(h, f, corrected, NEW);
  const later = new Date(correctedAt.getTime() + 3_600_000);
  const after = await paid(h, corrected, { paid_at: later });
  const plain = await paid(h, other, { paid_at: later });

  const view = await ok<View>(await f.create(MASKED));
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 3 });
  const file = await f.file(view.id);
  for (const row of [before, after]) {
    const cells = rowOf(file, row.out_biz_no);
    expect(cells[COLUMN.name]).toBe(NEW.name);
    expectMaskedIdNo(cells[COLUMN.idNo], NEW.idNo);
  }
  expect(Date.parse(rowOf(file, before.out_biz_no)[COLUMN.corrected]!)).toBe(correctedAt.getTime());
  expect(rowOf(file, after.out_biz_no)[COLUMN.corrected]).toBe('');
  expect(rowOf(file, plain.out_biz_no)[COLUMN.name]).toBe(OTHER.name);
  expect(rowOf(file, plain.out_biz_no)[COLUMN.corrected]).toBe('');
  expect(text(file)).not.toContain(OLD.name);
});

it('[AC-B2-08e#21] 注销后留存的实名（tax_retained）仍读得到：有过到账的已注销用户不让整季失败', async () => {
  const f = await started(h);
  const member = await user(h, f.appId, 'deleted');
  await verified(h, member, OLD);
  await h.db
    .updateTable('realname')
    .set({ status: 'none', tax_retained: true })
    .where('app_id', '=', member.appId)
    .where('user_id', '=', member.id)
    .execute();
  const row = await paid(h, member);
  const view = await ok<View>(await f.create(MASKED));
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 1 });
  const cells = rowOf(await f.file(view.id), row.out_biz_no);
  expect(cells[COLUMN.name]).toBe(OLD.name);
  expectMaskedIdNo(cells[COLUMN.idNo], OLD.idNo);
});

it.each(['没有实名行', '核验失败', '已清除', '密文解不开'] as const)(
  '[AC-B2-08e#22] 读不到实名（%s）：整任务 failed，不出文件、不入 expire、不写 export_generated',
  async (kind) => {
    const f = await started(h);
    const good = await person(h, f.appId, OLD);
    const bad = await user(h, f.appId);
    if (kind === '核验失败') await failedRealname(h, bad);
    if (kind === '已清除') {
      await h.db
        .insertInto('realname')
        .values({ id: randomUUID(), app_id: bad.appId, user_id: bad.id, status: 'none' })
        .execute();
    }
    if (kind === '密文解不开') {
      await verified(h, bad, OTHER);
      await h.db
        .updateTable('realname')
        .set({ id_no_cipher: Buffer.from('invalid-synthetic-cipher') })
        .where('app_id', '=', bad.appId)
        .where('user_id', '=', bad.id)
        .execute();
    }
    await paid(h, good);
    await paid(h, bad);
    const view = await ok<View>(await f.create(MASKED));
    const row = await f.generate(view.id);
    expect(row).toMatchObject({
      status: 'failed',
      object_key: null,
      expires_at: null,
      row_count: null,
      failure_reason: expect.any(String),
    });
    expect(row.failure_reason).not.toBe('');
    const { store, sent } = await f.entry();
    expect(store.get(`${f.appId}/${view.id}.csv`)).toBeUndefined();
    expect(sent.mock.calls.filter(([, name]) => name === 'expire')).toEqual([]);
    expect((await f.audits()).map((audit) => audit.action)).toEqual(['export_create']);
  },
);

it('[AC-B2-08e#23] 行数等于 admin.export.max_rows 仍完成', async () => {
  const f = await started(h);
  await setMaxRows(h, f.appId, 3);
  const member = await person(h, f.appId, OLD);
  for (let i = 0; i < 3; i += 1) await paid(h, member);
  const view = await ok<View>(await f.create(MASKED));
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 3 });
  expect((await f.file(view.id)).rows).toHaveLength(3);
});

it('[AC-B2-08e#24] 超 admin.export.max_rows：failed 不截断，failure_reason 指向该配置项', async () => {
  const f = await started(h);
  await setMaxRows(h, f.appId, 2);
  const member = await person(h, f.appId, OLD);
  for (let i = 0; i < 3; i += 1) await paid(h, member);
  const view = await ok<View>(await f.create(MASKED));
  const row = await f.generate(view.id);
  expect(row).toMatchObject({
    status: 'failed',
    object_key: null,
    expires_at: null,
    row_count: null,
  });
  expect(row.failure_reason).toContain(MAX_ROWS_KEY);
  const { store } = await f.entry();
  expect(store.get(`${f.appId}/${view.id}.csv`)).toBeUndefined();
  expect((await f.audits()).map((audit) => audit.action)).toEqual(['export_create']);
});

it('[AC-B2-08e#25] 跨页与多人：1005 行每行一次，身份不串行', async () => {
  const f = await started(h);
  const account = accountCipher(h, 'alipay', ALIPAY_PHONE);
  const third = identity('冯小北', '320102', '1990-01-15', '051');
  const nameOf = new Map<string, string>();
  for (const [index, who] of [OLD, OTHER, third].entries()) {
    const member = await person(h, f.appId, who);
    const rows = await seedMany(
      h.db,
      { appId: member.appId, userId: member.id },
      Array.from({ length: 335 }, (_, i) => ({
        payee_account_cipher: account,
        // Ties on paid_at across pages, as a payout batch lands them.
        paid_at: new Date(Q4_START.getTime() + Math.floor((i * 3 + index) / 2) * 1000),
      })),
    );
    for (const row of rows) nameOf.set(row.out_biz_no, who.name);
  }
  const view = await ok<View>(await f.create(MASKED));
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 1005 });
  const file = await f.file(view.id);
  expect(file.rows).toHaveLength(1005);
  expect(new Set(file.rows.map((cells) => cells[COLUMN.outBizNo])).size).toBe(1005);
  for (const cells of file.rows) {
    expect(cells[COLUMN.name]).toBe(nameOf.get(cells[COLUMN.outBizNo]!));
  }
}, 120_000);

it('[AC-B2-08e#26] 季度内没有到账：done，row_count=0，文件只有首行说明与表头', async () => {
  const f = await started(h);
  await paid(h, await person(h, f.appId, OLD));
  const view = await ok<View>(await f.create({ ...MASKED, filters: { quarter: '2027-Q1' } }));
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 0 });
  const file = await f.file(view.id);
  expect(file.line).toContain(f.actor.username);
  expect(file.header).toHaveLength(9);
  expect(file.rows).toEqual([]);
});
