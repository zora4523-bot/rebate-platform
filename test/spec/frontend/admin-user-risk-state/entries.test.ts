// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  DETAIL,
  USERS,
  createServer,
  userDetail,
  userIn,
  type RiskAction,
  type RiskState,
  type Server,
} from './risk-fixtures.ts';
import {
  ANY_ENTRY,
  BAN_ONLY,
  ENTRY,
  FLOW_TIMEOUT,
  FREEZE_ONLY,
  NO_RISK,
  SUPER,
  actions,
  confirmations,
  expectEntries,
  header,
  headerShows,
  headerState,
  isDisabled,
  main,
  nameOf,
  openLayers,
  openUser,
  pressDisabled,
  settled,
  squash,
  stepUpDialogs,
  unmountAll,
  usable,
} from './risk-helpers.ts';

/** Shows a user in `state` to `snapshot` and checks the title row's entries; nothing is written. */
async function expectFor(
  state: RiskState | 'none',
  snapshot: PermissionSnapshot,
  wanted: readonly RiskAction[],
  optional: readonly RiskAction[] = [],
): Promise<Server> {
  const server = createServer(state === 'none' ? userDetail() : userIn(state));
  await openUser(server, snapshot);
  await headerShows(state === 'none' ? 'normal' : state);
  await expectEntries(wanted, optional);
  await pressDisabled();
  await settled(server);
  expect(confirmations(), 'a disabled entry opens nothing').toEqual([]);
  expect(stepUpDialogs()).toEqual([]);
  expect(server.nonReads(), 'nothing is written').toEqual([]);
  return server;
}

