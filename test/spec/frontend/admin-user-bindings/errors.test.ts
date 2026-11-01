// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  COOLDOWN_UNTIL,
  REASON,
  ROW_VERSION,
  STATUS_SHOWN,
  WRITE_TIME,
  activeUser,
  bindingPath,
  createServer,
  failure,
  type Action,
  type Platform,
  type Server,
} from './bindings-fixtures.ts';
import {
  FLOW_TIMEOUT,
  HINT,
  announce,
  closeConfirmations,
  entriesOf,
  freshText,
  openUser,
  passOf,
  perform,
  readAgain,
  rowShows,
  settled,
} from './bindings-helpers.ts';

/** Nothing on the page says the operation went through. */
function expectNoSuccess(server: Server, text: string): void {
  for (const pattern of [HINT.reset, HINT.disable, HINT.enable])
    expect(text, 'no success notice').not.toMatch(pattern);
  expect(server.writes(), 'no automatic resend').toHaveLength(1);
}

/** The row of `platform` is as it was (server and page). */
async function unchanged(server: Server, platform: Platform, actions: readonly Action[]) {
  expect(server.row(platform)).toMatchObject({
    status: 'active',
    row_version: ROW_VERSION[platform],
  });
  await rowShows(platform, STATUS_SHOWN.active);
  expect(entriesOf(platform)).toEqual(actions);
}

it(
  '[AC-F1-07jc-ERROR#1] 20902（data.resource=union_binding）：提示状态已变化并刷新详情；不自动重发，再操作时带刷新后的 row_version 并成功',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/disable'] });
    server.once('POST', bindingPath('taobao', 'disable'), () => {
      server.changeElsewhere('taobao', { reason: '另一位运营已核对' });
      return failure(20902, { resource: 'union_binding' });
    });
    await openUser(server);
    const { write, prior } = await perform(server, 'taobao', 'disable', REASON);
    expect(write.body).toEqual({ reason: REASON, expected_row_version: ROW_VERSION.taobao });
    await announce(prior, HINT.changed);
    await readAgain(server, write);
    expectNoSuccess(server, freshText(prior));
    await rowShows('taobao', STATUS_SHOWN.active);
    await closeConfirmations();

    const retry = await perform(server, 'taobao', 'disable', REASON);
    expect(retry.write.body).toEqual({
      reason: REASON,
      expected_row_version: ROW_VERSION.taobao + 1,
    });
    expect(passOf(retry.write)).toBe(server.issued[1]);
    expect(server.answerOf(retry.write)).toBe(0);
    await announce(retry.prior, HINT.disable);
    await rowShows('taobao', STATUS_SHOWN.blocked);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ERROR#2] 30154：提示当前状态不能做此操作并刷新详情，该行显示最新状态（已解除）、入口随之消失',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/reset'] });
    server.once('POST', bindingPath('taobao', 'reset'), () => {
      server.changeElsewhere('taobao', {
        status: 'released',
        released_at: WRITE_TIME,
        cooldown_until: COOLDOWN_UNTIL,
      });
      return failure(30154);
    });
    await openUser(server);
    const { write, prior } = await perform(server, 'taobao', 'reset', REASON);
    await announce(prior, HINT.notAllowed);
    await readAgain(server, write);
    expectNoSuccess(server, freshText(prior));
    await rowShows('taobao', STATUS_SHOWN.released);
    await waitFor(() => expect(entriesOf('taobao')).toEqual([]));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ERROR#3] 20001 [platform]：给出该平台不支持此操作的提示，不显示成功、授权不变',
  async () => {
    const server = createServer(activeUser(), { writes: ['pdd/disable'] });
    server.once('POST', bindingPath('pdd', 'disable'), () =>
      failure(20001, { fields: ['platform'] }),
    );
    await openUser(server);
    const { prior } = await perform(server, 'pdd', 'disable', REASON);
    await announce(prior, HINT.platform);
    await settled(server);
    expectNoSuccess(server, freshText(prior));
    await unchanged(server, 'pdd', ['disable']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ERROR#4] 20001 [user_id]：提示用户不存在，不显示成功',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/reset'] });
    server.once('POST', bindingPath('taobao', 'reset'), () =>
      failure(20001, { fields: ['user_id'] }),
    );
    await openUser(server);
    const { prior } = await perform(server, 'taobao', 'reset', REASON);
    await announce(prior, HINT.user);
    await settled(server);
    expectNoSuccess(server, freshText(prior));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ERROR#5] 10403：提示没有权限，不显示成功、授权不变',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/disable'] });
    server.once('POST', bindingPath('taobao', 'disable'), () =>
      failure(10403, { reason: 'admin_permission_denied' }),
    );
    await openUser(server);
    const { prior } = await perform(server, 'taobao', 'disable', REASON);
    await announce(prior, HINT.forbidden);
    await settled(server);
    expectNoSuccess(server, freshText(prior));
    await unchanged(server, 'taobao', ['reset', 'disable']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-ERROR#6] 网络失败：提示失败、不显示成功、不自动重发，授权不变',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/disable'] });
    server.once('POST', bindingPath('taobao', 'disable'), () =>
      Promise.reject(new TypeError('offline')),
    );
    await openUser(server);
    const { prior } = await perform(server, 'taobao', 'disable', REASON);
    await announce(prior, HINT.failed);
    await settled(server);
    expectNoSuccess(server, freshText(prior));
    await unchanged(server, 'taobao', ['reset', 'disable']);
  },
  FLOW_TIMEOUT,
);
