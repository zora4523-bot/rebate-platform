// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { DETAIL, EXPORTS, INVITE_CODE, UID, USERS, createServer } from './export-fixtures.ts';
import {
  ANY_ENTRY,
  EXPORT,
  EXPORTER,
  EXPORTER_PII,
  EXPORT_LOOKUP,
  FLOW_TIMEOUT,
  LOOKUP_ONLY,
  NO_EXPORT,
  SUPER,
  actions,
  click,
  expectEntries,
  isDisabled,
  listed,
  main,
  mount,
  nameOf,
  openLayers,
  pressDisabled,
  recordsEntry,
  settled,
  stepUpDialogs,
  unmountAll,
  usable,
} from './export-helpers.ts';

/** Mounts the list for `snapshot` and checks it offers 【导出】【导出记录】; nothing is sent. */
async function expectOffered(snapshot: PermissionSnapshot): Promise<void> {
  const server = createServer();
  const { directFetch } = await mount(server, snapshot);
  await expectEntries();
  await settled(server);
  expect(openLayers(), 'no dialog on reading').toEqual([]);
  expect(server.nonReads(), 'opening the list sends no POST').toEqual([]);
  expect(
    server.log
      .filter((one) => one.method !== 'GET' || one.path !== USERS)
      .map((one) => `${one.method} ${one.path}`),
    'only the list is read',
  ).toEqual([]);
  expect(directFetch).not.toHaveBeenCalled();
}

/** Mounts the page for `snapshot`: no usable 【导出】, a greyed one does nothing. */
async function expectWithheld(snapshot: PermissionSnapshot): Promise<void> {
  const server = createServer();
  await mount(server, snapshot);
  await settled(server);
  expect(usable(main(), EXPORT).map(nameOf), 'no usable 【导出】').toEqual([]);
  expect(usable(document.body, EXPORT).map(nameOf), 'no usable 【导出】 anywhere').toEqual([]);
  for (const node of actions(main(), EXPORT))
    expect(isDisabled(node), '【导出】 is greyed').toBe(true);
  await pressDisabled();
  await settled(server);
  expect(openLayers(), 'a greyed 【导出】 opens nothing').toEqual([]);
  expect(stepUpDialogs()).toEqual([]);
  expect(server.nonReads(), 'nothing is sent').toEqual([]);
}

it(
  '[AC-F1-07je-ENTRY#1] 超管打开用户查询：标题行（用户查询标题旁，不在筛选卡或列表里）有【导出】与【导出记录】；打开列表只发列表 GET，不发 POST',
  async () => {
    await expectOffered(SUPER);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ENTRY#2] 非超管同时持 export 与 user.list（有无 pii.reveal_phone 都一样）：标题行有【导出】与【导出记录】',
  async () => {
    await expectOffered(EXPORTER);
    unmountAll();
    await expectOffered(EXPORTER_PII);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ENTRY#3] 持 user.list 等用户权限但缺 export：没有可用的【导出】（不出现或置灰），点置灰的不发请求',
  async () => {
    // The same page for an exporter does offer it (so the check below is not vacuous).
    await expectOffered(EXPORTER);
    unmountAll();
    await expectWithheld(NO_EXPORT);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ENTRY#4] 持 export 但缺 user.list（只有 user.lookup）：没有可用的【导出】，点置灰的不发请求',
  async () => {
    await expectOffered(EXPORTER);
    unmountAll();
    await expectWithheld(EXPORT_LOOKUP);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ENTRY#5] 只持 user.lookup 的账号：页面上没有【导出】，置灰的也没有',
  async () => {
    await expectOffered(SUPER);
    unmountAll();
    const server = createServer();
    await mount(server, LOOKUP_ONLY);
    await settled(server);
    expect(actions(document.body, EXPORT).map(nameOf), 'no 【导出】 at all').toEqual([]);
    expect(server.nonReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ENTRY#6] 超管打开用户详情：详情页不出现【导出】【导出记录】；【返回用户查询】回到列表后两个入口又在标题行',
  async () => {
    const server = createServer({ detail: true });
    await mount(server, SUPER);
    await expectEntries();
    const opener = within(main()).queryAllByRole('button', { name: `详情 ${UID}` });
    expect(opener, `【详情 ${UID}】`).toHaveLength(1);
    await click(opener[0]!);
    await waitFor(() => expect(main().textContent).toContain(INVITE_CODE));
    await settled(server);
    expect(
      within(main()).queryAllByRole('heading', { name: '用户详情' }),
      'the detail is shown',
    ).toHaveLength(1);
    expect(
      actions(main(), ANY_ENTRY).map(nameOf),
      'no 【导出】 / 【导出记录】 on the detail',
    ).toEqual([]);
    const back = within(main()).queryAllByRole('button', { name: '返回用户查询' });
    expect(back, '【返回用户查询】').toHaveLength(1);
    await click(back[0]!);
    await listed();
    await expectEntries();
    expect(server.requests('GET', DETAIL).length).toBeGreaterThan(0);
    expect(server.nonReads(), 'nothing is sent').toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ENTRY#7] 持 export 与 user.list 的账号点标题行【导出记录】：进入已有的导出记录页（标题「导出记录」，读 GET /admin/v1/exports），不创建任务',
  async () => {
    const server = createServer({ records: true });
    await mount(server, EXPORTER);
    await expectEntries();
    expect(server.requests('GET', EXPORTS), 'the list page does not read the tasks').toEqual([]);
    await click(await recordsEntry());
    await waitFor(() =>
      expect(
        within(main()).queryAllByRole('heading', { name: '导出记录' }),
        'the 导出记录 page',
      ).toHaveLength(1),
    );
    await waitFor(() => expect(server.requests('GET', EXPORTS).length).toBeGreaterThan(0));
    await settled(server);
    expect(server.requests('GET', EXPORTS)[0]!.query['page']).toBe('1');
    expect(
      within(main()).queryAllByRole('heading', { name: '用户查询' }),
      'the users list is left',
    ).toEqual([]);
    expect(server.nonReads(), 'opening 导出记录 creates no task').toEqual([]);
  },
  FLOW_TIMEOUT,
);
