// @vitest-environment jsdom
import { within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SUPER, UID } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  TAB_NAMES,
  finish,
  firstShown,
  mount,
  openTab,
  openUser,
  rowShown,
  rowWith,
  settled,
  tabRow,
} from './helpers.ts';

afterEach(finish);

/** Names of write actions that must not be inside a read-only tab. */
const WRITE =
  /通过|驳回|打款|同步|导出|暂停|恢复|指派|修改|删除|冻结|封禁|调整|撤回|重置|停用|作废|新建|添加|提交/;

it(
  '[AC-F1-07jb-READONLY#1] 超管依次打开订单、找回、提现页签：页签里没有写操作入口，全程不发任何写请求，只有详情与这三个列表的 GET（带 user_id）',
  async () => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    for (const name of TAB_NAMES) {
      await openTab(name);
      await rowShown(firstShown(name));
      await settled();
      const row = rowWith(firstShown(name));
      const panel =
        row.closest<HTMLElement>('[role="tabpanel"]') ??
        row.closest<HTMLElement>('.ant-card') ??
        row.closest<HTMLElement>('.ant-table-wrapper');
      expect(panel, `content of 「${name}」`).not.toBeNull();
      const writes = [
        ...within(panel!).queryAllByRole('button', { name: (text) => WRITE.test(text) }),
        ...within(panel!).queryAllByRole('link', { name: (text) => WRITE.test(text) }),
      ];
      expect(
        writes.map((node) => node.textContent),
        `write actions in 「${name}」`,
      ).toEqual([]);
    }
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
  },
  FLOW_TIMEOUT,
);
