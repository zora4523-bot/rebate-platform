import { expect, it } from 'vitest';
import type {
  AdminClaimFilter,
  AdminClaimItemRow,
  AdminClaimReads,
  AdminClaimRow,
} from '../infra/admin-claim-reads.ts';
import { AdminClaims, AdminClaimsFieldsError, type AdminClaimsDeps } from './admin-claims.ts';

const APP = 'claims_unit';
const USER = '019c0000-0000-7000-8000-000000000001';
const ADMIN = '019c0000-0000-7000-8000-0000000000a1';
const CLAIM = '019c0000-0000-7000-8000-0000000000c1';

const row = (patch: Partial<AdminClaimRow> = {}): AdminClaimRow => ({
  id: CLAIM,
  user_id: USER,
  platform: 'jd',
  order_no: 'PARENT-1',
  order_no_type: 'parent',
  paid_day: '2026-10-06',
  evidence_level: 'none',
  status: 'manual_review',
  reason: null,
  created_at: new Date('2026-10-08T02:00:00.000Z'),
  ...patch,
});

const itemRow = (patch: Partial<AdminClaimItemRow> = {}): AdminClaimItemRow => ({
  id: '019c0000-0000-7000-8000-0000000000d1',
  sub_order_id: 'CHILD-1',
  evidence: 'none',
  evidence_link_log_ids: [],
  decision: null,
  reject_reason: null,
  decided_by: null,
  decided_at: null,
  row_version: 0,
  order_sub_order_id: 'CHILD-1',
  parent_order_id: 'PARENT-1',
  is_presale: false,
  deposit_paid_at: null,
  paid_at: new Date('2026-10-05T16:30:00.000Z'),
  ...patch,
});

interface Calls {
  counts: AdminClaimFilter[];
  pages: { filter: AdminClaimFilter; status: string | undefined; offset: number; limit: number }[];
  phones: string[][];
  names: string[][];
  links: bigint[][];
}

function build(
  data: {
    counts?: { status: string; n: number }[];
    rows?: AdminClaimRow[];
    claim?: AdminClaimRow;
    items?: AdminClaimItemRow[];
  } = {},
): { claims: AdminClaims; calls: Calls } {
  const calls: Calls = { counts: [], pages: [], phones: [], names: [], links: [] };
  const reads: AdminClaimReads = {
    async counts(filter) {
      calls.counts.push(filter);
      return data.counts ?? [];
    },
    async page(filter, status, offset, limit) {
      calls.pages.push({ filter, status, offset, limit });
      return data.rows ?? [];
    },
    async claim(appId, claimId) {
      return data.claim !== undefined && appId === APP && claimId === data.claim.id
        ? data.claim
        : undefined;
    },
    async items() {
      return data.items ?? [];
    },
  };
  const deps: AdminClaimsDeps = {
    reads,
    async phones(_appId, ids) {
      calls.phones.push([...ids]);
      return new Map(ids.map((id) => [id, id === USER ? '138****5678' : null]));
    },
    async reviewerNames(_appId, ids) {
      calls.names.push([...ids]);
      return new Map(ids.filter((id) => id === ADMIN).map((id) => [id, '客服小林']));
    },
    async linkMoments(_appId, ids) {
      calls.links.push([...ids]);
      return new Map([['7', { at: new Date('2026-10-05T01:00:00.000Z'), scene: null }]]);
    },
  };
  return { claims: new AdminClaims(deps), calls };
}

it('[AC-B1-10j#15] q 非法在读库前报 q；合法 q 规范化后进入筛选', async () => {
  const { claims, calls } = build();
  await expect(claims.list(APP, { q: '   ' })).rejects.toEqual(new AdminClaimsFieldsError(['q']));
  await expect(claims.list(APP, { q: 'x'.repeat(65) })).rejects.toBeInstanceOf(
    AdminClaimsFieldsError,
  );
  expect(calls.counts).toEqual([]);
  await claims.list(APP, { q: ' A B ', platform: 'jd', evidence_level: 'weak', user_id: USER });
  expect(calls.counts).toEqual([
    { appId: APP, platform: 'jd', evidenceLevel: 'weak', userId: USER, q: 'AB' },
  ]);
});

it('[AC-B1-10j#29] 列表含尚未计算证据的 submitted 行：evidence_level 为 null；total 按状态取计数', async () => {
  const { claims, calls } = build({
    counts: [
      { status: 'submitted', n: 1 },
      { status: 'approved', n: 2 },
    ],
    rows: [row({ status: 'submitted', evidence_level: null })],
  });
  const all = await claims.list(APP, {});
  expect(all).toEqual({
    items: [
      {
        claim_id: CLAIM,
        order_no: 'PARENT-1',
        platform: 'jd',
        user: { user_id: USER, phone_masked: '138****5678' },
        paid_date: '2026-10-06',
        submitted_at: '2026-10-08T02:00:00.000Z',
        evidence_level: null,
        status: 'submitted',
      },
    ],
    page: 1,
    page_size: 20,
    total: 3,
    counts: {
      submitted: 1,
      auto_matched: 0,
      manual_review: 0,
      approved: 2,
      rejected: 0,
      cancelled: 0,
    },
  });
  expect(calls.pages).toEqual([
    { filter: { appId: APP }, status: undefined, offset: 0, limit: 20 },
  ]);
  const rejected = await claims.list(APP, { status: 'rejected' });
  expect(rejected).toMatchObject({ items: [], total: 0, counts: all.counts });
  // Nothing to read past the last row: the page query is skipped.
  expect(calls.pages).toHaveLength(1);
  await claims.list(APP, { status: 'approved', page: 2, page_size: 1 });
  expect(calls.pages[1]).toEqual({
    filter: { appId: APP },
    status: 'approved',
    offset: 1,
    limit: 1,
  });
});

