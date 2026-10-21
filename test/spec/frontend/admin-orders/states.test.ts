// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DETAIL, LIST, NUMBER, ROUTE, createServer, failure } from './orders-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  loaded,
  mainElement,
  mount,
  queries,
  query,
  select,
  settled,
} from './orders-helpers.ts';

it(
  '[AC-F1-07e-STATES#1] 空列表显示没有符合条件的订单，仍可筛选和重置',
  async () => {
    const { server } = await mount(createServer([]));
    await waitFor(() => expect(mainElement().textContent).toContain('没有符合条件的订单'));
    expect(within(mainElement()).queryByRole('combobox', { name: /^平台$/ })).not.toBeNull();
    expect(within(mainElement()).queryAllByRole('button', { name: /重置/ }).length).toBeGreaterThan(
      0,
    );
    expect(within(mainElement()).queryAllByRole('button', { name: /^详情 / })).toHaveLength(0);
    expect(within(mainElement()).queryAllByRole('link', { name: /^详情 / })).toHaveLength(0);
    expect(queries(server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-STATES#2] 列表在途显示可读屏加载状态，完成后显示数据并移除加载提示',
  async () => {
    const server = createServer();
    const release = server.hold('GET', LIST);
    try {
      await mount(server);
      await waitFor(() => expect(queries(server)).toHaveLength(1));
      expect(
        within(mainElement())
          .queryAllByRole('status')
          .some((node) => /加载/.test(node.textContent ?? '')),
      ).toBe(true);
      expect(mainElement().textContent).not.toContain(NUMBER);
    } finally {
      release();
    }
    await loaded();
    expect(
      within(mainElement())
        .queryAllByRole('status')
        .some((node) => /加载/.test(node.textContent ?? '')),
    ).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-STATES#3] 列表失败使用 Result，重试保留条件且只增加一个请求',
  async () => {
    const server = createServer();
    await mount(server);
    await loaded();
    await select(/^平台$/, /拼多多|pdd/);
    server.once('GET', LIST, () => Promise.reject(new TypeError('offline')));
    await query();
    await waitFor(() => expect(mainElement().textContent).toContain('列表加载失败'));
    expect(mainElement().querySelector('.ant-result')).not.toBeNull();
    expect(queries(server)).toHaveLength(2);
    expect(queries(server)[1]).toMatchObject({ platform: 'pdd' });
    await click(button(mainElement(), /^重试$/));
    await loaded();
    await settled(server);
    expect(queries(server)).toHaveLength(3);
    expect(queries(server)[2]).toEqual(queries(server)[1]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-STATES#4] 再查失败清除旧行、金额及详情入口，成功重试才恢复',
  async () => {
    const { server } = await mount();
    await loaded();
    server.once('GET', LIST, () => {
      const response = failure(50001, null, '服务异常');
      return new Response(response.body, { status: 500, headers: response.headers });
    });
    await query();
    await waitFor(() => expect(mainElement().textContent).toContain('列表加载失败'));
    expect(mainElement().textContent).not.toContain(NUMBER);
    expect(mainElement().textContent).not.toContain('12,345.67');
    expect(mainElement().textContent).not.toContain('138****5678');
    expect(within(mainElement()).queryAllByRole('button', { name: /^详情 / })).toHaveLength(0);
    expect(within(mainElement()).queryAllByRole('link', { name: /^详情 / })).toHaveLength(0);
    expect(queries(server)).toHaveLength(2);
    await click(button(mainElement(), /^重试$/));
    await loaded();
    await settled(server);
    expect(queries(server)).toHaveLength(3);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-STATES#5] 列表再查 10403 显示无权限并清除旧数据',
  async () => {
    const { server } = await mount();
    await loaded();
    server.once('GET', LIST, () => failure(10403, { reason: 'admin_permission_denied' }));
    await query();
    await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
    await settled(server);
    expect(mainElement().textContent).not.toContain(NUMBER);
    expect(mainElement().textContent).not.toContain('138****5678');
    expect(queries(server)).toHaveLength(2);
    expect(server.log.filter((request) => request.method !== 'GET')).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-STATES#6] 详情在途显示加载状态，失败后只重试当前订单一次',
  async () => {
    const server = createServer();
    const release = server.hold('GET', DETAIL, () => Promise.reject(new TypeError('offline')));
    try {
      await mount(server, ROUTE);
      await waitFor(() => expect(server.requests('GET', DETAIL)).toHaveLength(1));
      expect(
        within(mainElement())
          .queryAllByRole('status')
          .some((node) => /加载/.test(node.textContent ?? '')),
      ).toBe(true);
      expect(mainElement().textContent).not.toContain(NUMBER);
    } finally {
      release();
    }
    await waitFor(() => expect(mainElement().textContent).toMatch(/加载失败/));
    expect(mainElement().querySelector('.ant-result')).not.toBeNull();
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    await click(button(mainElement(), /^重试$/));
    await loaded();
    await settled(server);
    expect(server.requests('GET', DETAIL)).toHaveLength(2);
    expect(server.requests('GET', LIST)).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-STATES#7] 详情 10403 显示无权限，不泄露订单与用户信息',
  async () => {
    const server = createServer();
    server.once('GET', DETAIL, () => failure(10403, { reason: 'admin_permission_denied' }));
    await mount(server, ROUTE);
    await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
    await settled(server);
    expect(mainElement().textContent).not.toContain(NUMBER);
    expect(mainElement().textContent).not.toContain('138****5678');
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(server.requests('GET', LIST)).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);
