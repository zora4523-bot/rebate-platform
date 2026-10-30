// B2-04la 实现者单元测试：R3 / R3b 的纯判定（不连库）。
import { expect, it } from 'vitest';
import { decideAttribution } from './decide.ts';

const open = { locked: false, user_id: null } as const;

it('[AC-B2-04la#u1] UNATTRIBUTED 未锁定：两个事件都走 R3 到 ESTIMATED', () => {
  for (const event of ['CLAIM_APPROVED', 'ADMIN_REASSIGN'] as const) {
    expect(decideAttribution({ ...open, rebate_status: 'UNATTRIBUTED' }, event)).toEqual({
      kind: 'R3',
      step: { from: 'UNATTRIBUTED', event, to: 'ESTIMATED' },
    });
  }
});

it('[AC-B2-04la#u2] VOID 且 user_id 为空：只有 ADMIN_REASSIGN 走 R3b，CLAIM_APPROVED 表外', () => {
  expect(decideAttribution({ ...open, rebate_status: 'VOID' }, 'ADMIN_REASSIGN')).toEqual({
    kind: 'R3b',
    step: { from: 'VOID', event: 'ADMIN_REASSIGN', to: 'VOID' },
  });
  expect(decideAttribution({ ...open, rebate_status: 'VOID' }, 'CLAIM_APPROVED').kind).toBe(
    'illegal',
  );
});

it('[AC-B2-04la#u3] 守卫与 R14：已锁定、VOID 已有 user_id、已归属状态、未知状态一律表外', () => {
  const cases = [
    [{ ...open, rebate_status: 'UNATTRIBUTED', locked: true }, 'CLAIM_APPROVED'],
    [{ ...open, rebate_status: 'VOID', locked: true }, 'ADMIN_REASSIGN'],
    [{ ...open, rebate_status: 'VOID', user_id: 'u1' }, 'ADMIN_REASSIGN'],
    [{ ...open, rebate_status: 'ESTIMATED' }, 'ADMIN_REASSIGN'],
    [{ ...open, rebate_status: 'CREDITED' }, 'ADMIN_REASSIGN'],
    [{ ...open, rebate_status: 'WAITING' }, 'CLAIM_APPROVED'],
    [{ ...open, rebate_status: 'BOGUS' }, 'ADMIN_REASSIGN'],
  ] as const;
  for (const [before, event] of cases) {
    expect(decideAttribution(before, event).kind, JSON.stringify(before)).toBe('illegal');
  }
});
