import { expect, it } from 'vitest';
import { selectAdminMenuGroups } from '../../resources/index.ts';
import { createAccessControl, type PermissionSnapshot } from './index.ts';
import { createRefineAccessControl, decideAccess } from './refine.ts';

function decide(snapshot: PermissionSnapshot, resource: string | undefined, action: string) {
  const params = resource === undefined ? { action } : { resource, action };
  return decideAccess(createAccessControl(snapshot), selectAdminMenuGroups(snapshot), params).can;
}

const reviewer: PermissionSnapshot = { isSuper: false, permissions: ['withdraw.review'] };

it('navigation actions follow menu visibility', () => {
  expect(decide(reviewer, 'withdrawals', 'list')).toBe(true);
  expect(decide(reviewer, 'withdrawals', 'show')).toBe(true);
  expect(decide(reviewer, 'reports', 'list')).toBe(true);
  expect(decide(reviewer, 'orders', 'list')).toBe(false);
  expect(decide(reviewer, 'admins', 'list')).toBe(false);
  expect(decide(reviewer, undefined, 'list')).toBe(false);
});

it('business actions need their exact permission key, not just a visible menu', () => {
  expect(decide(reviewer, 'withdrawals', 'withdraw.review')).toBe(true);
  expect(decide(reviewer, 'withdrawals', 'payout.execute')).toBe(false);
  expect(decide(reviewer, undefined, 'withdraw.review')).toBe(true);
  expect(decide(reviewer, 'orders', 'withdraw.review')).toBe(false);
  const executor = { isSuper: false, permissions: ['payout.execute'] };
  expect(decide(executor, 'withdrawals', 'payout.execute')).toBe(true);
});

it('unconfigured actions are denied, also for a super admin', () => {
  const superAdmin = { isSuper: true, permissions: [] };
  expect(decide(superAdmin, 'withdrawals', 'payout.execute')).toBe(true);
  for (const action of ['create', 'edit', 'delete', 'clone', 'manage', 'payout.*']) {
    expect(decide(superAdmin, 'withdrawals', action), action).toBe(false);
  }
});

it('everything is denied while permissions load', async () => {
  const provider = createRefineAccessControl(undefined, []);
  const result = await provider.can({ resource: 'reports', action: 'list' });
  expect(result.can).toBe(false);
});