it(
  '[AC-F1-07jd-ENTRY#1] 超管看正常用户（无风控行或有风控行）：标题行有【冻结】【封禁】，没有【解冻】【解封】',
  async () => {
    await expectFor('none', SUPER, ['freeze', 'ban']);
    unmountAll();
    await expectFor('normal', SUPER, ['freeze', 'ban']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ENTRY#2] 超管看已冻结用户：标题行有【解冻】【封禁】（【冻结】改期限可有可无），没有【解封】',
  async () => {
    await expectFor('frozen', SUPER, ['unfreeze', 'ban'], ['freeze']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ENTRY#3] 超管看已封禁用户：标题行只有【解封】，不出现【冻结】【解冻】【封禁】',
  async () => {
    await expectFor('banned', SUPER, ['unban']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ENTRY#4] 申诉中的用户：四个按钮都不可用（不出现，或置灰并说明在申诉中），点置灰的不发请求',
  async () => {
    // An entry to compare with: the same account on a normal user has 【冻结】【封禁】.
    await expectFor('normal', SUPER, ['freeze', 'ban']);
    unmountAll();
    const server = createServer(userIn('appealing'));
    await openUser(server, SUPER);
    await headerShows('appealing');
    await settled(server);
    expect(usable(main(), ANY_ENTRY).map(nameOf), 'no usable risk entry').toEqual([]);
    const greyed = actions(main(), ANY_ENTRY);
    if (greyed.length > 0) {
      for (const node of greyed) expect(isDisabled(node), `${nameOf(node)} is greyed`).toBe(true);
      // Says why beyond the 申诉中 tag: a note in the title row, a described-by text or a title.
      const notes = [headerState().replace(/申诉中/g, '')];
      for (const node of greyed) {
        notes.push(squash(node.getAttribute('title')));
        const holder = node.closest<HTMLElement>('[title]');
        if (holder !== null) notes.push(squash(holder.getAttribute('title')));
        const described = (node.getAttribute('aria-describedby') ?? '').split(/\s+/);
        for (const id of described.filter(Boolean))
          notes.push(squash(document.getElementById(id)?.textContent));
      }
      expect(notes.join(' '), 'the greyed entries say the appeal comes first').toMatch(
        /申诉.{0,20}(?:不能|无法|不可|不允许|暂不|处理|结束|办结|完成|之后|后再|页)|(?:不能|无法|不可|不允许|暂不).{0,20}申诉/,
      );
    }
    await pressDisabled();
    await settled(server);
    expect(openLayers(), 'nothing opens').toEqual([]);
    expect(server.nonReads(), 'nothing is written').toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ENTRY#5] 只持 risk.freeze：正常有【冻结】、已冻结有【解冻】、已封禁什么都没有，且从不出现【封禁】【解封】',
  async () => {
    await expectFor('none', FREEZE_ONLY, ['freeze']);
    unmountAll();
    await expectFor('frozen', FREEZE_ONLY, ['unfreeze'], ['freeze']);
    unmountAll();
    await expectFor('banned', FREEZE_ONLY, []);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ENTRY#6] 只持 risk.ban：正常与已冻结有【封禁】、已封禁有【解封】，且从不出现【冻结】【解冻】',
  async () => {
    await expectFor('normal', BAN_ONLY, ['ban']);
    unmountAll();
    await expectFor('frozen', BAN_ONLY, ['ban']);
    unmountAll();
    await expectFor('banned', BAN_ONLY, ['unban']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ENTRY#7] 不持任何 risk.* 的账号（有 user.lookup、联盟授权等其他权限）：正常、已冻结、已封禁用户都看不到四个按钮中的任何一个，置灰的也没有',
  async () => {
    // The super admin does see them (so the check below is not vacuous).
    await expectFor('frozen', SUPER, ['unfreeze', 'ban'], ['freeze']);
    unmountAll();
    for (const state of ['normal', 'frozen', 'banned'] as const) {
      const server = createServer(userIn(state));
      await openUser(server, NO_RISK);
      await headerShows(state);
      await settled(server);
      for (const action of ['freeze', 'unfreeze', 'ban', 'unban'] as const)
        expect(
          actions(main(), ENTRY[action]).map(nameOf),
          `${state}: no ${action} for an account without risk.*`,
        ).toEqual([]);
      expect(actions(document.body, ANY_ENTRY).map(nameOf)).toEqual([]);
      expect(server.nonReads()).toEqual([]);
      unmountAll();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ENTRY#8] 打开详情只读：按钮在标题行，不弹对话框或动态码，对话框标题与正文都不渲染，只发列表与本用户详情的 GET',
  async () => {
    const server = createServer(userIn('frozen'));
    await openUser(server, SUPER);
    await expectEntries(['unfreeze', 'ban'], ['freeze']);
    expect(actions(header(), ANY_ENTRY).length, 'the entries are in the title row').toBeGreaterThan(
      0,
    );
    await settled(server);
    expect(openLayers(), 'no dialog on reading').toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    // No dialog is rendered ahead, hidden copies included (the detail may show the freeze end).
    expect(
      Array.from(
        document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], .ant-modal, .ant-modal-root, .ant-popconfirm',
        ),
      ).map((node) => squash(node.textContent).slice(0, 40)),
      'no dialog rendered, shown or hidden',
    ).toEqual([]);
    expect(
      within(document.body)
        .queryAllByLabelText(/原因/)
        .filter((node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
        .map((node) => node.tagName),
      'no reason input rendered',
    ).toEqual([]);
    // [AC-F1-07i-DETAIL#1]: the button names are 冻结 / 封禁, never these.
    expect(document.body.textContent ?? '').not.toMatch(/冻结账号|封禁账号/);
    expect(server.verifies()).toEqual([]);
    expect(
      server.log
        .filter((one) => one.method !== 'GET' || (one.path !== USERS && one.path !== DETAIL))
        .map((one) => `${one.method} ${one.path}`),
      'only the list and this detail are read',
    ).toEqual([]);
    await waitFor(() => expect(server.detailReads().length).toBeGreaterThan(0));
  },
  FLOW_TIMEOUT,
);
