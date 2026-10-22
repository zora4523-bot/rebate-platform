import { expect, it, vi } from 'vitest';
import {
  AdminClaims,
  AdminClaimsFieldsError,
  type AdminClaimsDeps,
} from '../../../../apps/api/src/modules/orders/application/admin-claims.ts';
import type { AdminClaimRow } from '../../../../apps/api/src/modules/orders/infra/admin-claim-reads.ts';

const APP = 'read_hardening';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
const CLAIM = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5aa0';

it('[AC-B1-34j#4] 详情 user_id 的大小写不影响申请人匹配，其他用户与跨应用仍拒绝', async () => {
  const row: AdminClaimRow = {
    id: CLAIM,
    user_id: USER,
    platform: 'jd',
    order_no: 'PARENT-1',
    order_no_type: 'parent',
    paid_day: '2026-10-22',
    evidence_level: 'none',
    status: 'manual_review',
    reason: null,
    created_at: new Date('2026-10-23T00:00:00.000Z'),
  };
  const phones = vi.fn<AdminClaimsDeps['phones']>(async () => new Map([[USER, '138****5678']]));
  const items = vi.fn<AdminClaimsDeps['reads']['items']>(async () => []);
  const claims = new AdminClaims({
    reads: {
      counts: async () => [],
      page: async () => [],
      claim: async (appId, claimId) => (appId === APP && claimId === CLAIM ? row : undefined),
      items,
    },
    phones,
    reviewerNames: async () => new Map(),
    linkMoments: async () => new Map(),
  });
  for (const [appId, claimId, userId] of [
    [APP, CLAIM, '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c03'.toUpperCase()],
    ['other_app', CLAIM, USER.toUpperCase()],
    [APP, '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5aa1', USER.toUpperCase()],
  ] as const) {
    await expect(claims.detail(appId, claimId, userId)).rejects.toEqual(
      new AdminClaimsFieldsError(['claim_id']),
    );
  }
  expect(phones).not.toHaveBeenCalled();
  expect(items).not.toHaveBeenCalled();

  const canonical = await claims.detail(APP, CLAIM, USER);
  expect(canonical).toMatchObject({
    claim_id: CLAIM,
    user: { user_id: USER, phone_masked: '138****5678' },
    items: [],
  });
  phones.mockClear();
  for (const userId of [undefined, USER.toUpperCase(), USER.replace('a3b4', 'A3b4')]) {
    let result: unknown;
    try {
      result = await claims.detail(APP, CLAIM, userId);
    } catch (error) {
      result = error;
    }
    expect.soft(result).toEqual(canonical);
  }
  // Case normalization must not change the stored identity passed to the masking port.
  expect(phones.mock.calls).toEqual([
    [APP, [USER]],
    [APP, [USER]],
    [APP, [USER]],
  ]);
});
