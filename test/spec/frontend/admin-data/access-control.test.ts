import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { admin_permission, type Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createAccessControl,
  isKnownPermission,
  permissionsFromMe,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createRefineAccessControl } from '../../../../apps/admin/src/providers/access-control/refine.ts';
import { selectAdminMenuGroups } from '../../../../apps/admin/src/resources/index.ts';
import { EMPTY_ME, FINANCE_ME } from './fixtures.ts';

it('[AC-F1-06g-ACCESS#1] finance 示例转换为权限快照并保留默认档位与操作例外', () => {
  const input = structuredClone(FINANCE_ME.data);
  const snapshot = permissionsFromMe(input);
  expect(snapshot.isSuper).toBe(false);
  expect(snapshot.permissions).toEqual([
    'fund.view',
    'fund.adjust',
    'fund.recon',
    'content.app_version',
    'withdraw.review',
  ]);
  expect(snapshot.stepUp).toEqual({
    'fund.view': { tier: null, operations: {} },
    'fund.adjust': { tier: 'sms', operations: {} },
    'fund.recon': { tier: null, operations: { 'fund.recon.balance_recalc': 'sms' } },
    'content.app_version': {
      tier: null,
      operations: { 'content.app_version.raise_min_supported_version': 'totp' },
    },
    'withdraw.review': { tier: 'totp', operations: {} },
  });
  expect(input).toEqual(FINANCE_ME.data);
});

it('[AC-F1-06g-ACCESS#2] noPermission 示例保持空权限，超管标志不会从账号名或手机号推断', () => {
  const snapshot = permissionsFromMe(EMPTY_ME.data);
  expect(snapshot).toMatchObject({ isSuper: false, permissions: [], stepUp: {} });
  const access = createAccessControl(snapshot);
  for (const key of admin_permission) {
    expect(access.can(key), key).toBe(false);
    expect(access.stepUpTier(key), key).toBeNull();
  }
});

it('[AC-F1-06g-ACCESS#3] 超管即使权限列表为空仍拥有契约中全部权限点', () => {
  // Super flag boundary on the contract example (server normally sends every point).
  const snapshot = permissionsFromMe({ ...EMPTY_ME.data, is_super: true });
  expect(snapshot.isSuper).toBe(true);
  const access = createAccessControl(snapshot);
  expect(access.isSuper).toBe(true);
  for (const key of admin_permission) expect(access.can(key), key).toBe(true);
});

it('[AC-F1-06g-ACCESS#4] 普通账号逐项精确匹配，不把同分组其他权限一并授予', () => {
  const access = createAccessControl(permissionsFromMe(FINANCE_ME.data));
  const granted = new Set(FINANCE_ME.data.permissions.map((item) => item.key));
  expect(access.isSuper).toBe(false);
  for (const key of admin_permission) expect(access.can(key), key).toBe(granted.has(key));
});

for (const isSuper of [false, true]) {
  it(`[AC-F1-06g-ACCESS#5] isSuper=${isSuper} 时未知 key、通配符、CASL manage 都无权且无档位`, () => {
    const unknown = [
      'fund',
      'fund.*',
      'fund.adjust.extra',
      'FUND.ADJUST',
      'manage',
      'all',
      'future.permission',
      '__proto__',
      'constructor',
    ];
    const me: Schema<'AdminMe'> = {
      ...FINANCE_ME.data,
      is_super: isSuper,
      permissions: [
        ...FINANCE_ME.data.permissions,
        ...unknown.map((key) => ({ key, step_up_tier: 'sms' as const, step_up_operations: [] })),
      ],
    };
    const snapshot = permissionsFromMe(me);
    const access = createAccessControl(snapshot);
    for (const key of unknown) {
      expect(snapshot.permissions, key).not.toContain(key);
      expect(Object.hasOwn(snapshot.stepUp ?? {}, key), key).toBe(false);
      expect(isKnownPermission(key), key).toBe(false);
      expect(access.can(key), key).toBe(false);
      expect(access.stepUpTier(key), key).toBeNull();
      expect(access.stepUpTier(key, 'fund.recon.balance_recalc'), key).toBeNull();
    }
  });
}

for (const [permission, operation, expected] of [
  ['fund.view', undefined, null],
  ['fund.adjust', undefined, 'sms'],
  ['withdraw.review', undefined, 'totp'],
  ['fund.recon', undefined, null],
  ['fund.recon', 'fund.recon.balance_recalc', 'sms'],
  ['fund.recon', 'fund.recon.balance_recalc.extra', null],
  ['fund.recon', 'content.app_version.raise_min_supported_version', null],
  ['content.app_version', undefined, null],
  ['content.app_version', 'content.app_version.raise_min_supported_version', 'totp'],
  ['content.app_version', 'content.app_version.raise_min_supported_version.extra', null],
  ['content.app_version', 'fund.recon.balance_recalc', null],
] as const) {
  it(`[AC-F1-06g-ACCESS#6] ${permission} / ${operation ?? '默认'} 的二次验证档位为 ${expected}`, () => {
    const access = createAccessControl(permissionsFromMe(FINANCE_ME.data));
    expect(access.stepUpTier(permission, operation)).toBe(expected);
    expect(access.can(permission)).toBe(true);
  });
}

