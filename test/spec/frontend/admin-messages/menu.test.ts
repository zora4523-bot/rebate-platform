// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  getAdminMenuGroups,
  selectAdminMenuGroups,
} from '../../../../apps/admin/src/resources/index.ts';

it('[AC-F1-06zv-MENU#1] 「消息模板」菜单的可见权限为 content.article、content.fund_terms、notify.channels 任一', () => {
  const item = getAdminMenuGroups()
    .flatMap((group) => group.items)
    .find((candidate) => String(candidate.id) === 'messages');
  expect(item, 'menu messages').toBeDefined();
  expect(item!.label).toBe('消息模板');
  expect(item!.access).toEqual({
    kind: 'any',
    permissions: ['content.article', 'content.fund_terms', 'notify.channels'],
  });
});

it('[AC-F1-06zv-MENU#2] 只持 notify.channels 的账号在「运营」分组下看到「消息模板」', () => {
  const groups = selectAdminMenuGroups({ isSuper: false, permissions: ['notify.channels'] });
  const operations = groups.find((group) => group.label === '运营');
  expect(operations, 'group 运营').toBeDefined();
  expect(operations!.items.map((item) => String(item.id))).toEqual(['messages']);
});
