// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  getAdminMenuGroups,
  selectAdminMenuGroups,
} from '../../../../apps/admin/src/resources/index.ts';

it('[AC-F1-08e-MENU#1] 「对账与差错」菜单的可见权限为 fund.recon、fund.view 任一', () => {
  const item = getAdminMenuGroups()
    .flatMap((group) => group.items)
    .find((candidate) => String(candidate.id) === 'recon');
  expect(item, 'menu recon').toBeDefined();
  expect(item!.label).toBe('对账与差错');
  expect(item!.access).toEqual({ kind: 'any', permissions: ['fund.recon', 'fund.view'] });
});

it('[AC-F1-08e-MENU#2] 只持 fund.view 的账号在「资金」分组下看到「余额流水」与「对账与差错」', () => {
  const groups = selectAdminMenuGroups({ isSuper: false, permissions: ['fund.view'] });
  const funds = groups.find((group) => group.label === '资金');
  expect(funds, 'group 资金').toBeDefined();
  expect(funds!.items.map((item) => String(item.id))).toEqual(['ledger', 'recon']);
});
