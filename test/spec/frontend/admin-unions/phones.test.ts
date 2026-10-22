// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PHONES, PHONE, createServer, failure } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertVerified,
  assertWrite,
  fieldError,
  fill,
  mount,
  openAdd,
  openPhones,
  openRemove,
  settle,
  stepUp,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function noFullPhone(): void {
  expect(document.body.textContent).not.toContain(PHONE);
}

it('[AC-F1-10ga-PHONES#1] 手机列表只有脱敏号，读取不要求动态码', async () => {
  const { server } = await mount();
  await openPhones(server);
  await waitFor(() => expect(document.body.textContent).toContain('138****5678'));
  expect(server.requests('GET', PHONES)).toHaveLength(1);
  expect(server.requests('GET', PHONES)[0]!.headers.has('X-Step-Up-Token')).toBe(false);
  expect(server.requests('POST')).toEqual([]);
  noFullPhone();
});

it(
  '[AC-F1-10ga-PHONES#2] 新增与删除各做动态码，使用整组版本；删除仅 query、无 body',
  async () => {
    const { server } = await mount();
    const form = await openAdd(server);
    await fill(within(form).getByLabelText(/^(?:告警)?手机号$/), PHONE);
    await fill(within(form).getByLabelText(/原因|操作说明/), '新增值班号码');
    const modal = await stepUp(form);
    expect(server.requests('POST', PHONES)).toEqual([]);
    noFullPhone();
    await verify(modal);
    await waitFor(() => expect(document.body.textContent).toContain('139****2222'));
    expect(server.requests('POST', PHONES)).toHaveLength(1);
    const added = server.requests('POST', PHONES)[0]!;
    expect(added.body).toEqual({ phone: PHONE, expected_version: 3, reason: '新增值班号码' });
    expect(added.query).toEqual({});
    assertWrite(added);
    assertVerified(server);
    noFullPhone();
    const remove = await openRemove(server, '139****2222');
    expect(remove.textContent).toContain('139****2222');
    noFullPhone();
    const second = await stepUp(remove);
    expect(server.requests('DELETE')).toEqual([]);
    await verify(second);
    await waitFor(() => expect(document.body.textContent).not.toContain('139****2222'));
    expect(server.requests('DELETE', PHONES)).toHaveLength(1);
    const deleted = server.requests('DELETE', PHONES)[0]!;
    expect(deleted.query).toEqual({ phone_id: 'hm-added', expected_version: '4' });
    expect(deleted.body).toBeUndefined();
    assertWrite(deleted, 'test-totp-2');
    assertVerified(server, 2);
    noFullPhone();
  },
  FLOW_TIMEOUT,
);

it.each(['POST', 'DELETE'] as const)(
  '[AC-F1-10ga-PHONES#3] %s 返回 20902 提示刷新、重新读取版本，不自动重复写入',
  async (method) => {
    const server = createServer();
    await mount(server);
    const form = method === 'POST' ? await openAdd(server) : await openRemove(server);
    if (method === 'POST') await fill(within(form).getByLabelText(/^(?:告警)?手机号$/), PHONE);
    const reads = server.requests('GET', PHONES).length;
    server.once(method, PHONES, () => {
      server.phones.version = 9;
      server.phones.items.push({ phone_id: 'hm-other', phone_masked: '137****3333' });
      return failure(20902, { resource: 'config_item' });
    });
    await verify(await stepUp(form));
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/他人修改|已.*修改.*刷新|冲突.*刷新/),
    );
    await waitFor(() => expect(server.requests('GET', PHONES)).toHaveLength(reads + 1));
    await waitFor(() => expect(document.body.textContent).toContain('137****3333'));
    await settle();
    expect(server.requests(method, PHONES)).toHaveLength(1);
    noFullPhone();
    const title = method === 'POST' ? /新增.*手机|添加.*手机/ : /删除|移除/;
    const next =
      screen.queryByRole('dialog', { name: title }) ??
      (method === 'POST' ? await openAdd(server) : await openRemove(server));
    if (method === 'POST') await fill(within(next).getByLabelText(/^(?:告警)?手机号$/), PHONE);
    await verify(await stepUp(next));
    await waitFor(() => expect(server.requests(method, PHONES)).toHaveLength(2));
    const retried = server.requests(method, PHONES)[1]!;
    if (method === 'POST') expect(retried.body).toEqual({ phone: PHONE, expected_version: 9 });
    else expect(retried.query).toEqual({ phone_id: 'hm-existing', expected_version: '9' });
    assertWrite(retried, 'test-totp-2');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-PHONES#4] 新增返回 20001 phone_invalid，在手机号字段旁提示且不显示完整号码',
  async () => {
    const server = createServer();
    server.once('POST', PHONES, () =>
      failure(20001, { fields: ['phone'], reason: 'phone_invalid' }),
    );
    await mount(server);
    const form = await openAdd(server);
    await fill(within(form).getByLabelText(/^(?:告警)?手机号$/), PHONE);
    await verify(await stepUp(form));
    const current = await screen.findByRole('dialog', { name: /新增.*手机|添加.*手机/ });
    await waitFor(() => fieldError(within(current).getByLabelText(/^(?:告警)?手机号$/)));
    noFullPhone();
    expect(document.body.textContent).not.toContain('139****2222');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-PHONES#5] 未写过的配置使用 version=0，删除最后一个号码后展示空态',
  async () => {
    const server = createServer();
    server.phones.version = 0;
    server.phones.items = [];
    await mount(server);
    const form = await openAdd(server);
    await fill(within(form).getByLabelText(/^(?:告警)?手机号$/), PHONE);
    await verify(await stepUp(form));
    await waitFor(() => expect(document.body.textContent).toContain('139****2222'));
    expect(server.requests('POST', PHONES)[0]!.body).toEqual({ phone: PHONE, expected_version: 0 });
    await verify(await stepUp(await openRemove(server, '139****2222')));
    await waitFor(() => expect(document.body.textContent).not.toContain('139****2222'));
    expect(document.body.textContent).toMatch(/未配置告警手机号|暂无.*手机|暂无数据/);
    expect(server.requests('DELETE', PHONES)[0]!.query).toEqual({
      phone_id: 'hm-added',
      expected_version: '1',
    });
  },
  FLOW_TIMEOUT,
);
