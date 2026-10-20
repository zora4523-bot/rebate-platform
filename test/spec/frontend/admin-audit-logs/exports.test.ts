// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DONE,
  EXPIRED_DONE,
  EXPORTER,
  EXPORTS,
  FAILED,
  OWN,
  createServer,
  exportRow,
  exportRows,
  failure,
  ok,
  type ExportStatus,
} from './audit-fixtures.ts';
import { verify } from '../admin-users/helpers.ts';
import { statusText } from './audit-dictionary.ts';
import {
  FLOW_TIMEOUT,
  button,
  captureDownloads,
  choose,
  click,
  exportsLoaded,
  mainElement,
  mount,
  nextPage,
  row,
  settled,
} from './audit-helpers.ts';

const DOWNLOAD = `${EXPORTS}/${DONE}/download`;
const RETRY = `${EXPORTS}/${FAILED}/retry`;

function feedback(): string {
  return Array.from(
    document.querySelectorAll(
      '[role="alert"], .ant-message-notice-content, .ant-notification-notice-description',
    ),
  )
    .map((node) => node.textContent)
    .join(' ');
}

it(
  '[AC-F1-10j-EXPORTS#1] 导出记录直达、无侧栏项，显示任务编号列，状态取后台字典且到期 done 显示已过期',
  async () => {
    const { server, directFetch } = await mount(createServer(), '/exports', EXPORTER);
    await exportsLoaded();
    await settled(server);
    expect(window.location.pathname).toBe('/exports');
    expect(document.querySelector('nav a[href="/exports"]')).toBeNull();
    for (const task of exportRows())
      expect(row(task.id).textContent).toContain(
        statusText(task.id === EXPIRED_DONE ? 'expired' : task.status),
      );
    expect(row(EXPIRED_DONE).textContent).not.toContain(statusText('done'));
    expect(row(FAILED).textContent).toContain('超过导出行数上限，请缩小筛选范围');
    expect(row(DONE).textContent).toMatch(/操作日志|审计日志|audit_logs/);
    expect(row(DONE).textContent).toContain('2026-10-19 09:20');
    expect(row(DONE).textContent).toContain('2026-10-21 10:00');
    for (const label of [/任务编号/, /状态/, /资源|类型/, /创建时间/, /过期时间/]) {
      expect(
        within(mainElement()).queryAllByRole('columnheader', { name: label }).length,
      ).toBeGreaterThan(0);
    }
    expect(server.requests('GET', EXPORTS)).toHaveLength(1);
    expect(server.requests('GET', EXPORTS)[0]!.query).not.toHaveProperty('created_by');
    expect(server.requests('GET', DOWNLOAD)).toHaveLength(0);
    expect(document.querySelector('a[href*="signature="]')).toBeNull();
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#2] 只有 done 未过期可下载、只有 failed 可重试，过期边界与其他状态无操作',
  async () => {
    await mount(createServer(), '/exports');
    await exportsLoaded();
    expect(button(row(DONE), /^下载$/).disabled).toBe(false);
    expect(button(row(FAILED), /^重试$/).disabled).toBe(false);
    expect(within(row(DONE)).queryByRole('button', { name: /^重试$/ })).toBeNull();
    expect(within(row(FAILED)).queryByRole('button', { name: /^下载$/ })).toBeNull();
    for (const task of exportRows().filter((item) => item.id !== DONE && item.id !== FAILED)) {
      expect(within(row(task.id)).queryByRole('button', { name: /^下载$/ })).toBeNull();
      expect(within(row(task.id)).queryByRole('button', { name: /^重试$/ })).toBeNull();
    }
    expect(within(row(EXPIRED_DONE)).queryByRole('link', { name: /^下载$/ })).toBeNull();
    expect(row(EXPIRED_DONE).textContent).toContain(statusText('expired'));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#3] 每次下载重新取签名链接并打开新链接，不能缓存链接或 fetch 文件',
  async () => {
    const urls = captureDownloads();
    const { server, directFetch } = await mount(createServer(), '/exports');
    await exportsLoaded();
    await click(button(row(DONE), /^下载$/));
    await waitFor(() => expect(urls).toHaveLength(1));
    await click(button(row(DONE), /^下载$/));
    await waitFor(() => expect(urls).toHaveLength(2));
    await settled(server);
    expect(server.requests('GET', DOWNLOAD)).toHaveLength(2);
    expect(urls).toEqual([
      'https://exports.example.test/audit.csv?signature=synthetic-1',
      'https://exports.example.test/audit.csv?signature=synthetic-2',
    ]);
    expect(
      server.requests('GET', DOWNLOAD).every((item) => Object.keys(item.query).length === 0),
    ).toBe(true);
    expect(server.log.every((item) => item.path.startsWith('/admin/v1/'))).toBe(true);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#4] 下载在途禁用，双击只有一次请求且只打开一次链接',
  async () => {
    const server = createServer();
    const urls = captureDownloads();
    const release = server.hold('GET', DOWNLOAD);
    try {
      await mount(server, '/exports');
      await exportsLoaded();
      const action = button(row(DONE), /^下载$/);
      await act(async () => {
        fireEvent.click(action);
        fireEvent.click(action);
      });
      await waitFor(() => expect(server.requests('GET', DOWNLOAD)).toHaveLength(1));
      expect(action.disabled).toBe(true);
      await click(action);
      expect(server.requests('GET', DOWNLOAD)).toHaveLength(1);
      expect(urls).toEqual([]);
    } finally {
      release();
    }
    await waitFor(() => expect(urls).toHaveLength(1));
    await settled(server);
    expect(server.requests('GET', DOWNLOAD)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#5] 脱敏任务重试发空对象且在途禁用，成功变回 pending 并移除重试按钮',
  async () => {
    const server = createServer();
    const release = server.hold('POST', RETRY);
    try {
      await mount(server, '/exports');
      await exportsLoaded();
      const action = button(row(FAILED), /^重试$/);
      await act(async () => {
        fireEvent.click(action);
        fireEvent.click(action);
      });
      await waitFor(() => expect(server.requests('POST', RETRY)).toHaveLength(1));
      expect(action.disabled).toBe(true);
      await click(action);
      expect(server.requests('POST', RETRY)).toHaveLength(1);
      expect(server.requests('POST', RETRY)[0]!.body).toEqual({});
      expect(server.requests('POST', RETRY)[0]!.headers.has('X-Step-Up-Token')).toBe(false);
      expect(server.requests('POST', EXPORTS)).toHaveLength(0);
    } finally {
      release();
    }
    await waitFor(() => expect(row(FAILED).textContent).toContain(statusText('pending')));
    expect(within(row(FAILED)).queryByRole('button', { name: /^重试$/ })).toBeNull();
    expect(row(FAILED).textContent).not.toContain('超过导出行数上限');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#6] 状态筛选发契约枚举，分页保留条件且更换状态回第一页',
  async () => {
    const tasks = Array.from({ length: 205 }, (_, index) =>
      exportRow(index === 0 ? DONE : `exp_${String(index).padStart(16, '0')}`),
    );
    const server = createServer(undefined, tasks);
    await mount(server, '/exports');
    await exportsLoaded();
    // Both a status tab and a labelled select are permitted by the brief.
    const tab = within(mainElement()).queryByRole('tab', { name: statusText('done') });
    if (tab) await click(tab);
    else await choose(/状态/, 'done', statusText('done'));
    const queryButton = within(mainElement()).queryByRole('button', { name: /^查询$/ });
    if (!tab && queryButton) await click(queryButton);
    await waitFor(() => expect(server.requests('GET', EXPORTS)).toHaveLength(2));
    const size = server.requests('GET', EXPORTS)[0]!.query['page_size'];
    expect(server.requests('GET', EXPORTS)[1]!.query).toEqual({
      page: '1',
      page_size: size,
      status: 'done',
    });
    await nextPage();
    await waitFor(() => expect(server.requests('GET', EXPORTS)).toHaveLength(3));
    expect(server.requests('GET', EXPORTS)[2]!.query).toEqual({
      page: '2',
      page_size: size,
      status: 'done',
    });
    const failedTab = within(mainElement()).queryByRole('tab', { name: statusText('failed') });
    if (failedTab) await click(failedTab);
    else await choose(/状态/, 'failed', statusText('failed'));
    if (!failedTab && queryButton) await click(queryButton);
    await waitFor(() => expect(server.requests('GET', EXPORTS)).toHaveLength(4));
    expect(server.requests('GET', EXPORTS)[3]!.query).toEqual({
      page: '1',
      page_size: size,
      status: 'failed',
    });
  },
  FLOW_TIMEOUT,
);

/** The stale row permits the click; only the error's data.status tells the new state. */
async function rejectedAction(status: ExportStatus, action: 'download' | 'retry') {
  const server = createServer();
  const urls = captureDownloads();
  const path = action === 'download' ? DOWNLOAD : RETRY;
  const method = action === 'download' ? 'GET' : 'POST';
  const id = action === 'download' ? DONE : FAILED;
  server.once(method, path, () => {
    const index = server.state.tasks.findIndex((task) => task.id === id);
    server.state.tasks[index] = exportRow(id, status);
    const envelope = failure(30417, { status }, '导出任务当前的状态不允许这项操作，请刷新后查看');
    return new Response(envelope.body, { status: 422, headers: envelope.headers });
  });
  await mount(server, '/exports');
  await exportsLoaded();
  await click(button(row(id), action === 'download' ? /^下载$/ : /^重试$/));
  await waitFor(() => expect(feedback()).toContain(statusText(status)));
  await waitFor(() => expect(server.requests('GET', EXPORTS)).toHaveLength(2));
  await settled(server);
  expect(server.requests(method, path)).toHaveLength(1);
  expect(row(id).textContent).toContain(statusText(status));
  expect(urls).toEqual([]);
  return server;
}

it(
  '[AC-F1-10j-EXPORTS#7] 下载遇 30417 expired 按已过期提示并刷新，不重放下载',
  async () => {
    const server = await rejectedAction('expired', 'download');
    expect(server.requests('GET', DOWNLOAD)).toHaveLength(1);
    expect(within(row(DONE)).queryByRole('button', { name: /^下载$/ })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#8] 下载遇 30417 failed 按失败提示并刷新',
  async () => {
    const server = await rejectedAction('failed', 'download');
    expect(server.requests('GET', DOWNLOAD)).toHaveLength(1);
    expect(within(row(DONE)).queryByRole('button', { name: /^下载$/ })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#9] 重试遇 30417 pending 按排队中提示并刷新',
  async () => {
    const server = await rejectedAction('pending', 'retry');
    expect(server.requests('POST', RETRY)).toHaveLength(1);
    expect(within(row(FAILED)).queryByRole('button', { name: /^重试$/ })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#10] 重试遇 30417 running 按生成中提示并刷新',
  async () => {
    const server = await rejectedAction('running', 'retry');
    expect(server.requests('POST', RETRY)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#11] 重试遇 30417 done 按已完成提示并刷新',
  async () => {
    const server = await rejectedAction('done', 'retry');
    expect(server.requests('POST', RETRY)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#12] 重试遇 30417 cancelled 按已取消提示并刷新',
  async () => {
    const server = await rejectedAction('cancelled', 'retry');
    expect(server.requests('POST', RETRY)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#13] 没有 export 权限直达得到无权限提示，不能被兜底欢迎页吞掉',
  async () => {
    const server = createServer();
    server.once('GET', EXPORTS, () => failure(10403, { reason: 'admin_permission_denied' }));
    await mount(server, '/exports', OWN);
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).not.toBeNull());
    expect(window.location.pathname).toBe('/exports');
    expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/);
    expect(within(mainElement()).queryByRole('button', { name: /^下载$/ })).toBeNull();
    expect(server.requests('POST', EXPORTS)).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#14] 下载时服务端 10403 不打开链接、不自动重发，显示无权限提示',
  async () => {
    const server = createServer();
    const urls = captureDownloads();
    server.once('GET', DOWNLOAD, () =>
      failure(10403, { reason: 'admin_permission_denied' }, '没有操作权限'),
    );
    await mount(server, '/exports');
    await exportsLoaded();
    await click(button(row(DONE), /^下载$/));
    await waitFor(() => expect(document.body.textContent).toMatch(/无权限|没有.*权限|权限不足/));
    await settled(server);
    expect(server.requests('GET', DOWNLOAD)).toHaveLength(1);
    expect(urls).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#15] 未脱敏 users 任务重试先要新原因和 totp，验证完成才发送带 token 的一次重试',
  async () => {
    const server = createServer(undefined, [
      exportRow(FAILED, 'failed', { resource: 'users', masked: false }),
    ]);
    const verification = '/admin/v1/auth/step-up';
    server.once('POST', verification, () =>
      ok({
        step_up_token: 'audit-export-fresh-totp',
        tier: 'totp',
        expire_at: '2026-10-20T02:05:00Z',
      }),
    );
    await mount(server, '/exports');
    await exportsLoaded(FAILED);
    await click(button(row(FAILED), /^重试$/));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /原因/ })).not.toBeNull());
    expect(server.requests('POST', RETRY)).toHaveLength(0);
    const reason = screen.queryByRole('textbox', { name: /原因/ })!;
    await act(async () => {
      fireEvent.change(reason, { target: { value: '重新核对注册资料，重试上次失败导出' } });
    });
    const form = reason.closest<HTMLElement>('[role="dialog"]') ?? mainElement();
    await click(button(form, /^(确认|继续|验证并重试|确认重试|重试|验证并继续|下一步)$/));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '二次验证 · 动态码' })).not.toBeNull(),
    );
    expect(server.requests('POST', RETRY)).toHaveLength(0);
    await verify(screen.queryByRole('dialog', { name: '二次验证 · 动态码' })!);
    await waitFor(() => expect(server.requests('POST', RETRY)).toHaveLength(1));
    await settled(server);
    expect(server.requests('POST', verification)).toHaveLength(1);
    expect(server.requests('POST', verification)[0]!.body).toEqual({
      tier: 'totp',
      code: '123456',
    });
    expect(server.requests('POST', RETRY)[0]!.body).toEqual({
      reason: '重新核对注册资料，重试上次失败导出',
    });
    expect(server.requests('POST', RETRY)[0]!.headers.get('X-Step-Up-Token')).toBe(
      'audit-export-fresh-totp',
    );
    expect(row(FAILED).textContent).toContain(statusText('pending'));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-EXPORTS#16] 下载 20001 不可见任务时不打开文件或改用其他任务，提示失败且不自动重发',
  async () => {
    const server = createServer();
    const urls = captureDownloads();
    server.once('GET', DOWNLOAD, () => failure(20001, { fields: ['id'] }, '参数错误'));
    await mount(server, '/exports');
    await exportsLoaded();
    await click(button(row(DONE), /^下载$/));
    await waitFor(() => expect(feedback()).toMatch(/失败|不存在|不可见|参数|无法/));
    await settled(server);
    expect(urls).toEqual([]);
    expect(server.requests('GET', DOWNLOAD)).toHaveLength(1);
    expect(server.log.filter((request) => request.path.endsWith('/download'))).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
