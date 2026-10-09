import { readFile } from 'node:fs/promises';
import { enums } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import {
  permissionsGenFile,
  permissionsSource,
  permissionsSpecFile,
} from '../scripts/generate-permissions.ts';
import {
  getAdminPermissionCatalog,
  grantedPermissions,
  requiredStepUpTier,
} from './permission-catalog.ts';

it('[AC-F1-06l#2] the generated snapshot matches specs/permissions.yaml', async () => {
  expect(await readFile(permissionsGenFile, 'utf8')).toBe(
    await permissionsSource(permissionsSpecFile),
  );
});

it('[AC-F1-06l#1] the catalog keys are the admin_permission enum, in enum order', () => {
  expect(getAdminPermissionCatalog().map((entry) => entry.key)).toEqual([
    ...enums.admin_permission,
  ]);
});

it('[AC-F1-06l#22] an operation listed under a point takes its own tier, others the point tier', () => {
  expect(requiredStepUpTier('fund.adjust')).toBe('sms');
  expect(requiredStepUpTier('withdraw.review')).toBe('totp');
  expect(requiredStepUpTier('fund.view')).toBeNull();
  expect(requiredStepUpTier('fund.recon')).toBeNull();
  expect(requiredStepUpTier('fund.recon', 'fund.recon.balance_recalc')).toBe('sms');
  expect(requiredStepUpTier('fund.recon', 'fund.recon.other')).toBeNull();
  expect(
    requiredStepUpTier('content.app_version', 'content.app_version.raise_min_supported_version'),
  ).toBe('totp');
  // An operation key of another point never borrows that point's tier.
  expect(requiredStepUpTier('fund.view', 'fund.recon.balance_recalc')).toBeNull();
  expect(() => requiredStepUpTier('retired.unknown')).toThrow();
});

it('[AC-F1-06l#3] [AC-F1-06l#4] grants: every point for a super admin, ticked known points otherwise', () => {
  expect(grantedPermissions(true, [])).toEqual(getAdminPermissionCatalog());
  expect(
    grantedPermissions(false, ['fund.recon', 'retired.unknown', 'user.list']).map((p) => p.key),
  ).toEqual(['user.list', 'fund.recon']);
  expect(grantedPermissions(false, [])).toEqual([]);
});
