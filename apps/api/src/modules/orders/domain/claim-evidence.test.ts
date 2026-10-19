// B1-10c 源码旁单元测试：证据判定的纯函数（08 BR-ATTR-18、BR-ID-18）。不连库、不读时钟。
import { expect, it } from 'vitest';
import type { ClaimEvidenceLog } from '../../linking/index.ts';
import { FixedClock } from '../../platform/index.ts';
import {
  backfillWindowHours,
  backfillWindowStart,
  judgeClaimEvidence,
  weakestEvidence,
  type ClaimEvidenceInput,
} from './claim-evidence.ts';

const at = (iso: string) => new FixedClock(iso).now();
const ATTR = at('2027-10-20T12:00:00.000Z');

function log(patch: Partial<ClaimEvidenceLog> = {}): ClaimEvidenceLog {
  return {
    id: 1n,
    app_id: 'a',
    user_id: 'u',
    opener_user_id: null,
    platform: 'taobao',
    event: 'open',
    product_key: 'tb:1',
    shop_id: 's',
    result_code: 0,
    no_rebate: false,
    no_rebate_reason: null,
    created_at: at('2027-10-19T12:00:00.000Z'),
    pid_scene: null,
    cache_hit: false,
    expired: false,
    ...patch,
  };
}

function input(patch: Partial<ClaimEvidenceInput> = {}): ClaimEvidenceInput {
  return {
    appId: 'a',
    userId: 'u',
    platform: 'taobao',
    attrAt: ATTR,
    productKey: 'tb:1',
    shopId: 's',
    windowHours: 360,
    logs: [log()],
    bindings: [],
    conflicts: [],
    ...patch,
  };
}

it('[AC-B1-10c#13] 窗口小时数只认正安全整数，其余取360；窗口起点按绝对毫秒', () => {
  expect([24, 0, -1, 1.5, '24', null].map(backfillWindowHours)).toEqual([
    24, 360, 360, 360, 360, 360,
  ]);
  expect(backfillWindowStart(ATTR, 24)).toEqual(at('2027-10-19T12:00:00.000Z'));
  expect(backfillWindowStart(ATTR, Number.MAX_SAFE_INTEGER).getTime()).toBe(0);
});

it('[AC-B1-10c#1] 同商品为strong，引用只含同商品记录', () => {
  expect(
    judgeClaimEvidence(input({ logs: [log(), log({ id: 2n, product_key: 'tb:2' })] })),
  ).toEqual({ evidence: 'strong', evidence_link_log_ids: [1n] });
});

it('[AC-B1-10c#28] 无返利记录需授权类原因、当前active且付款时无未解决冲突', () => {
  const noRebate = log({ no_rebate: true, no_rebate_reason: 'auth_declined' });
  const active = [{ status: 'active', bound_at: null, released_at: null }];
  expect(judgeClaimEvidence(input({ logs: [noRebate] })).evidence).toBe('none');
  expect(judgeClaimEvidence(input({ logs: [noRebate], bindings: active })).evidence).toBe('strong');
  expect(
    judgeClaimEvidence(
      input({
        logs: [noRebate],
        bindings: [...active, { status: 'blocked', bound_at: null, released_at: null }],
      }),
    ).evidence,
  ).toBe('none');
  expect(
    judgeClaimEvidence(
      input({
        logs: [noRebate],
        bindings: active,
        conflicts: [{ occurred_at: at('2027-10-18T00:00:00.000Z'), resolved_at: null }],
      }),
    ).evidence,
  ).toBe('none');
});

it('[AC-B1-10c#30] claim等级取最弱子项', () => {
  expect(weakestEvidence(['strong', 'strong'])).toBe('strong');
  expect(weakestEvidence(['strong', 'weak'])).toBe('weak');
  expect(weakestEvidence(['weak', 'none', 'strong'])).toBe('none');
});
