// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DETAIL,
  USERS,
  binding,
  createServer,
  userDetail,
  type Action,
  type Platform,
  type Server,
  type UserDetail,
} from './bindings-fixtures.ts';
import {
  ANY_ENTRY,
  DISABLE_ONLY,
  FLOW_TIMEOUT,
  READ_ONLY,
  RESET_ONLY,
  SUPER,
  actions,
  bindingsTable,
  columnTitles,
  confirmations,
  entriesOf,
  namedEntries,
  openUser,
  pressDisabled,
  settled,
  stepUpDialogs,
  unmountAll,
} from './bindings-helpers.ts';

interface Case {
  readonly user: UserDetail;
  readonly wanted: Readonly<Record<Platform, readonly Action[]>>;
}

/** Shows `user` to `snapshot` and checks the usable entries of both rows; disabled ones do nothing. */
async function expectRows({ user, wanted }: Case, snapshot = SUPER): Promise<Server> {
  const server = createServer(user);
  await openUser(server, snapshot);
  await waitFor(() => expect(columnTitles(), 'an 操作 column').toContain('操作'));
  for (const platform of ['taobao', 'pdd'] as const) {
    const shown = user.union_bindings.find((one) => one.platform === platform);
    const label = `${platform} ${shown?.status ?? 'none'} ${shown?.blocked_reason ?? ''}`;
    expect(entriesOf(platform), label).toEqual(wanted[platform]);
    for (const action of wanted[platform])
      expect(
        namedEntries(platform, action),
        `${label}: ${action} is named with the platform`,
      ).toHaveLength(1);
  }
  await pressDisabled();
  await settled(server);
  expect(confirmations(), 'a disabled entry opens nothing').toEqual([]);
  expect(stepUpDialogs()).toEqual([]);
  expect(server.requests('POST'), 'nothing is written').toEqual([]);
  return server;
}

it(
  '[AC-F1-07jc-ENTRY#1] 超管：淘宝已授权 / 已失效有【重置授权】【停用返利】，拼多多已授权 / 已失效只有【停用返利】；都没有【恢复】',
  async () => {
    await expectRows({
      user: userDetail([binding('taobao', 'active'), binding('pdd', 'active')]),
      wanted: { taobao: ['reset', 'disable'], pdd: ['disable'] },
    });
    unmountAll();
    await expectRows({
      user: userDetail([binding('taobao', 'invalid'), binding('pdd', 'invalid')]),
      wanted: { taobao: ['reset', 'disable'], pdd: ['disable'] },
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ENTRY#2] 超管：后台停用（blocked / admin_disable）的行只有【恢复】，两个平台都是',
  async () => {
    await expectRows({
      user: userDetail([binding('taobao', 'blocked'), binding('pdd', 'blocked')]),
      wanted: { taobao: ['enable'], pdd: ['enable'] },
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ENTRY#3] 超管：因封禁 / 因注销停用、已解除、授权中、未授权的行没有可用入口，置灰的点了也不发请求',
  async () => {
    await expectRows({
      user: userDetail([
        binding('taobao', 'blocked', 'ban'),
        binding('pdd', 'blocked', 'deletion'),
      ]),
      wanted: { taobao: [], pdd: [] },
    });
    unmountAll();
    await expectRows({
      user: userDetail([binding('taobao', 'released'), binding('pdd', 'released')]),
      wanted: { taobao: [], pdd: [] },
    });
    unmountAll();
    await expectRows({
      user: userDetail([binding('taobao', 'pending_auth'), binding('pdd', 'unbound')]),
      wanted: { taobao: [], pdd: [] },
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ENTRY#4] 用户已封禁：后台停用的行不给可用的【恢复】，置灰的点了也不发请求',
  async () => {
    await expectRows({
      user: userDetail([binding('taobao', 'blocked'), binding('pdd', 'blocked')], 'banned'),
      wanted: { taobao: [], pdd: [] },
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ENTRY#5] 只持 union.binding_reset：只有淘宝【重置授权】；只持 union.binding_disable：只有【停用返利】【恢复】',
  async () => {
    await expectRows(
      {
        user: userDetail([binding('taobao', 'active'), binding('pdd', 'active')]),
        wanted: { taobao: ['reset'], pdd: [] },
      },
      RESET_ONLY,
    );
    expect(actions(bindingsTable(), /^(?:停用返利|恢复)/), 'no disable / enable at all').toEqual(
      [],
    );
    unmountAll();
    await expectRows(
      {
        user: userDetail([binding('taobao', 'active'), binding('pdd', 'blocked')]),
        wanted: { taobao: ['disable'], pdd: ['enable'] },
      },
      DISABLE_ONLY,
    );
    expect(actions(bindingsTable(), /^重置授权/), 'no reset at all').toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ENTRY#6] 有写权限才有「操作」列：超管有；不持 union.binding_* 的账号无「操作」列、表内无按钮与链接',
  async () => {
    const user = userDetail([binding('taobao', 'active'), binding('pdd', 'blocked')]);
    await openUser(createServer(user), SUPER);
    await waitFor(() => expect(columnTitles(), 'super admin: an 操作 column').toContain('操作'));
    expect(actions(bindingsTable(), ANY_ENTRY).length).toBeGreaterThan(0);
    unmountAll();
    const server = createServer(user);
    await openUser(server, READ_ONLY);
    expect(columnTitles(), 'read-only: no 操作 column').not.toContain('操作');
    const table = bindingsTable();
    expect(within(table).queryAllByRole('button')).toEqual([]);
    expect(within(table).queryAllByRole('link')).toEqual([]);
    expect(table.querySelectorAll('button, a')).toHaveLength(0);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ENTRY#7] 打开详情只读：有行操作入口，但不弹动态码，只发列表与本用户详情的 GET',
  async () => {
    const server = createServer();
    await openUser(server, SUPER);
    await waitFor(() => expect(entriesOf('taobao')).toEqual(['reset', 'disable']));
    expect(entriesOf('pdd')).toEqual(['disable']);
    await settled(server);
    expect(stepUpDialogs(), 'no step-up on reading').toEqual([]);
    expect(confirmations()).toEqual([]);
    expect(server.verifies()).toEqual([]);
    expect(
      server.log
        .filter((one) => one.method !== 'GET' || (one.path !== USERS && one.path !== DETAIL))
        .map((one) => `${one.method} ${one.path}`),
      'only the list and this detail are read',
    ).toEqual([]);
    expect(server.detailReads().length).toBeGreaterThan(0);
  },
  FLOW_TIMEOUT,
);
