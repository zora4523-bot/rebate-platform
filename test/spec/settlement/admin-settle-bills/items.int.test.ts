// B2-09d batch item rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// listAdminSettleBatchItems (GET /admin/v1/settle-batches/{batch_id}/items: settle.bill or
// fund.view, read only, no step-up; one row per settle_batch_items row of the batch with its
// columns as stored — user_id, role and beneficiary_credit_id on beneficiary items only, amount_fen
// null before execution, result null while pending — the user_id only, never a phone number;
// filters item_type and result (credited / skipped / deferred, or pending = result null) combine
// with AND; a value outside the enums → 20001 data.fields naming it; settle_seq then id ascending;
// page_size ≤ 200; total = count of the filter set; an unknown batch_id or a batch of another app
// → 20001 data.fields=[batch_id], no 404; reading writes no audit record); 08 BR-FUND-04 ⑦ ⑫.
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BILL,
  ITEM_KEYS,
  VIEW,
  allAudits,
  answer,
  fixture,
  footprint,
  inCheckOrder,
  itemIds,
  itemView,
  normalize,
  page,
  seedBatch,
  seedBeneficiaryItem,
  seedBill,
  seedMember,
  seedOrderItem,
  suite,
  withSettleAdmin,
  type ItemRow,
} from './kit.ts';

const s = suite();
/** 2^53 − 1: the largest fen amount a JSON number carries exactly. */
const BIG = 9_007_199_254_740_991n;

it('[AC-B2-09d#15] 批次明细（settle.bill 或 fund.view 任一即可，超管也能读）：只列该批次的明细，按 settle_seq、再按 id 升序，每行恰好是契约的 AdminSettleBatchItem——订单行的 user_id / role / beneficiary_credit_id 为 null、受益人项带受益人、角色与补记义务；金额整数分原样（含 2^53−1），执行前 amount_fen 为 null，未执行 result 为 null；同账单其他批次与其他应用的明细不出现；只有 user_id，不出手机号（明文与 3+4 掩码都不出现）；默认 page 1 / page_size 20；读取不写审计、不改三张表', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill, { status: 'DONE', order_count: 3 });
  const sibling = await seedBatch(f, bill, { platform: 'jd', status: 'DONE' });
  const foreignBill = await seedBill(other, '2026-09');
  const foreign = await seedBatch(other, foreignBill, { status: 'DONE' });
  await seedOrderItem(other, foreign, { result: 'credited' });
  await withSettleAdmin(f, async (h) => {
    const member = await seedMember(f, h.crypto);
    const sharer = await seedMember(f, h.crypto);
    const items: ItemRow[] = [
      await seedOrderItem(f, batch, { settle_seq: 3, b_settle_fen: 720n, result: 'credited' }),
      await seedOrderItem(f, batch, { settle_seq: 1, b_settle_fen: BIG, result: 'skipped' }),
      await seedOrderItem(f, batch, { settle_seq: 1, b_settle_fen: 0n }),
      await seedBeneficiaryItem(f, batch, member, {
        settle_seq: 2,
        result: 'credited',
        amount_fen: 36n,
      }),
      await seedBeneficiaryItem(f, batch, sharer, {
        role: 'share',
        settle_seq: 2,
        b_settle_fen: 500n,
        result: 'deferred',
      }),
      await seedBeneficiaryItem(f, batch, member, { role: 'self', settle_seq: 1 }),
      await seedBeneficiaryItem(f, batch, sharer, {
        role: 'indirect',
        settle_seq: 4,
        result: 'skipped',
        skip_reason: 'beneficiary_blocked',
      }),
    ];
    await seedOrderItem(f, sibling, { result: 'credited' });
    const expected = inCheckOrder(items).map(itemView);
    const before = await footprint(f);
    const root = await h.caller([], { superAdmin: true });
    for (const who of [h.biller, h.viewer, await h.caller([BILL, VIEW]), root]) {
      const sent = await h.items(batch.batch_id, {}, who);
      const data = await page(sent);
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: 1,
        page_size: 20,
        total: items.length,
      });
      for (const item of data.items) expect(Object.keys(item).sort()).toEqual([...ITEM_KEYS]);
      expect(data.items.map(normalize)).toEqual(expected);
      for (const secret of [member.phone, member.phoneMasked, sharer.phone, sharer.phoneMasked]) {
        expect(sent.body.includes(secret), 'a phone number in the batch items').toBe(false);
      }
      expect(sent.body.includes('phone'), 'a phone field in the batch items').toBe(false);
    }
    const large = (await page(await h.items(batch.batch_id))).items.find(
      (item) => item['b_settle_fen'] === Number(BIG),
    );
    expect(large?.['item_type']).toBe('order');
    expect(await footprint(f)).toEqual(before);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09d#16] 批次明细的筛选与分页：item_type、result（credited、skipped、deferred，或 pending = 尚未执行、result 为 null）按 AND 组合，total 为过滤后的总数，无匹配是空页；page / page_size 翻页，超过最后一页是空 items；page_size 200 可用', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill, { status: 'PARTIAL' });
  await withSettleAdmin(f, async (h) => {
    const member = await seedMember(f, h.crypto);
    const o1 = await seedOrderItem(f, batch, { settle_seq: 1, result: 'credited' });
    const o2 = await seedOrderItem(f, batch, { settle_seq: 2, result: 'skipped' });
    const o3 = await seedOrderItem(f, batch, { settle_seq: 3 });
    const o4 = await seedOrderItem(f, batch, { settle_seq: 4, result: 'credited' });
    const b1 = await seedBeneficiaryItem(f, batch, member, {
      settle_seq: 5,
      result: 'credited',
      amount_fen: 12n,
    });
    const b2 = await seedBeneficiaryItem(f, batch, member, {
      role: 'share',
      settle_seq: 6,
      result: 'deferred',
    });
    const b3 = await seedBeneficiaryItem(f, batch, member, { role: 'self', settle_seq: 7 });
    const ids = (...rows: ItemRow[]) => rows.map((row) => row.id);
    const listed = async (query: Record<string, string>, want: string[]) => {
      const data = await page(await h.items(batch.batch_id, query));
      expect(data.total, JSON.stringify(query)).toBe(want.length);
      expect(
        data.items.map((item) => item['id']),
        JSON.stringify(query),
      ).toEqual(want);
    };
    await listed({}, ids(o1, o2, o3, o4, b1, b2, b3));
    await listed({ item_type: 'order' }, ids(o1, o2, o3, o4));
    await listed({ item_type: 'beneficiary' }, ids(b1, b2, b3));
    await listed({ result: 'credited' }, ids(o1, o4, b1));
    await listed({ result: 'skipped' }, ids(o2));
    await listed({ result: 'deferred' }, ids(b2));
    await listed({ result: 'pending' }, ids(o3, b3));
    await listed({ item_type: 'order', result: 'pending' }, ids(o3));
    await listed({ item_type: 'beneficiary', result: 'credited' }, ids(b1));
    await listed({ item_type: 'order', result: 'deferred' }, []);

    const order = ids(o1, o2, o3, o4, b1, b2, b3);
    const walked: unknown[] = [];
    for (const n of [1, 2, 3]) {
      const data = await page(await h.items(batch.batch_id, { page: String(n), page_size: '3' }));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: n,
        page_size: 3,
        total: 7,
      });
      walked.push(...data.items.map((item) => item['id']));
    }
    expect(walked).toEqual(order);
    expect(await page(await h.items(batch.batch_id, { page: '4', page_size: '3' }))).toEqual({
      items: [],
      page: 4,
      page_size: 3,
      total: 7,
    });
    const credited = await page(
      await h.items(batch.batch_id, { result: 'credited', page: '2', page_size: '2' }),
    );
    expect({ total: credited.total, ids: credited.items.map((item) => item['id']) }).toEqual({
      total: 3,
      ids: ids(b1),
    });
    expect(await itemIds(await h.items(batch.batch_id, { page_size: '200' }))).toEqual(order);
  });
});

