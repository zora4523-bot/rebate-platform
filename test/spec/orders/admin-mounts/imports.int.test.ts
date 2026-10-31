// B1-10m: an upload through the real admin entry, then its rights_import job on the handler the real
// worker assembly registered: rights and punish rows reach order_rights through settlement's rights
// command, channel rows reach blocklist through risk's port. The templates are synthetic (K-3: no
// real template exists yet; ../rights-import-task precedent), injected over the real job, whose
// processors stay the assembly's. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { form, xlsx } from '../rights-import-task/kit.ts';
import {
  ANSWER,
  GRANTS,
  IMPORTS,
  NOW,
  accepted,
  attributedOrder,
  orderNow,
  seedUnionAccount,
  setup,
  shareImportStore,
  worker,
  type Scenario,
} from './kit.ts';

const templates = vi.hoisted(() => ({
  rights: {
    columns: {
      sub_order_id: '子订单号（合成）',
      rights_no: '维权单号（合成）',
      status: '维权状态（合成）',
      amount: '维权金额（合成）',
      deduction_commission: '扣回佣金（合成）',
      occurred_at: '发生时间（合成）',
    },
  },
  punish: {
    columns: {
      sub_order_id: '子订单号（合成）',
      rights_no: '违规单号（合成）',
      amount: '违规金额（合成）',
      deduction_commission: '扣回佣金（合成）',
      occurred_at: '发生时间（合成）',
    },
  },
  channel: { columns: { relation_id: '渠道关系（合成）', end_at: '截止时间（合成）' } },
}));

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../apps/api/src/modules/orders/jobs/rights-import.ts')
    >();
  return {
    ...actual,
    handleRightsImport: (...[job, deps]: Parameters<typeof actual.handleRightsImport>) =>
      actual.handleRightsImport(job, {
        ...deps,
        templates: { find: (kind) => templates[kind] },
      }),
  };
});

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

const OCCURRED = '2026-10-07T10:00:00+08:00';

/** Uploads through the admin entry; the worker's handler takes the job the entry sent. */
async function imported(
  s: Scenario,
  fields: Readonly<Record<string, string>>,
  rows: readonly (readonly (string | null)[])[],
  options: { stepUp?: string } = {},
) {
  const created = await accepted<{ import_id: string; status: string }>(
    await s.upload(form(fields, xlsx(rows)), options),
    ANSWER.rights,
  );
  expect(created.status).toBe('queued');
  const w = await worker(h);
  await w.run(s.importJob(created.import_id));
  return created.import_id;
}

function rightsOf(s: Scenario) {
  return s.h.db
    .selectFrom('order_rights')
    .selectAll()
    .where('app_id', '=', s.appId)
    .orderBy('id')
    .execute();
}

it('[AC-B1-10m#22] 维权单行经真实 rights 端口落 order_rights（来源 IMPORT，金额元转分），订单 rights_pending；查不到的子订单是行失败；详情与列表读到结果', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const order = await attributedOrder(s);
  const importId = await imported(s, { kind: 'rights', platform: 'jd' }, [
    Object.values(templates.rights.columns),
    [order.sub_order_id, 'RN-1', 'PROCESSING', '12.34', null, OCCURRED],
    ['NO-SUCH-SUB-ORDER', 'RN-2', 'PROCESSING', '1.00', null, OCCURRED],
  ]);

  const rights = await rightsOf(s);
  expect(rights).toHaveLength(1);
  expect(rights[0]).toMatchObject({
    order_id: order.order_id,
    source: 'IMPORT',
    type: 'RIGHTS',
    status: 'PROCESSING',
    platform_rights_no: 'RN-1',
    deduction_commission_fen: null,
  });
  expect(String(rights[0]!.amount_fen)).toBe('1234');
  expect(rights[0]!.occurred_at).toEqual(new Date(OCCURRED));
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rights_pending: true,
    rebate_status: 'ESTIMATED',
  });

  const detail = await accepted(await s.get(`${IMPORTS}/${importId}`), ANSWER.detail);
  expect(detail).toMatchObject({
    import_id: importId,
    kind: 'rights',
    status: 'done',
    total_rows: 2,
    succeeded_rows: 1,
    failed_rows: 1,
    created_by: s.admin.id,
    failures: [{ row_no: 3, reason: 'order_not_found' }],
  });
  const page = await accepted(await s.get(`${IMPORTS}?page=1&page_size=20`), ANSWER.list);
  expect(page).toMatchObject({ items: [{ import_id: importId, status: 'done' }], total: 1 });
}, 120_000);

it('[AC-B1-10m#23] 违规单行经真实 rights 端口：order_rights type PUNISH、SUCCEEDED，入账前的订单经真实 rebate 走 R6 作废', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const order = await attributedOrder(s);
  await imported(s, { kind: 'punish', platform: 'jd' }, [
    Object.values(templates.punish.columns),
    [order.sub_order_id, 'PN-1', '3.00', null, OCCURRED],
  ]);
  const rights = await rightsOf(s);
  expect(rights).toHaveLength(1);
  expect(rights[0]).toMatchObject({
    order_id: order.order_id,
    source: 'IMPORT',
    type: 'PUNISH',
    status: 'SUCCEEDED',
    platform_rights_no: 'PN-1',
  });
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rebate_status: 'VOID',
    reason: 'PUNISH',
  });
}, 120_000);

it('[AC-B1-10m#24] 渠道单行经 risk 的真实端口写 blocklist：渠道维度、任务的联盟账号、start_at 为受理时间、created_by 为导入人；任务 done', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.channel });
  const accountId = await seedUnionAccount(s);
  const relationId = `REL-${s.appId}`;
  const importId = await imported(
    s,
    { kind: 'channel', platform: 'taobao', union_account_id: accountId },
    [Object.values(templates.channel.columns), [relationId, null]],
    { stepUp: await s.stepUp(s.admin) },
  );
  const entries = await s.h.db
    .selectFrom('blocklist')
    .selectAll()
    .where('app_id', '=', s.appId)
    .execute();
  expect(entries).toEqual([
    expect.objectContaining({
      dimension: 'channel',
      value: relationId,
      platform: 'taobao',
      union_account_id: accountId,
      start_at: new Date(NOW),
      end_at: null,
      status: 'active',
      created_by: s.admin.id,
    }),
  ]);
  const detail = await accepted(await s.get(`${IMPORTS}/${importId}`), ANSWER.detail);
  expect(detail).toMatchObject({
    kind: 'channel',
    status: 'done',
    succeeded_rows: 1,
    failures: [],
  });
}, 120_000);