it('[AC-B1-10j#18] 详情：子项证据为 null 且无命中记录；处理人名字经端口，系统决定无名字', async () => {
  const { claims, calls } = build({
    claim: row({ status: 'submitted', evidence_level: null, reason: '说明' }),
    items: [
      itemRow({ evidence: null, evidence_link_log_ids: null }),
      itemRow({
        id: '019c0000-0000-7000-8000-0000000000d2',
        evidence: 'weak',
        evidence_link_log_ids: [7n],
        decision: 'approved',
        decided_by: ADMIN,
        decided_at: new Date('2026-10-08T03:00:00.000Z'),
        row_version: 4,
      }),
      itemRow({
        id: '019c0000-0000-7000-8000-0000000000d3',
        decision: 'rejected',
        reject_reason: 'NOT_IN_POOL',
        decided_at: new Date('2026-10-08T03:00:00.000Z'),
      }),
      itemRow({
        id: '019c0000-0000-7000-8000-0000000000d4',
        decision: 'approved',
        decided_by: '019c0000-0000-7000-8000-0000000000a9',
        decided_at: new Date('2026-10-08T03:00:00.000Z'),
      }),
    ],
  });
  const d = await claims.detail(APP, CLAIM, undefined);
  expect(d).toMatchObject({
    claim_id: CLAIM,
    evidence_level: null,
    status: 'submitted',
    reason: '说明',
    user: { user_id: USER, phone_masked: '138****5678' },
  });
  expect(d.items[0]).toMatchObject({
    evidence: null,
    evidence_links: [],
    decision: null,
    decided_at: null,
    decided_by: null,
    decided_by_name: null,
    row_version: 0,
  });
  expect(d.items[0]?.matches).toHaveLength(2);
  expect(d.items[1]).toMatchObject({
    evidence: 'weak',
    decision: 'approved',
    decided_at: '2026-10-08T03:00:00.000Z',
    decided_by: ADMIN,
    decided_by_name: '客服小林',
    row_version: 4,
    evidence_links: [{ at: '2026-10-05T01:00:00.000Z', scene: null }],
  });
  expect(d.items[2]).toMatchObject({ reject_reason: 'NOT_IN_POOL', decided_by_name: null });
  // A reviewer whose account is gone shows no name.
  expect(d.items[3]).toMatchObject({ decided_by_name: null });
  expect(calls.links).toEqual([[7n]]);
});

it('[AC-B1-10j#5] 带 user_id 时他人 claim 与未知 claim 同样报 claim_id；无命中记录与处理人时不调端口', async () => {
  const { claims, calls } = build({ claim: row(), items: [itemRow()] });
  await expect(claims.detail(APP, CLAIM, '019c0000-0000-7000-8000-000000000002')).rejects.toEqual(
    new AdminClaimsFieldsError(['claim_id']),
  );
  await expect(
    claims.detail(APP, '019c0000-0000-7000-8000-0000000000c9', undefined),
  ).rejects.toEqual(new AdminClaimsFieldsError(['claim_id']));
  await expect(claims.detail('other_app', CLAIM, undefined)).rejects.toBeInstanceOf(
    AdminClaimsFieldsError,
  );
  expect((await claims.detail(APP, CLAIM, USER)).claim_id).toBe(CLAIM);
  expect(calls.names).toEqual([]);
  expect(calls.links).toEqual([]);
});

it('[AC-B1-10j] 无数据库时读取失败（50001），不伪装成空页', async () => {
  const claims = new AdminClaims();
  await expect(claims.list(APP, {})).rejects.toThrow('database');
  await expect(claims.detail(APP, CLAIM, undefined)).rejects.toThrow('database');
});

it('[AC-B1-10j#17] 列表 user_id 非 UUID 在读库前报 user_id；与非法 q 同时出现时两者都报', async () => {
  const { claims, calls } = build();
  await expect(claims.list(APP, { user_id: 'not-a-uuid' })).rejects.toEqual(
    new AdminClaimsFieldsError(['user_id']),
  );
  await expect(claims.list(APP, { user_id: `${USER}x` })).rejects.toEqual(
    new AdminClaimsFieldsError(['user_id']),
  );
  await expect(claims.list(APP, { q: '  ', user_id: '' })).rejects.toEqual(
    new AdminClaimsFieldsError(['q', 'user_id']),
  );
  await expect(new AdminClaims().list(APP, { user_id: 'not-a-uuid' })).rejects.toEqual(
    new AdminClaimsFieldsError(['user_id']),
  );
  expect(calls.counts).toEqual([]);
  expect(calls.pages).toEqual([]);
  await claims.list(APP, { user_id: USER.toUpperCase() });
  expect(calls.counts).toEqual([{ appId: APP, userId: USER.toUpperCase() }]);
});

it('[AC-B1-10j#6] 详情 claim_id 非 UUID 与未知 claim 同样报 claim_id，不读库', async () => {
  const { claims, calls } = build({ claim: row(), items: [itemRow()] });
  for (const id of ['not-a-uuid', `${CLAIM}0`, '', `'; select 1; --`]) {
    await expect(claims.detail(APP, id, undefined)).rejects.toEqual(
      new AdminClaimsFieldsError(['claim_id']),
    );
  }
  await expect(new AdminClaims().detail(APP, 'not-a-uuid', undefined)).rejects.toEqual(
    new AdminClaimsFieldsError(['claim_id']),
  );
  expect(calls.phones).toEqual([]);
});