it('[AC-B2-09d#17] 批次明细的拒绝：不存在的 batch_id、其他应用的批次、不是 UUID 的 batch_id → 20001 data.fields=[batch_id]（不回 404，应答一样）；item_type、result 不在枚举 → 20001 指名该参数；page_size 超过 200 → [page_size]；没有 settle.bill / fund.view → 10403；不带令牌 → 10001；被驳回批次的明细照常可读；读取不写审计', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const rejected = await seedBatch(f, bill, { status: 'CANCELLED' });
  const item = await seedOrderItem(f, rejected);
  const foreignBill = await seedBill(other, '2026-09');
  const foreign = await seedBatch(other, foreignBill, { status: 'DONE' });
  await seedOrderItem(other, foreign, { result: 'credited' });
  await withSettleAdmin(f, async (h) => {
    const refusals: unknown[] = [];
    for (const batchId of [randomUUID(), foreign.batch_id, 'not-a-uuid']) {
      const body = await answer(await h.items(batchId), 20001, { fields: ['batch_id'] });
      refusals.push({ code: body.code, msg: body.msg, data: body.data });
      await answer(await h.items(batchId, {}, h.viewer), 20001, { fields: ['batch_id'] });
    }
    expect(new Set(refusals.map((refusal) => JSON.stringify(refusal))).size).toBe(1);
    const refused = async (query: Record<string, string>, fields: string[]) => {
      await answer(await h.items(rejected.batch_id, query), 20001, { fields });
    };
    await refused({ item_type: 'refund' }, ['item_type']);
    await refused({ item_type: 'ORDER' }, ['item_type']);
    await refused({ result: 'failed' }, ['result']);
    await refused({ result: 'null' }, ['result']);
    await refused({ page_size: '201' }, ['page_size']);
    await answer(await h.items(rejected.batch_id, {}, await h.caller([])), 10403);
    await answer(await h.items(rejected.batch_id, {}, await h.caller(['fund.recon'])), 10403);
    await answer(await h.items(rejected.batch_id, {}, await h.caller(['pay.view'])), 10403);
    await answer(await h.items(rejected.batch_id, {}, null), 10001);
    const data = await page(await h.items(rejected.batch_id, {}, h.viewer));
    expect(data.items.map(normalize)).toEqual([itemView(item)]);
  });
  expect(await allAudits(f)).toEqual([]);
});
