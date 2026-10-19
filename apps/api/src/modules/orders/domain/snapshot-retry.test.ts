// B1-08t 源码旁单元测试（实现者写）：补偿重试的纯判定。规则测试在 test/spec/orders/snapshot-retry/**。
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  isSnapshotRetryDue,
  isSnapshotRetryExhausted,
  isSnapshotRetryReason,
  planSnapshotRetry,
  resolveRetryPaidAt,
  type PlanSnapshotRetryInput,
} from './snapshot-retry.ts';

const clock = new FixedClock('2026-10-18T12:00:00.000Z');
const at = (iso: string) => new FixedClock(iso).now();

function input(patch: Partial<PlanSnapshotRetryInput> = {}): PlanSnapshotRetryInput {
  return {
    order: {
      app_id: 'app-a',
      order_id: 'order-1',
      platform: 'jd',
      buy_type: 'share',
      activity_type: null,
      est_commission_fen: 789n,
      settle_commission_fen: null,
      subsidy_commission_fen: null,
    },
    ownerUserId: 'user-1',
    paid: { paidAt: at('2026-10-17T10:00:00.000Z'), paidAtSource: 'platform', writeSource: false },
    serviceFeeFen: 'unknown',
    pidScene: 'unknown',
    ...patch,
  };
}

it('[AC-B1-08t#U1] 重试对象只认三种快照类原因；到期与 24 小时边界含等号', () => {
  expect(
    ['RULE_VERSION_PLATFORM_MISSING', 'AMOUNT_PARSE_FAILED', 'SERVICE_FEE_RATE_MISSING'].every(
      isSnapshotRetryReason,
    ),
  ).toBe(true);
  expect(isSnapshotRetryReason('TLJ_FACE_VALUE_UNMATCHED')).toBe(false);
  expect(isSnapshotRetryReason('NO_RECEIVED_AT')).toBe(false);
  const now = clock.now();
  expect(isSnapshotRetryDue(at('2026-10-18T11:00:00.000Z'), now)).toBe(true);
  expect(isSnapshotRetryDue(at('2026-10-18T11:00:00.001Z'), now)).toBe(false);
  expect(isSnapshotRetryExhausted(at('2026-10-17T12:00:00.000Z'), now)).toBe(true);
  expect(isSnapshotRetryExhausted(at('2026-10-17T12:00:00.001Z'), now)).toBe(false);
});

it('[AC-B1-08t#U2] 佣金基数结算优先、两者都空 pending；拼多多服务费未知 skip、为空 pending、已知则扣除', () => {
  expect(planSnapshotRetry(input())).toMatchObject({ kind: 'call', input: { nBaseFen: 789n } });
  const settled = input({
    order: { ...input().order, settle_commission_fen: 0n },
  });
  expect(planSnapshotRetry(settled)).toMatchObject({ kind: 'call', input: { nBaseFen: 0n } });
  const empty = input({ order: { ...input().order, est_commission_fen: null } });
  expect(planSnapshotRetry(empty)).toEqual({ kind: 'pending', reason: 'AMOUNT_PARSE_FAILED' });
  const pdd = { ...input().order, platform: 'pdd' as const };
  expect(planSnapshotRetry(input({ order: pdd }))).toEqual({
    kind: 'skip',
    reason: 'service_fee_unknown',
  });
  expect(planSnapshotRetry(input({ order: pdd, serviceFeeFen: null }))).toEqual({
    kind: 'pending',
    reason: 'SERVICE_FEE_RATE_MISSING',
  });
  expect(planSnapshotRetry(input({ order: pdd, serviceFeeFen: 31n }))).toMatchObject({
    kind: 'call',
    input: { nBaseFen: 758n },
  });
});

it('[AC-B1-08t#U3] paidAt 按库内来源恢复；platform_modified 与缺值 skip；淘宝场景未知 skip', () => {
  const now = clock.now();
  const paidAt = at('2026-10-17T10:00:00.000Z');
  const first = at('2026-10-17T09:00:00.000Z');
  const base = { paidAt, depositPaidAt: null, firstPaidAt: first, now };
  expect(resolveRetryPaidAt({ ...base, paidAtSource: 'platform' })).toEqual({
    paidAt,
    paidAtSource: 'platform',
    writeSource: false,
  });
  expect(resolveRetryPaidAt({ ...base, paidAtSource: 'observed' })).toEqual({
    paidAt: first,
    paidAtSource: 'observed',
    writeSource: false,
  });
  expect(resolveRetryPaidAt({ ...base, paidAtSource: 'platform_modified' })).toBeNull();
  expect(resolveRetryPaidAt({ ...base, paidAtSource: 'observed', firstPaidAt: null })).toBeNull();
  expect(
    resolveRetryPaidAt({ ...base, paidAtSource: null, depositPaidAt: paidAt, firstPaidAt: null }),
  ).toEqual({ paidAt: now, paidAtSource: 'observed', writeSource: true });
  expect(planSnapshotRetry(input({ paid: null }))).toEqual({
    kind: 'skip',
    reason: 'paid_at_unknown',
  });
  const taobao = { ...input().order, platform: 'taobao' as const };
  expect(planSnapshotRetry(input({ order: taobao }))).toEqual({
    kind: 'skip',
    reason: 'pid_scene_unknown',
  });
  expect(planSnapshotRetry(input({ order: taobao, pidScene: 'taolijin' }))).toMatchObject({
    kind: 'call',
    input: { rebateMode: 'none', tljRedpacketFen: null, tljDeductFen: 0n },
  });
  expect(planSnapshotRetry(input({ pidScene: null }))).toMatchObject({
    kind: 'call',
    input: {
      rebateMode: null,
      tljRedpacketFen: 0n,
      subsidyCommissionFen: 0n,
      ownerUserId: 'user-1',
    },
  });
});
