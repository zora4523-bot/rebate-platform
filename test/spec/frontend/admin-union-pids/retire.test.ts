// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ACTIVE_ID, PID, PIDS, createServer, failure, retireUrl } from './fixtures.ts';
import {
  CONFLICT,
  FLOW_TIMEOUT,
  LABEL,
  actions,
  assertVerified,
  assertWrite,
  fill,
  mount,
  openRetire,
  row,
  settle,
  stepUp,
  textbox,
  verify,
} from './helpers.ts';

it(
  '[AC-F1-10gb-RET#1] 停用启用中的行：确认并填原因，动态码后 POST retire（expected_row_version + reason），行变为已停用且再无操作',
  async () => {
    const { server } = await mount();
    const form = await openRetire(PID.active);
    await fill(textbox(form, LABEL.reason), '更换分享位');
    const modal = await stepUp(form);
    expect(server.requests('POST', retireUrl(ACTIVE_ID))).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(server.requests('POST', retireUrl(ACTIVE_ID))).toHaveLength(1));
    const sent = server.requests('POST', retireUrl(ACTIVE_ID))[0]!;
    expect(sent.body).toEqual({ expected_row_version: 1, reason: '更换分享位' });
    expect(sent.headers.get('Content-Type')).toMatch(/application\/json/);
    assertWrite(sent);
    assertVerified(server);
    await waitFor(() => expect(actions(row(PID.active), /^停用/)).toEqual([]));
    expect(actions(row(PID.active), /修改|编辑|启用|停用|恢复|删除|移除/)).toEqual([]);
    expect(row(PID.active).textContent).toContain('停用');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-RET#2] 不填原因时 retire 体只有 expected_row_version',
  async () => {
    const { server } = await mount();
    const form = await openRetire(PID.active);
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests('POST', retireUrl(ACTIVE_ID))).toHaveLength(1));
    expect(server.requests('POST', retireUrl(ACTIVE_ID))[0]!.body).toEqual({
      expected_row_version: 1,
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-RET#3] 20902（行已变化）提示刷新并重新读取列表，不自动重发',
  async () => {
    const server = createServer();
    server.once('POST', retireUrl(ACTIVE_ID), () => {
      const index = server.state.findIndex((item) => item.pid_id === ACTIVE_ID);
      server.state[index] = { ...server.state[index]!, status: 'retired', row_version: 2 };
      return failure(20902, { resource: 'union_pid' });
    });
    await mount(server);
    const form = await openRetire(PID.active);
    expect(document.body.textContent).not.toMatch(CONFLICT);
    await verify(await stepUp(form));
    await waitFor(() => expect(document.body.textContent).toMatch(CONFLICT));
    await waitFor(() => expect(server.requests('GET', PIDS)).toHaveLength(2));
    await waitFor(() => expect(actions(row(PID.active), /^停用/)).toEqual([]));
    await settle();
    expect(server.requests('POST', retireUrl(ACTIVE_ID))).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
