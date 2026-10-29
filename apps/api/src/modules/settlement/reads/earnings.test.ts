import { expect, it } from 'vitest';
import { userShareFen } from './earnings.ts';
import { splitPendingShares } from './pending-earnings-rules.ts';

const ME = '00000000-0000-4000-8000-000000000001';
const FRIEND = '00000000-0000-4000-8000-000000000002';

it('[AC-B2-13a-UNIT#7] 只合计本人在给定角色上的份额：自购栏不含同单他人的直推份额', () => {
  const shares = splitPendingShares(
    850n,
    [
      { userId: ME, role: 'self', ratioBp: 5000, initialStatus: 'active' },
      { userId: FRIEND, role: 'direct', ratioBp: 1000, initialStatus: 'active' },
    ],
    [],
  );
  expect(userShareFen(shares, ME, ['self'])).toBe(425n);
  expect(userShareFen(shares, ME, ['share'])).toBe(0n);
  expect(userShareFen(shares, FRIEND, ['direct', 'indirect'])).toBe(85n);
});

it('[AC-B2-13a-UNIT#8] 邀请份额合计直推与间推；被剥夺的份额为 0', () => {
  const shares = splitPendingShares(
    850n,
    [
      { userId: FRIEND, role: 'self', ratioBp: 5000, initialStatus: 'active' },
      { userId: ME, role: 'direct', ratioBp: 100, initialStatus: 'active' },
      { userId: ME, role: 'indirect', ratioBp: 300, initialStatus: 'active' },
    ],
    [],
  );
  // 8.5 → 8，25.5 → 25：逐角色向下取整后再合计。
  expect(userShareFen(shares, ME, ['direct', 'indirect'])).toBe(33n);
  const forfeited = splitPendingShares(
    850n,
    [{ userId: ME, role: 'direct', ratioBp: 1000, initialStatus: 'forfeited' }],
    [],
  );
  expect(userShareFen(forfeited, ME, ['direct', 'indirect'])).toBe(0n);
});
