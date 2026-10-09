import { expect, it } from 'vitest';
import { canTransitionBinding, isBindingStatus } from './binding-status-transitions.ts';

it('[AC-B1-06h-UNIT#1] 绑定状态迁移只认迁移表：BR-ID-17/19/20/21 列出的迁移合法，其余一律不合法', () => {
  const statuses = [
    null,
    'pending_auth',
    'active',
    'invalid',
    'blocked',
    'released',
    'unbound',
    'cooling',
    '',
    undefined,
  ] as const;
  const legal = new Set([
    'null→active',
    'pending_auth→active',
    'pending_auth→blocked',
    'active→invalid',
    'active→blocked',
    'active→released',
    'invalid→active',
    'invalid→blocked',
    'invalid→released',
    'blocked→invalid',
    'blocked→released',
    'released→active',
  ]);
  for (const from of statuses) {
    for (const to of statuses) {
      expect(canTransitionBinding(from, to)).toBe(legal.has(`${String(from)}→${String(to)}`));
    }
  }
});

it('[AC-B1-06h-UNIT#2] blocked 不能直接回 active（恢复返利与解封只回 invalid，BR-ID-20），同状态不算迁移', () => {
  expect(canTransitionBinding('blocked', 'active')).toBe(false);
  expect(canTransitionBinding('active', 'active')).toBe(false);
  expect(canTransitionBinding('released', 'released')).toBe(false);
});

it('[AC-B1-06h-UNIT#3] 状态取值守卫只认落库取值，unbound 是投影不落库', () => {
  expect(isBindingStatus('active')).toBe(true);
  expect(isBindingStatus('pending_auth')).toBe(true);
  expect(isBindingStatus('unbound')).toBe(false);
  expect(isBindingStatus(null)).toBe(false);
});
