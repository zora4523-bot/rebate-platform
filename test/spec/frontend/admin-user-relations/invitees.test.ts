// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  INVITEES,
  LIST,
  PHONE,
  UID,
  createRelationsServer,
  invitees,
} from './relations-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  detailLoaded,
  drawer,
  mainElement,
  required,
  settled,
  show,
} from './relations-helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-07g-INVITEES#1] 打开才请求，页码分页按服务端返回行显示且翻页不累加旧行',
  async () => {
    const { server } = await show();
    await settled(server);
    expect(server.requests('GET', INVITEES)).toEqual([]);
    const panel = await drawer();
    await waitFor(() => expect(panel.textContent).toContain(invitees()[0]!.user_id));
    await settled(server);
    expect(server.requests('GET', INVITEES)).toHaveLength(1);
    const first = server.requests('GET', INVITEES)[0]!;
    const size = Number(first.query['page_size']);
    expect(first.query).toEqual({ page: '1', page_size: String(size) });
    expect(Number.isInteger(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(200);
    expect(first.headers.has('X-Step-Up-Token')).toBe(false);
    const next = required(
      panel.querySelector<HTMLElement>(
        '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
      ),
      'drawer next page',
    );
    await click(next);
    await waitFor(() => expect(panel.textContent).toContain(invitees()[size]!.user_id));
    await settled(server);
    expect(server.requests('GET', INVITEES).map((request) => request.query)).toEqual([
      { page: '1', page_size: String(size) },
      { page: '2', page_size: String(size) },
    ]);
    expect(panel.textContent).not.toContain(invitees()[0]!.user_id);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITEES#2] 仅展示契约五个业务字段，号码脱敏、空号码不伪造，具名行操作打开详情',
  async () => {
    const { server, directFetch } = await show();
    const panel = await drawer();
    const first = invitees()[0]!;
    await waitFor(() => expect(panel.textContent).toContain(first.user_id));
    const table = required(within(panel).queryByRole('table'), 'invitees table');
    for (const name of ['UID', '昵称', '手机号', '注册时间', '等级'])
      expect(within(table).queryByRole('columnheader', { name })).not.toBeNull();
    const row = required(
      within(table).queryByText(first.user_id)?.closest<HTMLElement>('tr'),
      'null-phone row',
    );
    expect(row.textContent).toContain(first.nickname);
    expect(row.textContent).toContain(first.level);
    expect(row.textContent).toContain('2026-10-10 20:30');
    expect(row.textContent).toContain('—');
    expect(table.textContent).toContain('138****5678');
    expect(table.textContent).not.toMatch(/\b1[3-9]\d{9}\b/);
    expect(table.textContent).not.toContain(PHONE);
    for (const name of ['绑定来源', '绑定方式', '绑定时间', '会员等级', '直推人数'])
      expect(panel.textContent).not.toContain(name);
    const action =
      within(row).queryByRole('button', { name: `查看 ${first.user_id}` }) ??
      within(row).queryByRole('link', { name: `查看 ${first.user_id}` });
    await click(required(action, 'accessible row action 查看 UID'));
    await detailLoaded('P3RT8N');
    expect(mainElement().textContent).toContain(first.user_id);
    expect(server.requests('GET', `${LIST}/${first.user_id}`)).toHaveLength(1);
    expect(server.requests('POST')).toEqual([]);
    expect(server.requests('GET', `${LIST}/${UID}`)).toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITEES#3] 空名单显示空态，不把空表当错误、不伪造样例行',
  async () => {
    const { server } = await show(createRelationsServer([]));
    const panel = await drawer();
    await settled(server);
    await waitFor(() => expect(panel.textContent).toMatch(/暂无|没有|空/));
    expect(panel.querySelectorAll('tr[data-row-key]')).toHaveLength(0);
    expect(within(panel).queryByRole('button', { name: '重试' })).toBeNull();
    expect(server.requests('GET', INVITEES)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITEES#4] 请求在途有加载态，返回后展示名单而非提前显示空态',
  async () => {
    const server = createRelationsServer();
    const release = server.hold('GET', INVITEES);
    let panel: HTMLElement | undefined;
    try {
      await show(server);
      panel = await drawer();
      await waitFor(() => expect(server.requests('GET', INVITEES)).toHaveLength(1));
      expect(
        panel.querySelector('.ant-spin-spinning, [aria-busy="true"], [role="status"]'),
        'visible loading indication',
      ).not.toBeNull();
      expect(panel.textContent).not.toContain(invitees()[0]!.user_id);
      expect(panel.textContent).not.toMatch(/暂无直推|没有直推/);
    } finally {
      release();
    }
    await waitFor(() =>
      expect(required(panel, 'drawer').textContent).toContain(invitees()[0]!.user_id),
    );
    await settled(server);
    expect(server.requests('GET', INVITEES)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITEES#5] 出错显示错误与重试，点击重试仅再请求一次且可恢复',
  async () => {
    const server = createRelationsServer();
    server.once('GET', INVITEES, () => Promise.reject(new TypeError('offline')));
    await show(server);
    const panel = await drawer();
    await waitFor(() => expect(panel.textContent).toMatch(/失败|异常|出错/));
    await settled(server);
    expect(server.requests('GET', INVITEES)).toHaveLength(1);
    expect(panel.textContent).not.toContain(invitees()[0]!.user_id);
    await click(button(panel, '重试'));
    await waitFor(() => expect(panel.textContent).toContain(invitees()[0]!.user_id));
    await settled(server);
    expect(server.requests('GET', INVITEES)).toHaveLength(2);
    expect(server.requests('GET', INVITEES)[1]!.query).toEqual(
      server.requests('GET', INVITEES)[0]!.query,
    );
  },
  FLOW_TIMEOUT,
);
