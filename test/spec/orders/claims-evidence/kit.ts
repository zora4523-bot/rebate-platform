import { expect } from 'vitest';
import {
  judgeClaimEvidence,
  type ClaimEvidenceInput,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { ClaimEvidenceLog } from '../../../../apps/api/src/modules/linking/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
export { capture, value } from '../claims-submit/kit.ts';
import { value } from '../claims-submit/kit.ts';

export const at = (iso: string) => new FixedClock(iso).now();
export const ATTR = '2027-10-20T12:00:00.000Z';
export function log(
  patch: Omit<Partial<ClaimEvidenceLog>, 'id'> & { readonly id?: string | bigint } = {},
): ClaimEvidenceLog {
  return {
    app_id: 'claim-app',
    user_id: 'applicant',
    opener_user_id: null,
    platform: 'taobao',
    event: 'open',
    product_key: 'tb:123',
    shop_id: 'shop-1',
    result_code: 0,
    no_rebate: false,
    no_rebate_reason: null,
    created_at: at('2027-10-12T12:00:00.000Z'),
    pid_scene: 'self',
    cache_hit: false,
    expired: false,
    ...patch,
    id: BigInt(patch.id ?? '101'),
  };
}
export function input(patch: Partial<ClaimEvidenceInput> = {}): ClaimEvidenceInput {
  return {
    appId: 'claim-app',
    userId: 'applicant',
    platform: 'taobao',
    attrAt: at(ATTR),
    productKey: 'tb:123',
    shopId: 'shop-1',
    windowHours: 360,
    logs: [log()],
    bindings: [],
    conflicts: [],
    ...patch,
  };
}
export async function check(
  patch: Partial<ClaimEvidenceInput>,
  evidence: 'strong' | 'weak' | 'none',
  ids: string[],
) {
  const result = await value(() => judgeClaimEvidence(input(patch)));
  expect(result).toEqual({ evidence, evidence_link_log_ids: ids.map(BigInt) });
}
