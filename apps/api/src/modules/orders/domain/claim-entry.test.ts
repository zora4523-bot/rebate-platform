import { expect, it } from 'vitest';
import type { ClaimEntryBinding, ClaimEntryLog } from '../../linking/index.ts';
import { FixedClock } from '../../platform/index.ts';
import { claimEntryPinned, type ClaimEntryInput } from './claim-entry.ts';

const NOW = '2028-03-01T08:00:00.000Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const scope = { app_id: 'unit-app', user_id: '019c0000-0000-7000-8000-000000000001' };
const other = '019c0000-0000-7000-8000-000000000002';
function ago(ms: number): Date {
  const clock = new FixedClock(NOW);
  clock.advanceMs(-ms);
  return clock.now();
}
function log(patch: Partial<ClaimEntryLog> = {}): ClaimEntryLog {
  return {
    ...scope,
    id: 1n,
    opener_user_id: scope.user_id,
    platform: 'taobao',
    event: 'open',
    result_code: 0,
    pid_scene: 'self',
    no_rebate: false,
    no_rebate_reason: null,
    created_at: ago(HOUR),
    ...patch,
  };
}
function binding(patch: Partial<ClaimEntryBinding> = {}): ClaimEntryBinding {
  return {
    ...scope,
    platform: 'taobao',
    status: 'active',
    bound_at: ago(HOUR),
    relation_id: 'unit-relation',
    ...patch,
  };
}
function run(patch: Partial<ClaimEntryInput> = {}): boolean {
  return claimEntryPinned({
    ...scope,
    now: ago(0),
    logs: [log()],
    bindings: [],
    latest_order_attr_at: null,
    ...patch,
  });
}

it('[AC-B1-10h#2] 窗口两端闭区间：30 分钟与 72 小时整置顶，之外不置顶', () => {
  expect(run({ logs: [log({ created_at: ago(30 * MINUTE - 1) })] })).toBe(false);
  expect(run({ logs: [log({ created_at: ago(30 * MINUTE) })] })).toBe(true);
  expect(run({ logs: [log({ created_at: ago(72 * HOUR) })] })).toBe(true);
  expect(run({ logs: [log({ created_at: ago(72 * HOUR + 1) })] })).toBe(false);
  expect(run({ logs: [] })).toBe(false);
});

it('[AC-B1-10h#8] 只看最近一次计入的外跳，不回退到更早的记录', () => {
  const logs = [log({ created_at: ago(2 * HOUR) }), log({ id: 2n, created_at: ago(5 * MINUTE) })];
  expect(run({ logs })).toBe(false);
});

it('[AC-B1-10h#24] 发起人按 opener 优先、无 opener 回退 user_id；他 App、未来、分享不计入', () => {
  expect(run({ logs: [log({ opener_user_id: other })] })).toBe(false);
  expect(run({ logs: [log({ opener_user_id: null, event: 'convert' })] })).toBe(true);
  expect(run({ logs: [log({ opener_user_id: null, user_id: other })] })).toBe(false);
  expect(run({ logs: [log({ user_id: other })] })).toBe(true);
  expect(run({ logs: [log({ app_id: 'other-app' })] })).toBe(false);
  expect(run({ logs: [log({ pid_scene: 'share' })] })).toBe(false);
  expect(run({ logs: [log({ pid_scene: null })] })).toBe(true);
  expect(run({ logs: [log({ event: 'precompute' })] })).toBe(false);
  expect(run({ logs: [log({ result_code: 30151 })] })).toBe(false);
  // A future record is ignored, so the older one is the latest that counts.
  expect(run({ logs: [log(), log({ id: 2n, created_at: ago(-1) })] })).toBe(true);
});

it('[AC-B1-10h#40] 无返利只在授权类原因且记录之后已授权时计入', () => {
  const noRebate = log({ no_rebate: true, no_rebate_reason: 'auth_declined' });
  expect(run({ logs: [noRebate], bindings: [binding()] })).toBe(true);
  expect(run({ logs: [noRebate], bindings: [binding({ bound_at: ago(HOUR + 1) })] })).toBe(false);
  expect(run({ logs: [noRebate], bindings: [binding({ relation_id: 'r'.repeat(33) })] })).toBe(
    false,
  );
  expect(run({ logs: [noRebate], bindings: [binding({ status: 'invalid' })] })).toBe(false);
  expect(run({ logs: [noRebate], bindings: [binding({ user_id: other })] })).toBe(false);
  const pdd = log({ platform: 'pdd', no_rebate: true, no_rebate_reason: 'auth_failed' });
  expect(run({ logs: [pdd], bindings: [binding({ platform: 'pdd', relation_id: null })] })).toBe(
    true,
  );
  const jd = log({ platform: 'jd', no_rebate: true, no_rebate_reason: 'auth_failed' });
  expect(run({ logs: [jd], bindings: [binding({ platform: 'jd' })] })).toBe(false);
  const blocked = log({ id: 2n, created_at: ago(10 * MINUTE), no_rebate: true });
  expect(run({ logs: [log({ created_at: ago(2 * HOUR) }), blocked], bindings: [binding()] })).toBe(
    true,
  );
});

it('[AC-B1-10h#11] 新订单 attr_at 不早于外跳即取消置顶，早 1 毫秒不影响', () => {
  expect(run({ latest_order_attr_at: ago(HOUR) })).toBe(false);
  expect(run({ latest_order_attr_at: ago(HOUR - 1) })).toBe(false);
  expect(run({ latest_order_attr_at: ago(HOUR + 1) })).toBe(true);
});
