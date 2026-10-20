// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CID,
  DETAIL,
  LIST,
  ROUTE,
  STATUSES,
  UID,
  createServer,
  detail,
  statusLabel,
} from './claims-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  fill,
  loaded,
  mainElement,
  mount,
  nextPage,
  queries,
  row,
  select,
  settled,
  textbox,
} from './claims-helpers.ts';

it(
  '[AC-F1-07f-LIST#1] 真实 claims 入口显示契约列、服务端顺序和审核可访问名，不显示统计卡或一键通过',
  async () => {
    const { server, directFetch } = await mount();
    await loaded();
    await settled(server);
    expect(queries(server)).toHaveLength(1);
    const query = queries(server)[0]!;
    expect(Object.keys(query).sort()).toEqual(['page', 'page_size']);
    expect(query['page']).toBe('1');
    const size = Number(query['page_size']);
    expect(Number.isInteger(size) && size >= 2 && size <= 200).toBe(true);
    const headers = within(mainElement())
      .getAllByRole('columnheader')
      .map((node) => node.textContent?.trim());
    expect(headers).toEqual([
      '找回单号',
      '订单号',
      '平台',
      '用户',
      '付款日期（用户填）',
      '提交时间',
      '证据等级',
      '状态',
      '操作',
    ]);
    const ids = within(mainElement())
      .getAllByRole('row')
      .slice(1)
      .map((node) => within(node).getAllByRole('cell')[0]!.textContent?.trim());
    expect(ids).toEqual(server.state.slice(0, size).map((item) => item.claim_id));
    expect(row().textContent).toContain(server.state[1]!.order_no);
    expect(row().textContent).toContain(UID);
    expect(row().textContent).toContain('135****6021');
    expect(row().textContent).toContain('2026-10-05');
    expect(row().textContent).toContain('2026-10-12 09:15');
    expect(row().textContent).toContain(statusLabel('manual_review'));
    const action =
      within(row()).queryByRole('button', { name: `审核 ${CID}` }) ??
      within(row()).queryByRole('link', { name: `审核 ${CID}` });
    expect(action).not.toBeNull();
    expect(mainElement().textContent).not.toMatch(/一键通过|今日新提交|今日已通过|今日已驳回/);
    expect(mainElement().querySelector('.ant-statistic')).toBeNull();
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-LIST#7] 订单号、子订单号和找回单号都通过 q 精确筛选，未知用户显示空结果',
  async () => {
    const { server } = await mount();
    await loaded();
    for (const query of [server.claim.order_no, detail().items[1]!.sub_order_id, CID]) {
      await fill(textbox(/订单号.*找回单号/), query);
      await click(button(mainElement(), /^查询$/));
      await waitFor(() => expect(queries(server).at(-1)?.['q']).toBe(query));
      await loaded();
      await settled(server);
      expect(queries(server).at(-1)?.['page']).toBe('1');
      expect(within(mainElement()).getAllByRole('row').slice(1)).toHaveLength(1);
      expect(row().textContent).toContain(CID);
    }
    await fill(textbox(/^用户/), '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5999');
    await click(button(mainElement(), /^查询$/));
    await waitFor(() => expect(mainElement().textContent).toContain('没有符合条件的找回申请'));
    expect(queries(server).at(-1)?.['user_id']).toBe('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5999');
    expect(mainElement().textContent).not.toMatch(/加载失败|40401/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-LIST#2] 平台、证据、单号和用户经查询合并为契约参数，重置清除全部条件',
  async () => {
    const { server } = await mount();
    await loaded();
    const size = queries(server)[0]!['page_size'];
    await select(/平台/, '拼多多');
    await select(/证据等级/, /弱/);
    await fill(textbox(/订单号.*找回单号/), CID);
    await fill(textbox(/^用户/), UID);
    await click(button(mainElement(), /^查询$/));
    await waitFor(() =>
      expect(queries(server).at(-1)).toEqual({
        page: '1',
        page_size: size,
        platform: 'pdd',
        evidence_level: 'weak',
        q: CID,
        user_id: UID,
      }),
    );
    await loaded();
    expect(within(mainElement()).getAllByRole('row').slice(1)).toHaveLength(1);
    await click(button(mainElement(), /^重置$/));
    await waitFor(() => expect(queries(server).at(-1)).toEqual({ page: '1', page_size: size }));
    await settled(server);
    expect((textbox(/订单号.*找回单号/) as HTMLInputElement).value).toBe('');
    expect((textbox(/^用户/) as HTMLInputElement).value).toBe('');
    expect(server.requests('POST')).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-LIST#3] 六个状态页签读取完整字典，正计数显示 Badge，零计数页签仍可切换',
  async () => {
    const { server } = await mount();
    await loaded();
    const size = queries(server)[0]!['page_size'];
    for (const status of STATUSES) {
      const tab = within(mainElement()).queryByRole('tab', {
        name: new RegExp(statusLabel(status)),
      });
      expect(tab, status).not.toBeNull();
      const expected = server.state.filter((item) => item.status === status).length;
      if (expected > 0) {
        const badge = tab!.querySelector('.ant-badge');
        expect(badge, `Badge for ${status}`).not.toBeNull();
        expect(
          badge!.textContent?.includes(String(expected)) ||
            badge!.querySelector(`[title="${expected}"]`) !== null,
        ).toBe(true);
      }
      const before = queries(server).length;
      await click(tab!);
      await waitFor(() => expect(queries(server)).toHaveLength(before + 1));
      await settled(server);
      expect(queries(server).at(-1)).toEqual({ page: '1', page_size: size, status });
      expect(tab!.getAttribute('aria-selected')).toBe('true');
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-LIST#4] status 深链首次请求即预选对应页签，计数不从当前页推算',
  async () => {
    const server = createServer();
    await mount(server, '/claims?status=auto_matched');
    await loaded(server.state[0]!.claim_id);
    await settled(server);
    expect(queries(server)).toHaveLength(1);
    expect(queries(server)[0]).toMatchObject({ status: 'auto_matched', page: '1' });
    const selected = within(mainElement()).queryByRole('tab', {
      name: new RegExp(statusLabel('auto_matched')),
    });
    expect(selected?.getAttribute('aria-selected')).toBe('true');
    const other = within(mainElement()).getByRole('tab', {
      name: new RegExp(statusLabel('manual_review')),
    });
    expect(
      other.textContent?.includes('204') || other.querySelector('[title="204"]') !== null,
    ).toBe(true);
    expect(within(mainElement()).getAllByRole('row').slice(1)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-LIST#5] 分页只请求目标页，第二页改条件回第一页并保留 page_size',
  async () => {
    const { server } = await mount();
    await loaded();
    const size = Number(queries(server)[0]!['page_size']);
    await nextPage();
    await loaded(server.state[size]!.claim_id);
    await settled(server);
    expect(queries(server)).toEqual([
      { page: '1', page_size: String(size) },
      { page: '2', page_size: String(size) },
    ]);
    await fill(textbox(/订单号.*找回单号/), CID);
    await click(button(mainElement(), /^查询$/));
    await loaded();
    await settled(server);
    expect(queries(server).at(-1)).toEqual({ page: '1', page_size: String(size), q: CID });
    expect(queries(server)).toHaveLength(3);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-LIST#6] 审核导航与刷新保留 claim_id，返回列表保留筛选条件',
  async () => {
    const { server, unmount } = await mount(createServer(), '/claims?status=manual_review');
    await loaded();
    await select(/平台/, '拼多多');
    await fill(textbox(/^用户/), UID);
    await click(button(mainElement(), /^查询$/));
    await settled(server);
    const previous = queries(server).at(-1);
    const action =
      within(row()).queryByRole('button', { name: `审核 ${CID}` }) ??
      within(row()).queryByRole('link', { name: `审核 ${CID}` });
    expect(action).not.toBeNull();
    await click(action!);
    await waitFor(() => expect(window.location.pathname).toBe(ROUTE));
    await waitFor(() => expect(server.requests('GET', DETAIL)).toHaveLength(1));
    await click(button(mainElement(), /返回/));
    await loaded();
    await settled(server);
    expect(window.location.pathname).toBe('/claims');
    expect(queries(server).at(-1)).toEqual(previous);
    expect((textbox(/^用户/) as HTMLInputElement).value).toBe(UID);
    // A fresh app mount at the address (no in-memory selection) is the refresh boundary.
    unmount();
    await mount(server, ROUTE);
    await waitFor(() => expect(server.requests('GET', DETAIL)).toHaveLength(2));
    await loaded();
    expect(mainElement().textContent).toContain(server.claim.items[1]!.sub_order_id);
    expect(server.requests('POST')).toHaveLength(0);
    expect(server.requests('GET', LIST).length).toBeGreaterThan(0);
  },
  FLOW_TIMEOUT,
);
