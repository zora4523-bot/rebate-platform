import { expect, it } from 'vitest';
import { account, useHarness } from '../../admin/auth/kit.ts';
import { PAID, CREATED, claim, detail, item, log, setup } from './kit.ts';

const h = useHarness();

it('[AC-B1-10j#18] 子项独立显示证据、决定、版本、处理时间与处理人；父级保留最新说明', async () => {
  const s = await setup(h);
  const reviewer = await account(h, { app_id: s.appId, display_name: '客服小林' });
  const c = await claim(s, { reason: '核实第一个子项' });
  const link = await log(s);
  const decidedAt = '2026-10-08T03:00:00.000Z';
  const approved = await item(s, c, {
    evidence: 'strong',
    evidence_link_log_ids: [link.id],
    decision: 'approved',
    decided_by: reviewer.id,
    decided_at: decidedAt,
    row_version: 7,
  });
  const weak = await item(s, c, { evidence: 'weak', evidence_link_log_ids: [link.id] });
  const rejected = await item(s, c, {
    decision: 'rejected',
    reject_reason: 'NO_EVIDENCE',
    decided_by: s.a.id,
    decided_at: decidedAt,
    row_version: 3,
  });
  const d = await detail(await s.get({}, c.id));
  expect(d).toMatchObject({
    claim_id: c.id,
    order_no: c.order_no,
    platform: 'jd',
    paid_date: PAID,
    submitted_at: CREATED,
    status: 'manual_review',
    evidence_level: 'none',
    reason: '核实第一个子项',
    user: { user_id: s.userId, phone_masked: null },
  });
  expect(d.items).toHaveLength(3);
  expect(d.items.find((i) => i.item_id === approved.id)).toMatchObject({
    sub_order_id: approved.sub_order_id,
    evidence: 'strong',
    decision: 'approved',
    reject_reason: null,
    decided_at: decidedAt,
    decided_by: reviewer.id,
    decided_by_name: '客服小林',
    row_version: 7,
  });
  expect(d.items.find((i) => i.item_id === weak.id)).toMatchObject({
    evidence: 'weak',
    decision: null,
    reject_reason: null,
    decided_at: null,
    decided_by: null,
    decided_by_name: null,
    row_version: 0,
  });
  expect(d.items.find((i) => i.item_id === rejected.id)).toMatchObject({
    evidence: 'none',
    decision: 'rejected',
    reject_reason: 'NO_EVIDENCE',
    decided_at: decidedAt,
    decided_by: s.a.id,
    decided_by_name: s.a.username,
    row_version: 3,
    evidence_links: [],
  });
});

it.each(['NOT_IN_POOL', 'ORDER_INVALID'])(
  '[AC-B1-10j#19] 系统驳回 %s 无处理人名字',
  async (reason) => {
    const s = await setup(h);
    const c = await claim(s, { status: 'rejected' });
    await item(s, c, {
      decision: 'rejected',
      reject_reason: reason,
      decided_at: CREATED,
      row_version: 1,
    });
    const d = await detail(await s.get({}, c.id));
    expect(d.items[0]).toMatchObject({
      decision: 'rejected',
      reject_reason: reason,
      decided_by: null,
      decided_by_name: null,
    });
  },
);

