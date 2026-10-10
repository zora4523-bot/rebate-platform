import { admin_permission } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import { isAdminId, lockInForce, visiblePermissions } from './admin-view.ts';
import { maskVerifyPhone } from './step-up-policy.ts';

it('[AC-F1-06m] the verify phone shows the BR-ID-33 mask; anything else shows no character', () => {
  expect(maskVerifyPhone('13812345678')).toBe('138****5678');
  expect(maskVerifyPhone('+8613812345678')).toBe('*'.repeat(14));
  expect(maskVerifyPhone('1381234567')).toBe('*'.repeat(10));
  expect(maskVerifyPhone('１３８１２３４５６７８')).toBe('*'.repeat(11));
  expect(maskVerifyPhone('')).toBe('');
});

it('[AC-F1-06m] a super admin shows no points; others show known points once, in enum order', () => {
  expect(visiblePermissions(true, ['fund.adjust', 'user.list'])).toEqual([]);
  const last = admin_permission[admin_permission.length - 1]!;
  const first = admin_permission[0];
  expect(visiblePermissions(false, [last, 'unknown.point', first, last])).toEqual([first, last]);
  expect(visiblePermissions(false, [])).toEqual([]);
});

it('[AC-F1-06m] a lock is shown only while it is in force by the clock', () => {
  const now = new Date('2026-10-09T02:00:00.000Z');
  const future = new Date('2026-10-09T02:00:00.001Z');
  expect(lockInForce(future, now)).toBe(future);
  expect(lockInForce(new Date(now.getTime()), now)).toBeNull();
  expect(lockInForce(new Date('2026-10-09T01:59:59.999Z'), now)).toBeNull();
  expect(lockInForce(null, now)).toBeNull();
});

it('[AC-F1-06m] only a hyphenated UUID is an admin id', () => {
  expect(isAdminId('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01')).toBe(true);
  expect(isAdminId('FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFF1')).toBe(true);
  for (const bad of [
    'unknown',
    '123',
    '00000000-0000-4000-8000-zzzzzzzzzzzz',
    '',
    ' 0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
  ]) {
    expect(isAdminId(bad)).toBe(false);
  }
});
