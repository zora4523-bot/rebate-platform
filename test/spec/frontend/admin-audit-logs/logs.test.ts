// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ACTOR,
  AID,
  DETAIL,
  EXPORTER,
  EXPORTS,
  LEGACY,
  LOGS,
  OTHER,
  OWN,
  RECORD,
  TARGET,
  createServer,
  manyLogs,
} from './audit-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  choose,
  click,
  exportsLoaded,
  fill,
  logsLoaded,
  mainElement,
  mount,
  nextPage,
  openDetail,
  query,
  row,
  settled,
} from './audit-helpers.ts';

it(
  '[AC-F1-10j-LOGS#1] 默认路由展示契约列、北京时间与空字段，经 provider 只请求一页',
  async () => {
    const { server, directFetch } = await mount();
    await logsLoaded();
    await settled(server);
    const requests = server.requests('GET', LOGS);
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.query).sort()).toEqual(['page', 'page_size']);
    expect(requests[0]!.query['page']).toBe('1');
    const size = Number(requests[0]!.query['page_size']);
    expect(Number.isInteger(size) && size >= 2 && size <= 200).toBe(true);
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer example-admin-token');
    for (const label of [/时间/, /操作人/, /动作/, /对象/, /权限/]) {
      expect(
        within(mainElement()).queryAllByRole('columnheader', { name: label }).length,
      ).toBeGreaterThan(0);
    }
    for (const value of [
      '运营甲',
      'user_risk_ban',
      'user',
      TARGET,
      'risk.ban',
      '2026-10-19 01:05',
    ]) {
      expect(row(AID).textContent).toContain(value);
    }
    expect(row(LEGACY.id).textContent).not.toContain('undefined');
    expect(row(LEGACY.id).textContent).not.toContain('null');
    expect(server.requests('GET', DETAIL)).toHaveLength(0);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#2] 操作人、自由对象类型、对象 ID、权限与起止时间以 AND 一次提交，空值不发',
  async () => {
    const server = createServer([{ ...RECORD, target_type: 'custom_entity' }, LEGACY]);
    await mount(server);
    await logsLoaded();
    await fill(/操作人/, ACTOR);
    await fill(/对象类型/, 'custom_entity');
    await fill(/对象\s*ID/i, TARGET);
    await choose(/权限点/, 'risk.ban', 'risk.ban');
    await fill(/开始时间|起始时间/, '2026-10-19 00:00:00');
    await fill(/结束时间/, '2026-10-20 00:00:00');
    await query();
    await waitFor(() => expect(server.requests('GET', LOGS)).toHaveLength(2));
    await settled(server);
    const queryData = server.requests('GET', LOGS)[1]!.query;
    expect(Object.keys(queryData).sort()).toEqual([
      'actor_id',
      'from',
      'page',
      'page_size',
      'permission',
      'target_id',
      'target_type',
      'to',
    ]);
    expect(queryData).toMatchObject({
      actor_id: ACTOR,
      target_type: 'custom_entity',
      target_id: TARGET,
      permission: 'risk.ban',
      page: '1',
    });
    expect(queryData['from']).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(queryData['to']).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(Date.parse(queryData['from']!)).toBe(Date.parse('2026-10-19T00:00:00+08:00'));
    expect(Date.parse(queryData['to']!)).toBe(Date.parse('2026-10-20T00:00:00+08:00'));
    expect(row(AID).textContent).toContain('custom_entity');
    expect(mainElement().textContent).not.toContain('login');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#3] 页码分页保持筛选，改筛选回第一页，重置清空参数并恢复列表',
  async () => {
    const server = createServer(manyLogs());
    await mount(server);
    await logsLoaded();
    await fill(/操作人/, ACTOR);
    await query();
    await waitFor(() => expect(server.requests('GET', LOGS)).toHaveLength(2));
    await nextPage();
    await waitFor(() => expect(server.requests('GET', LOGS)).toHaveLength(3));
    const size = server.requests('GET', LOGS)[0]!.query['page_size'];
    expect(server.requests('GET', LOGS)[2]!.query).toEqual({
      page: '2',
      page_size: size,
      actor_id: ACTOR,
    });
    await fill(/对象\s*ID/i, TARGET);
    await query();
    await waitFor(() => expect(server.requests('GET', LOGS)).toHaveLength(4));
    expect(server.requests('GET', LOGS)[3]!.query).toEqual({
      page: '1',
      page_size: size,
      actor_id: ACTOR,
      target_id: TARGET,
    });
    await click(button(mainElement(), /^重置$/));
    await waitFor(() => expect(server.requests('GET', LOGS)).toHaveLength(5));
    await settled(server);
    expect(server.requests('GET', LOGS)[4]!.query).toEqual({ page: '1', page_size: size });
    await logsLoaded();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#4] 任一登录账号能打开列表，无 audit.view_all 原样显示服务端本人记录，不注入操作人筛选',
  async () => {
    // Deliberately different from the shell's username/display name: those are not identity keys.
    const server = createServer([{ ...RECORD, actor_name: '服务端返回的当前姓名' }]);
    await mount(server, '/audit-logs', OWN);
    await logsLoaded();
    await settled(server);
    expect(row(AID).textContent).toContain('服务端返回的当前姓名');
    expect(server.requests('GET', LOGS)).toHaveLength(1);
    expect(server.requests('GET', LOGS)[0]!.query).not.toHaveProperty('actor_id');
    expect(within(mainElement()).queryByRole('button', { name: /^导出$/ })).toBeNull();
    expect(within(mainElement()).queryByRole('link', { name: '导出记录' })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#5] 无 audit.view_all 筛选他人时展示服务端空页，不在前端改写 actor_id',
  async () => {
    const server = createServer([RECORD]);
    await mount(server, '/audit-logs', OWN);
    await logsLoaded();
    await fill(/操作人/, OTHER);
    await query();
    await waitFor(() => expect(server.requests('GET', LOGS)).toHaveLength(2));
    await waitFor(() => expect(mainElement().textContent).toMatch(/暂无|没有.*记录|无数据/));
    expect(server.requests('GET', LOGS)[1]!.query['actor_id']).toBe(OTHER);
    expect(within(mainElement()).queryByRole('button', { name: `查看 ${AID}` })).toBeNull();
    expect(mainElement().textContent).not.toMatch(/无权限|没有权限/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#6] 查看行操作可访问名带 opaque id，进入可直达的详情地址',
  async () => {
    const { server } = await mount();
    await openDetail();
    await waitFor(() => expect(window.location.pathname).toBe(`/audit-logs/${AID}`));
    await waitFor(() => expect(mainElement().textContent).toContain('banned'));
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#7] export 权限独立于 audit.view_all，导出当前已查询条件且不带分页或解密字段',
  async () => {
    const { server } = await mount(createServer(), '/audit-logs', EXPORTER);
    await logsLoaded();
    await fill(/操作人/, ACTOR);
    await fill(/对象类型/, 'user');
    await fill(/对象\s*ID/i, TARGET);
    await choose(/权限点/, 'risk.ban', 'risk.ban');
    await fill(/开始时间|起始时间/, '2026-10-19 00:00:00');
    await fill(/结束时间/, '2026-10-20 00:00:00');
    await query();
    await waitFor(() => expect(server.requests('GET', LOGS)).toHaveLength(2));
    const {
      page: pageNumber,
      page_size: pageSize,
      ...filters
    } = server.requests('GET', LOGS)[1]!.query;
    expect(pageNumber).toBe('1');
    expect(pageSize).toBeDefined();
    await click(button(mainElement(), /^导出$/));
    await waitFor(() => expect(server.requests('POST', EXPORTS)).toHaveLength(1));
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/导出.*(?:成功|创建|提交)|(?:创建|提交).*成功/),
    );
    expect(server.requests('POST', EXPORTS)[0]!.body).toEqual({ resource: 'audit_logs', filters });
    expect(server.requests('POST', EXPORTS)[0]!.headers.has('X-Step-Up-Token')).toBe(false);
    const link = within(mainElement()).queryByRole('link', { name: '导出记录' });
    expect(link?.getAttribute('href')).toBe('/exports');
    await click(link!);
    await exportsLoaded();
    expect(window.location.pathname).toBe('/exports');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#8] 未设筛选导出使用空 filters，创建在途禁用并拒绝双击重复建任务',
  async () => {
    const server = createServer();
    const release = server.hold('POST', EXPORTS);
    try {
      await mount(server);
      await logsLoaded();
      const action = button(mainElement(), /^导出$/);
      await click(action);
      await waitFor(() => expect(server.requests('POST', EXPORTS)).toHaveLength(1));
      expect(action.disabled).toBe(true);
      await click(action);
      expect(server.requests('POST', EXPORTS)).toHaveLength(1);
      expect(server.requests('POST', EXPORTS)[0]!.body).toEqual({
        resource: 'audit_logs',
        filters: {},
      });
    } finally {
      release();
    }
    await settled(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#15] audit.view_all 可见服务端两位操作人记录，但不隐含 export 权限',
  async () => {
    const { server } = await mount(createServer(), '/audit-logs', {
      isSuper: false,
      permissions: ['audit.view_all'],
    });
    await logsLoaded();
    await settled(server);
    expect(row(AID).textContent).toContain('user_risk_ban');
    expect(row(LEGACY.id).textContent).toContain('login');
    expect(within(mainElement()).queryByRole('button', { name: /^导出$/ })).toBeNull();
    expect(within(mainElement()).queryByRole('link', { name: '导出记录' })).toBeNull();
    expect(server.requests('GET', LOGS)[0]!.query).not.toHaveProperty('actor_id');
  },
  FLOW_TIMEOUT,
);
