// @vitest-environment jsdom
import { act, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  AID,
  DETAIL,
  EXPORTS,
  LOGS,
  RECORD,
  createServer,
  detail,
  failure,
} from './audit-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  detailLoaded,
  exportsLoaded,
  fill,
  logsLoaded,
  mainElement,
  mount,
  query,
  settled,
} from './audit-helpers.ts';

it(
  '[AC-F1-10j-STATES#1] 审计列表在途显示带 status 的加载态，完成后解除且只有一次请求',
  async () => {
    const server = createServer();
    const release = server.hold('GET', LOGS);
    try {
      await mount(server);
      await waitFor(() => expect(server.requests('GET', LOGS)).toHaveLength(1));
      expect(
        within(mainElement())
          .queryAllByRole('status')
          .some((node) => /加载|读取/.test(node.textContent ?? '')),
      ).toBe(true);
      expect(within(mainElement()).queryByRole('button', { name: `查看 ${AID}` })).toBeNull();
    } finally {
      await act(async () => {
        release();
      });
    }
    await logsLoaded();
    await settled(server);
    expect(server.requests('GET', LOGS)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#2] 审计列表空页显示空态，无伪造记录或详情按钮',
  async () => {
    const { server } = await mount(createServer([]));
    await waitFor(() => expect(mainElement().textContent).toMatch(/暂无|没有.*记录|无数据/));
    expect(server.requests('GET', LOGS)).toHaveLength(1);
    expect(within(mainElement()).queryAllByRole('button', { name: /^查看 / })).toHaveLength(0);
    expect(within(mainElement()).queryAllByRole('link', { name: /^查看 / })).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#3] 审计列表网络出错显示 Result，手动重试只增加一次请求并恢复',
  async () => {
    const server = createServer();
    server.once('GET', LOGS, () => Promise.reject(new Error('synthetic offline')));
    await mount(server);
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).not.toBeNull());
    expect(mainElement().textContent).toMatch(/失败|出错|网络/);
    expect(server.requests('GET', LOGS)).toHaveLength(1);
    await click(button(mainElement(), /^重试$/));
    await logsLoaded();
    await settled(server);
    expect(server.requests('GET', LOGS)).toHaveLength(2);
    expect(mainElement().querySelector('.ant-result')).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#13] 成功加载后再次查询失败显示出错态并移除旧数据，重试只请求一次且保留筛选',
  async () => {
    const server = createServer();
    await mount(server);
    await logsLoaded();
    await settled(server);
    expect(mainElement().textContent).toContain(RECORD.action);
    server.once('GET', LOGS, () => new Response('service unavailable', { status: 503 }));
    await fill(/对象类型/, 'custom_entity');
    await query();
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).not.toBeNull());
    await settled(server);
    expect(mainElement().textContent).toMatch(/失败|出错|网络/);
    expect(server.requests('GET', LOGS)).toHaveLength(2);
    expect(server.requests('GET', LOGS)[1]!.query['target_type']).toBe('custom_entity');
    expect(mainElement().textContent).not.toContain(RECORD.action);
    expect(mainElement().textContent).not.toContain(RECORD.target_id);
    expect(mainElement().textContent).not.toContain('login');
    expect(within(mainElement()).queryAllByRole('button', { name: /^查看 / })).toHaveLength(0);
    expect(within(mainElement()).queryAllByRole('link', { name: /^查看 / })).toHaveLength(0);
    server.state.logs = [{ ...RECORD, target_type: 'custom_entity' }];
    await click(button(mainElement(), /^重试$/));
    await logsLoaded();
    await settled(server);
    expect(server.requests('GET', LOGS)).toHaveLength(3);
    expect(server.requests('GET', LOGS)[2]!.query).toEqual(server.requests('GET', LOGS)[1]!.query);
    expect(mainElement().querySelector('.ant-result')).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#4] 审计列表 503 出错可重试，禁止后台自动重放请求',
  async () => {
    const server = createServer();
    server.once('GET', LOGS, () => new Response('service unavailable', { status: 503 }));
    await mount(server);
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).not.toBeNull());
    expect(server.requests('GET', LOGS)).toHaveLength(1);
    await click(button(mainElement(), /^重试$/));
    await logsLoaded();
    await settled(server);
    expect(server.requests('GET', LOGS)).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#5] 导出列表在途显示 status 加载态，不提前显示下载或重试任务',
  async () => {
    const server = createServer();
    const release = server.hold('GET', EXPORTS);
    try {
      await mount(server, '/exports');
      await waitFor(() => expect(server.requests('GET', EXPORTS)).toHaveLength(1));
      expect(
        within(mainElement())
          .queryAllByRole('status')
          .some((node) => /加载|读取/.test(node.textContent ?? '')),
      ).toBe(true);
      expect(within(mainElement()).queryByRole('button', { name: /^下载$/ })).toBeNull();
    } finally {
      await act(async () => {
        release();
      });
    }
    await exportsLoaded();
    expect(server.requests('GET', EXPORTS)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#6] 导出任务空列表展示空态，无下载与任务重试入口',
  async () => {
    const { server } = await mount(createServer(undefined, []), '/exports');
    await waitFor(() =>
      expect(mainElement().textContent).toMatch(/暂无|没有.*记录|没有.*任务|无数据/),
    );
    expect(server.requests('GET', EXPORTS)).toHaveLength(1);
    expect(within(mainElement()).queryAllByRole('button', { name: /^下载$|^重试$/ })).toHaveLength(
      0,
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#7] 导出列表出错显示 Result，重试只请求一次且恢复任务表',
  async () => {
    const server = createServer();
    server.once('GET', EXPORTS, () => Promise.reject(new Error('synthetic offline')));
    await mount(server, '/exports');
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).not.toBeNull());
    expect(mainElement().textContent).toMatch(/失败|出错|网络/);
    expect(server.requests('GET', EXPORTS)).toHaveLength(1);
    await click(button(mainElement(), /^重试$/));
    await exportsLoaded();
    await settled(server);
    expect(server.requests('GET', EXPORTS)).toHaveLength(2);
    expect(mainElement().querySelector('.ant-result')).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#8] 有 export 权限但服务端返回 10403，导出列表仍显示无权限反馈',
  async () => {
    const server = createServer();
    server.once('GET', EXPORTS, () =>
      failure(10403, { reason: 'admin_permission_denied' }, '没有操作权限'),
    );
    await mount(server, '/exports');
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).not.toBeNull());
    expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/);
    expect(server.requests('GET', EXPORTS)).toHaveLength(1);
    expect(within(mainElement()).queryByRole('button', { name: /^下载$/ })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#9] 详情直达加载时显示 status，响应后展示差异',
  async () => {
    const server = createServer();
    const release = server.hold('GET', DETAIL);
    try {
      await mount(server, `/audit-logs/${AID}`);
      await waitFor(() => expect(server.requests('GET', DETAIL)).toHaveLength(1));
      expect(
        within(mainElement())
          .queryAllByRole('status')
          .some((node) => /加载|读取/.test(node.textContent ?? '')),
      ).toBe(true);
      expect(document.body.textContent).not.toContain('banned');
    } finally {
      await act(async () => {
        release();
      });
    }
    await detailLoaded();
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#10] 详情请求失败显示 Result，重试只重新取这一条详情',
  async () => {
    const server = createServer();
    server.once('GET', DETAIL, () => new Response('unavailable', { status: 503 }));
    await mount(server, `/audit-logs/${AID}`);
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).not.toBeNull());
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    await click(button(mainElement(), /^重试$/));
    await detailLoaded();
    await settled(server);
    expect(server.requests('GET', DETAIL)).toHaveLength(2);
    expect(server.requests('GET', LOGS)).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#11] 详情两侧都没有值时照实显示空值，不编造变化',
  async () => {
    const server = createServer();
    server.state.detail = detail({ before: null, after: null });
    await mount(server, `/audit-logs/${AID}`);
    await waitFor(() => expect(mainElement().textContent).toMatch(/无.*值|暂无|—|null/));
    expect(mainElement().textContent).toContain('user_risk_ban');
    expect(mainElement().textContent).not.toContain('已变更');
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-STATES#12] 创建导出被 10403 拒绝时提示无权限，不能显示创建成功或重复提交',
  async () => {
    const server = createServer();
    server.once('POST', EXPORTS, () =>
      failure(10403, { reason: 'admin_permission_denied' }, '没有操作权限'),
    );
    await mount(server);
    await logsLoaded();
    await click(button(mainElement(), /^导出$/));
    await waitFor(() => expect(document.body.textContent).toMatch(/无权限|没有.*权限|权限不足/));
    await settled(server);
    expect(server.requests('POST', EXPORTS)).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/导出.*成功|创建成功/);
  },
  FLOW_TIMEOUT,
);
