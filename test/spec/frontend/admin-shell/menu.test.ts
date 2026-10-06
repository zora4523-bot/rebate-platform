// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { admin_permission } from '../../../../packages/contracts-ts/src/index.ts';
import { createAccessControl } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  getAdminMenuGroups,
  selectAdminMenuGroups,
} from '../../../../apps/admin/src/resources/index.ts';
import { CASES, MENU } from './fixtures.ts';

// 待 CT-21a 同步后删除。
const PENDING_CONTRACT_PERMISSIONS = new Set<string>([
  'pay.view',
  'pay.refund',
  'pay.resolve',
  'switch.pay',
]);

it('[AC-F1-06e-MENU#1] 菜单权限 key 仅来自契约枚举或待同步集合，设计稿缺项不得静默删除', () => {
  const known = new Set<string>(admin_permission);
  const allowed = new Set([...known, ...PENDING_CONTRACT_PERMISSIONS]);
  const expectedKeys = MENU.flatMap((row) => (typeof row[3] === 'string' ? [] : [...row[3]]));
  expect([...new Set(expectedKeys)].filter((key) => !allowed.has(key))).toEqual([]);
  const actualKeys = getAdminMenuGroups().flatMap((group) =>
    group.items.flatMap((item) => (item.access.kind === 'any' ? [...item.access.permissions] : [])),
  );
  expect(actualKeys.filter((key) => !allowed.has(key))).toEqual([]);
  const missingFromContract = [...new Set(actualKeys)].filter((key) => !known.has(key));
  expect(missingFromContract.every((key) => PENDING_CONTRACT_PERMISSIONS.has(key))).toBe(true);
});

it('[AC-F1-06e-MENU#2] 菜单目录逐项固定分组、顺序、名称与任一权限点规则', () => {
  const groups = getAdminMenuGroups();
  expect(groups.map((group) => group.label)).toEqual(CASES[0]!.groups);
  expect(
    groups.flatMap((group) =>
      group.items.map((item) => [
        group.label,
        item.id,
        item.label,
        item.access.kind === 'any' ? item.access.permissions : item.access.kind,
      ]),
    ),
  ).toEqual(MENU);
});

for (const sample of CASES) {
  it(`[AC-F1-06e-MENU#3] ${sample.name} 的菜单与非空分组逐项匹配样例`, () => {
    const snapshot = Object.freeze({
      ...sample.snapshot,
      permissions: Object.freeze([...sample.snapshot.permissions]),
    });
    const result = selectAdminMenuGroups(snapshot);
    expect(result.map((group) => group.label)).toEqual(sample.groups);
    expect(result.flatMap((group) => group.items.map((item) => item.id))).toEqual(sample.ids);
    expect(result.every((group) => group.items.length > 0)).toBe(true);
    expect(snapshot).toEqual(sample.snapshot);
  });
}

// One-key probes distinguish OR from AND, prefix matching, group-level grants and accidental
// grants by unrelated permissions. Expected entries come from the task table, never production.
for (const permission of new Set(
  MENU.flatMap((row) => (typeof row[3] === 'string' ? [] : [...row[3]])),
)) {
  it(`[AC-F1-06e-MENU#4] 单独授予 ${permission} 只显示匹配菜单与登录可见菜单`, () => {
    const expected = MENU.filter(
      (row) =>
        row[3] === 'authenticated' ||
        (typeof row[3] !== 'string' && (row[3] as readonly string[]).includes(permission)),
    );
    const result = selectAdminMenuGroups({ isSuper: false, permissions: [permission] });
    expect(result.flatMap((group) => group.items.map((item) => item.id))).toEqual(
      expected.map((row) => row[1]),
    );
    expect(result.map((group) => group.label)).toEqual([...new Set(expected.map((row) => row[0]))]);
  });
}

it('[AC-F1-06e-MENU#5] 普通账号即使拥有全部权限点也不能看到后台账号与权限', () => {
  const result = selectAdminMenuGroups({
    isSuper: false,
    permissions: [...new Set([...admin_permission, ...PENDING_CONTRACT_PERMISSIONS])],
  });
  expect(result.flatMap((group) => group.items.map((item) => item.id))).toEqual(
    MENU.filter((row) => row[3] !== 'super').map((row) => row[1]),
  );
});

it('[AC-F1-06e-MENU#6] 未知 key、相似前缀和菜单名不能授予业务权限', () => {
  const result = selectAdminMenuGroups({
    isSuper: false,
    permissions: [
      'user',
      'user.*',
      'USER.LOOKUP',
      'user.lookup.extra',
      'admins',
      'super',
      'audit.view_all',
      'export',
      'content.poster',
      'order.hold',
    ],
  });
  expect(result.map((group) => group.label)).toEqual(['数据', '系统']);
  expect(result.flatMap((group) => group.items.map((item) => item.id))).toEqual([
    'reports',
    'audit-logs',
  ]);
});

it('[AC-F1-06e-MENU#7] 裁剪不污染后续账号或目录，重复权限不重复菜单', () => {
  const full = getAdminMenuGroups();
  const original = structuredClone(full);
  selectAdminMenuGroups({ isSuper: false, permissions: [] });
  const result = selectAdminMenuGroups({
    isSuper: false,
    permissions: ['user.lookup', 'user.lookup'],
  });
  expect(result.flatMap((group) => group.items.map((item) => item.id))).toEqual([
    'users',
    'reports',
    'audit-logs',
  ]);
  expect(getAdminMenuGroups()).toEqual(original);
  expect(selectAdminMenuGroups({ isSuper: true, permissions: [] })).toEqual(original);
});

it('[AC-F1-06e-ACCESS#1] can 按注入权限精确判定按钮能力，超管全有', () => {
  const query = createAccessControl({ isSuper: false, permissions: ['user.lookup', 'order.view'] });
  const empty = createAccessControl({ isSuper: false, permissions: [] });
  const superAdmin = createAccessControl({ isSuper: true, permissions: [] });
  for (const key of admin_permission) {
    expect(query.can(key), key).toBe(key === 'user.lookup' || key === 'order.view');
    expect(empty.can(key), key).toBe(false);
    expect(superAdmin.can(key), key).toBe(true);
  }
});
