// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CID, DETAIL, LIST, ROUTE, createServer, failure } from './claims-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  loaded,
  mainElement,
  mount,
  queries,
  settled,
} from './claims-helpers.ts';

it(
  '[AC-F1-07f-STATES#1] 空列表显示没有符合条件的找回申请，保留筛选和重置入口',
  async () => {
    const { server } = await mount(createServer([]));
    await waitFor(() => expect(mainElement().textContent).toContain('没有符合条件的找回申请'));
    expect(within(mainElement()).queryByRole('combobox', { name: /平台/ })).not.toBeNull();
    expect(within(mainElement()).queryAllByRole('button', { name: /重置/ }).length).toBeGreaterThan(
      0,
    );
    expect(within(mainElement()).queryAllByRole('button', { name: /^审核 / })).toHaveLength(0);
    expect(within(mainElement()).queryAllByRole('link', { name: /^审核 / })).toHaveLength(0);
    expect(server.requests('GET', LIST)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-STATES#2] 列表在途使用可读屏 status 加载态，请求完成后移除',
  async () => {
    const server = createServer();
    const release = server.hold('GET', LIST);
    try {
      await mount(server);
      await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
      const statuses = within(mainElement()).queryAllByRole('status');
      expect(statuses.some((node) => /加载/.test(node.textContent ?? ''))).toBe(true);
      expect(mainElement().textContent).not.toContain(CID);
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
  '[AC-F1-07f-STATES#3] 列表失败用 Result 和重试，保留原查询且手动重试只发一次',
  async () => {
    const server = createServer();
    server.once('GET', LIST, () => Promise.reject(new TypeError('offline')));
    await mount(server, '/claims?status=manual_review');
    await waitFor(() => expect(mainElement().textContent).toContain('列表加载失败'));
    expect(mainElement().querySelector('.ant-result')).not.toBeNull();
    expect(queries(server)).toHaveLength(1);
    await click(button(mainElement(), /^重试$/));
    await loaded();
    await settled(server);
    expect(queries(server)).toHaveLength(2);
    expect(queries(server)[1]).toEqual(queries(server)[0]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-STATES#4] 列表已有数据后 10403 显示无权限并清除旧数据',
  async () => {
    const { server } = await mount();
    await loaded();
    server.once('GET', LIST, () => failure(10403, { reason: 'admin_permission_denied' }));
    await click(button(mainElement(), /^查询$/));
    await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
    expect(mainElement().textContent).not.toContain(CID);
    expect(mainElement().textContent).not.toContain('135****6021');
    expect(within(mainElement()).queryAllByRole('button', { name: /^审核 / })).toHaveLength(0);
    expect(server.requests('POST')).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-STATES#5] 审核页 GET 在途显示 status，失败后一次重试加载该单',
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
    } finally {
      release();
    }
    await waitFor(() => expect(mainElement().textContent).toMatch(/加载失败/));
    expect(mainElement().querySelector('.ant-result')).not.toBeNull();
    await click(button(mainElement(), /^重试$/));
    await loaded();
    await settled(server);
    expect(server.requests('GET', DETAIL)).toHaveLength(2);
    expect(mainElement().textContent).toContain(server.claim.items[0]!.sub_order_id);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-STATES#6] 审核页 GET 10403 显示无权限且不展示找回单或操作',
  async () => {
    const server = createServer();
    server.once('GET', DETAIL, () => failure(10403, { reason: 'admin_permission_denied' }));
    await mount(server, ROUTE);
    await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(mainElement().textContent).not.toContain('135****6021');
    expect(within(mainElement()).queryAllByRole('button', { name: /^(通过|驳回)$/ })).toHaveLength(
      0,
    );
  },
  FLOW_TIMEOUT,
);