it('[AC-F1-06g-ACCESS#7] 操作例外覆盖非空默认档位，其他操作回落默认档位', () => {
  // Contract-shaped boundary distinguishes lookup of server annotations from hardcoded keys.
  const me: Schema<'AdminMe'> = structuredClone(FINANCE_ME.data);
  const grant = me.permissions.find((item) => item.key === 'fund.recon')!;
  grant.step_up_tier = 'totp';
  const access = createAccessControl(permissionsFromMe(me));
  expect(access.stepUpTier('fund.recon')).toBe('totp');
  expect(access.stepUpTier('fund.recon', 'fund.recon.balance_recalc')).toBe('sms');
  expect(access.stepUpTier('fund.recon', 'fund.recon.other_operation')).toBe('totp');
});

it('[AC-F1-06g-ACCESS#8] 超管权限也保留 step-up 档位，不因全权限而跳过二次验证', () => {
  const access = createAccessControl(permissionsFromMe({ ...FINANCE_ME.data, is_super: true }));
  expect(access.can('fund.adjust')).toBe(true);
  expect(access.stepUpTier('fund.adjust')).toBe('sms');
  expect(access.stepUpTier('withdraw.review')).toBe('totp');
  expect(
    access.stepUpTier('content.app_version', 'content.app_version.raise_min_supported_version'),
  ).toBe('totp');
});

it('[AC-F1-06g-ACCESS#9] 未授权但有残留档位标注不授予权限，也不返回验证档位', () => {
  const snapshot = permissionsFromMe(FINANCE_ME.data);
  const access = createAccessControl({ ...snapshot, permissions: [] });
  expect(access.can('fund.adjust')).toBe(false);
  expect(access.stepUpTier('fund.adjust')).toBeNull();
  expect(access.stepUpTier('fund.recon', 'fund.recon.balance_recalc')).toBeNull();
});

it('[AC-F1-06g-ACCESS#10] 旧注入快照仍可用；权限不会串到另一个账号', () => {
  const first = createAccessControl({ isSuper: false, permissions: ['fund.view'] });
  const second = createAccessControl({ isSuper: false, permissions: ['fund.adjust'] });
  expect(first.can('fund.view')).toBe(true);
  expect(first.can('fund.adjust')).toBe(false);
  expect(first.stepUpTier('fund.view')).toBeNull();
  expect(second.can('fund.view')).toBe(false);
  expect(second.can('fund.adjust')).toBe(true);
  expect(first.can('fund.view')).toBe(true);
});

it('[AC-F1-06g-ACCESS#11] CT-21a 权限只认契约，源码不再保留 PENDING 常量或类型', () => {
  const source = readFileSync(
    new URL('../../../../apps/admin/src/providers/access-control/index.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toContain('PENDING_CONTRACT_PERMISSIONS');
  expect(source).not.toContain('PendingContractPermission');
  expect(source).toMatch(/type\s+KnownPermission\s*=\s*AdminPermission\s*;/);
  const access = createAccessControl({
    isSuper: false,
    permissions: ['pay.view', 'pay.refund', 'pay.resolve', 'switch.pay'],
  });
  for (const key of ['pay.view', 'pay.refund', 'pay.resolve', 'switch.pay']) {
    expect(admin_permission).toContain(key);
    expect(isKnownPermission(key)).toBe(true);
    expect(access.can(key)).toBe(true);
  }
});

it('[AC-F1-06g-ACCESS#12] Refine 菜单隐藏与按钮动作判定保持精确权限语义', async () => {
  const snapshot = permissionsFromMe(FINANCE_ME.data);
  const groups = selectAdminMenuGroups(snapshot);
  const provider = createRefineAccessControl(createAccessControl(snapshot), groups);
  const visible = groups.flatMap((group) => group.items.map((item) => item.id));
  expect(visible).toContain('withdrawals');
  expect(visible).not.toContain('admins');
  expect(visible).not.toContain('orders');
  for (const [resource, action, expected] of [
    ['withdrawals', 'list', true],
    ['withdrawals', 'show', true],
    ['withdrawals', 'withdraw.review', true],
    ['withdrawals', 'payout.execute', false],
    ['orders', 'withdraw.review', false],
    ['admins', 'list', false],
    ['withdrawals', 'manage', false],
    ['withdrawals', 'edit', false],
  ] as const)
    expect((await provider.can({ resource, action })).can, `${resource}/${action}`).toBe(expected);
});
