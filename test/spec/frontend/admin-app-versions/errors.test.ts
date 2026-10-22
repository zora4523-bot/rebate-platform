// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LIST,
  PRIMARY,
  TARGET,
  VERIFY,
  createServer,
  failure,
  item,
  ok,
  payload,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  change,
  click,
  edit,
  editor,
  field,
  fieldMessage,
  fill,
  listedVersion,
  mount,
  save,
  saved,
  settled,
  storeName,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['channel', 'default_store', 'min_supported_version', 'store_listings'] as const)(
  '[AC-F1-10h-ERROR#1] 20001 data.fields=[%s] 在指定字段旁提示并保持表单',
  async (name) => {
    const server = createServer();
    const message = '服务端校验：请核对本字段的填写内容';
    server.once('PUT', TARGET, () => failure(20001, { fields: [name] }, message));
    await mount(server);
    await edit();
    await change('update_title', '保留本次运营填写');
    await save();
    await saved(server);
    await waitFor(() => expect(fieldMessage(name)).toContain(message));
    expect(field('update_title').value).toBe('保留本次运营填写');
    expect(field('min_supported_version').value).toBe('2.9.0');
    expect(server.requests('PUT', TARGET)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-ERROR#2] 默认商店不满足最低版本时按所有返回字段提示，不自动下调或弹整组确认',
  async () => {
    const server = createServer();
    const message = '默认商店上架版本不足，无法保存';
    server.once('PUT', TARGET, () =>
      failure(
        20001,
        {
          fields: ['min_supported_version', 'default_store', 'store_listings'],
        },
        message,
      ),
    );
    await mount(server);
    await edit();
    await change('min_supported_version', '2.10.0');
    await change('default_store', 'demo_slow_a');
    await fill(within(editor()).getAllByLabelText(listedVersion)[1]!, '2.8.0');
    await save();
    await verify();
    await saved(server);
    for (const name of ['min_supported_version', 'default_store', 'store_listings'] as const)
      await waitFor(() => expect(fieldMessage(name)).toContain(message));
    expect(field('min_supported_version').value).toBe('2.10.0');
    expect(field('default_store').value).toBe('demo_slow_a');
    expect((within(editor()).getAllByLabelText(listedVersion)[1] as HTMLInputElement).value).toBe(
      '2.8.0',
    );
    expect(server.requests('PUT', TARGET)).toHaveLength(1);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    // A single editing dialog is fine; a second confirmation after this rejection is not.
    expect(
      screen.queryAllByRole('dialog').filter((d) => !d.contains(field('latest_version'))),
    ).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-ERROR#3] 同一商店重复登记由服务端拒绝，字段旁报错且允许修正后保存',
  async () => {
    const server = createServer();
    server.once('PUT', TARGET, () =>
      failure(20001, { fields: ['store_listings'] }, '同一商店不能重复登记'),
    );
    await mount(server);
    await edit();
    await fill(within(editor()).getAllByLabelText(storeName)[1]!, PRIMARY);
    await save();
    await saved(server);
    await waitFor(() => expect(fieldMessage('store_listings')).toContain('同一商店不能重复登记'));
    expect((within(editor()).getAllByLabelText(storeName)[1] as HTMLInputElement).value).toBe(
      PRIMARY,
    );
    await fill(within(editor()).getAllByLabelText(storeName)[1]!, 'demo_corrected');
    await save();
    await saved(server, 2);
    const listings = item().store_listings;
    listings[1]!.store = 'demo_corrected';
    expect(server.requests('PUT', TARGET)[1]!.body).toEqual(
      payload(item(), { store_listings: listings }),
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-ERROR#4] 20902 提醒他人已修改并重读该行，下一次手动保存使用新 row_version',
  async () => {
    const server = createServer();
    await mount(server);
    await edit();
    const before = server.requests('GET', TARGET).length;
    const newest = item({
      row_version: 18,
      update_title: '其他人已保存',
      latest_version: '4.13.0',
    });
    server.once('PUT', TARGET, () =>
      failure(20902, { resource: 'app_version' }, '状态已变化，请刷新后重试'),
    );
    server.once('GET', TARGET, () => ok(newest));
    await change('update_title', '我的未保存内容');
    await save();
    await waitFor(() => expect(document.body.textContent).toMatch(/已被他人修改.*刷新.*重试/));
    await waitFor(() => expect(server.requests('GET', TARGET)).toHaveLength(before + 1));
    await waitFor(() => expect(field('update_title').value).toBe('其他人已保存'));
    expect(field('latest_version').value).toBe('4.13.0');
    expect(server.requests('PUT', TARGET)).toHaveLength(1);
    await change('update_title', '读取新版本后再次修改');
    await save();
    await saved(server, 2);
    expect(server.requests('PUT', TARGET)[1]!.body).toEqual(
      payload(newest, { update_title: '读取新版本后再次修改' }),
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-ERROR#5] PUT 10403 明确提示无权限，不补动态码或自动重发',
  async () => {
    const server = createServer();
    server.once('PUT', TARGET, () =>
      failure(10403, { reason: 'admin_permission_denied' }, '没有操作权限'),
    );
    await mount(server);
    await edit();
    await change('update_title', '未获授权的修改');
    await save();
    await saved(server);
    await waitFor(() => expect(document.body.textContent).toMatch(/无权限|没有.*权限|权限不足/));
    expect(server.requests('POST')).toEqual([]);
    expect(server.requests('PUT', TARGET)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-10h-ERROR#6] 单行读取失败能重试，不将网络错误当 30701 创建，不拉列表', async () => {
  const server = createServer();
  server.once('GET', TARGET, () => Promise.reject(new Error('offline')));
  await mount(server, { editor: true });
  await waitFor(() => expect(document.body.textContent).toMatch(/失败|网络/));
  expect(server.requests('PUT')).toEqual([]);
  await click(button(document.body, /重试|重新加载/));
  await waitFor(() => expect(field('latest_version').value).toBe(item().latest_version));
  expect(server.requests('GET', TARGET)).toHaveLength(2);
  expect(server.requests('GET', LIST)).toEqual([]);
});

it(
  '[AC-F1-10h-ERROR#7] 保存网络失败有错误反馈，草稿保留且无自动重发',
  async () => {
    const server = createServer();
    server.once('PUT', TARGET, () => Promise.reject(new Error('offline')));
    await mount(server);
    await edit();
    await change('update_notes', '网络失败后保留说明');
    await save();
    await waitFor(() => expect(document.body.textContent).toMatch(/失败|网络/));
    await settled(server);
    expect(field('update_notes').value).toBe('网络失败后保留说明');
    expect(server.requests('PUT', TARGET)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
