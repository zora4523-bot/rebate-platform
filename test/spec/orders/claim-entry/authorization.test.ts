import { expect, it } from 'vitest';
import type { ClaimEntryBinding } from '../../../../apps/api/src/modules/linking/index.ts';
import { ago, HOUR, MINUTE, binding, log, otherUser, pinned } from './kit.ts';

it.each([
  [40, 'taobao', 'auth_declined'],
  [41, 'taobao', 'auth_failed'],
  [42, 'pdd', 'auth_declined'],
  [43, 'pdd', 'auth_failed'],
])('[AC-B1-10h#%s] AC-S1-25② %s的%s无返利外跳此后授权可计入', async (_n, platform, reason) => {
  const logs = [
    log({ platform: String(platform), no_rebate: true, no_rebate_reason: String(reason) }),
  ];
  for (const age of [HOUR, HOUR - 1]) {
    const bindings = [
      binding({
        platform: String(platform),
        bound_at: ago(age),
        relation_id: platform === 'pdd' ? null : 'r'.repeat(32),
      }),
    ];
    expect(await pinned({ logs, bindings })).toBe(true);
  }
});

const invalid: [number, string, Partial<ClaimEntryBinding> | null][] = [
  [44, '未授权', null],
  [45, '授权早1毫秒', { bound_at: ago(HOUR + 1) }],
  [46, '授权时间为空', { bound_at: null }],
  [47, 'invalid', { status: 'invalid' }],
  [48, 'blocked', { status: 'blocked' }],
  [49, 'released', { status: 'released' }],
  [50, 'pending_auth', { status: 'pending_auth' }],
  [51, 'unbound', { status: 'unbound' }],
  [52, '淘宝relation_id为空字符串', { relation_id: '' }],
  [53, '淘宝relation_id为null', { relation_id: null }],
  [54, '淘宝relation_id过长', { relation_id: 'r'.repeat(33) }],
  [55, '他平台绑定', { platform: 'pdd' }],
  [56, '他人绑定', { user_id: otherUser }],
  [57, '他App绑定', { app_id: 'foreign-app' }],
];
it.each(invalid)('[AC-B1-10h#%s] AC-S1-25② %s不满足此后已授权', async (_n, _label, patch) => {
  const bindings = patch === null ? [] : [binding(patch)];
  const noRebate = log({ no_rebate: true, no_rebate_reason: 'auth_failed' });
  expect(await pinned({ logs: [noRebate], bindings })).toBe(false);
  expect(
    await pinned({ logs: [noRebate, log({ id: 2n, created_at: ago(2 * HOUR) })], bindings }),
  ).toBe(true);
});

it.each([
  [58, 'relation_conflict'],
  [59, 'binding_blocked'],
  [60, null],
  [61, 'unknown'],
] as const)('[AC-B1-10h#%s] AC-S1-25② 原因%s即使已授权也永不计入', async (_n, reason) => {
  const ignored = log({ no_rebate: true, no_rebate_reason: reason });
  const bindings = [binding()];
  expect(await pinned({ logs: [ignored], bindings })).toBe(false);
  expect(await pinned({ logs: [log({ created_at: ago(2 * HOUR) }), ignored], bindings })).toBe(
    true,
  );
});

it('[AC-B1-10h#62] AC-S1-25② 其他平台无返利授权不算；普通返利不看reason', async () => {
  for (const platform of ['jd', 'meituan', 'vip', 'douyin']) {
    expect(
      await pinned({
        logs: [log({ platform, no_rebate: true, no_rebate_reason: 'auth_failed' })],
        bindings: [binding({ platform })],
      }),
    ).toBe(false);
  }
  expect(await pinned({ logs: [log({ no_rebate_reason: 'binding_blocked' })] })).toBe(true);
});

it('[AC-B1-10h#63] AC-S1-25② 已授权的10分钟前无返利外跳成为最新，不回退2小时前', async () => {
  const recent = log({
    id: 2n,
    created_at: ago(10 * MINUTE),
    no_rebate: true,
    no_rebate_reason: 'auth_declined',
  });
  const logs = [log({ created_at: ago(2 * HOUR) }), recent];
  expect(await pinned({ logs, bindings: [] })).toBe(true);
  expect(await pinned({ logs, bindings: [binding({ bound_at: recent.created_at })] })).toBe(false);
});