it('[AC-B1-10j#20] 命中记录按时间倒序，保留空 scene，仅输出 at 和 scene，不混入未引用记录', async () => {
  const s = await setup(h);
  const c = await claim(s, { evidence_level: 'weak' });
  const old = await log(s, { scene: 'search', created_at: '2026-10-04T01:00:00.000Z' });
  const historical = await log(s, { scene: null, created_at: '2026-10-04T02:00:00.000Z' });
  const recent = await log(s, { scene: 'detail', created_at: '2026-10-05T01:00:00.000Z' });
  await log(s, { scene: 'feed', created_at: '2026-10-05T02:00:00.000Z' });
  const child = await item(s, c, {
    evidence: 'weak',
    evidence_link_log_ids: [old.id, recent.id, historical.id],
  });
  const other = await item(s, c, { evidence: 'strong', evidence_link_log_ids: [old.id] });
  const d = await detail(await s.get({}, c.id));
  expect(d.items.find((i) => i.item_id === child.id)?.evidence_links).toEqual([
    { at: '2026-10-05T01:00:00.000Z', scene: 'detail' },
    { at: '2026-10-04T02:00:00.000Z', scene: null },
    { at: '2026-10-04T01:00:00.000Z', scene: 'search' },
  ]);
  expect(d.items.find((i) => i.item_id === other.id)?.evidence_links).toEqual([
    { at: '2026-10-04T01:00:00.000Z', scene: 'search' },
  ]);
});

it('[AC-B1-10j#21] 父单逐项比对父单号，支付日期按北京时间，预售使用定金日期', async () => {
  const s = await setup(h);
  const c = await claim(s, { order_no: 'PARENT-COMPARE' });
  const regular = await item(s, c);
  const presale = await item(
    s,
    c,
    {},
    {
      is_presale: true,
      deposit_paid_at: '2026-10-05T16:01:00.000Z',
      paid_at: '2026-10-07T03:00:00.000Z',
    },
  );
  const d = await detail(await s.get({}, c.id));
  for (const child of [regular, presale]) {
    const matches = d.items.find((i) => i.item_id === child.id)?.matches;
    expect(matches).toHaveLength(2);
    expect(matches).toEqual(
      expect.arrayContaining([
        { field: 'order_no', user_value: c.order_no, union_value: c.order_no, matched: true },
        { field: 'paid_date', user_value: PAID, union_value: PAID, matched: true },
      ]),
    );
  }
});

it('[AC-B1-10j#22] 子单提交比对子单号；不一致或缺失的联盟字段不能标成一致', async () => {
  const s = await setup(h);
  const c = await claim(s, { order_no: 'SUB-COMPARE', order_no_type: 'sub' });
  const correct = await item(
    s,
    c,
    {},
    { sub_order_id: c.order_no, parent_order_id: 'DIFFERENT-PARENT' },
  );
  const changed = await item(s, c, {}, { paid_at: '2026-10-04T15:59:00.000Z' });
  const missing = await item(s, c, {}, { paid_at: null });
  const d = await detail(await s.get({}, c.id));
  expect(d.items.find((i) => i.item_id === correct.id)?.matches).toEqual(
    expect.arrayContaining([
      { field: 'order_no', user_value: c.order_no, union_value: c.order_no, matched: true },
    ]),
  );
  expect(d.items.find((i) => i.item_id === changed.id)?.matches).toEqual(
    expect.arrayContaining([
      {
        field: 'order_no',
        user_value: c.order_no,
        union_value: changed.sub_order_id,
        matched: false,
      },
      { field: 'paid_date', user_value: PAID, union_value: '2026-10-04', matched: false },
    ]),
  );
  expect(d.items.find((i) => i.item_id === missing.id)?.matches).toEqual(
    expect.arrayContaining([
      { field: 'paid_date', user_value: PAID, union_value: null, matched: false },
    ]),
  );
});

it('[AC-B1-10j#23] 名字使用处理人的当前展示名，无展示名回落登录名', async () => {
  const s = await setup(h);
  const reviewer = await account(h, { app_id: s.appId, display_name: null });
  const c = await claim(s, { status: 'approved' });
  await item(s, c, { decision: 'approved', decided_by: reviewer.id, decided_at: CREATED });
  expect((await detail(await s.get({}, c.id))).items[0]?.decided_by_name).toBe(reviewer.username);
  await h.db
    .updateTable('admin_users')
    .set({ display_name: '客服新名字' })
    .where('id', '=', reviewer.id)
    .execute();
  expect((await detail(await s.get({}, c.id))).items[0]?.decided_by_name).toBe('客服新名字');
});
