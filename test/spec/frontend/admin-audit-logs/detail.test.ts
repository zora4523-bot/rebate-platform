// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AID, DETAIL, LOGS, OWN, createServer, detail, failure } from './audit-fixtures.ts';
import {
  FLOW_TIMEOUT,
  changed,
  detailLoaded,
  diffRow,
  expectDiff,
  mainElement,
  mount,
  settled,
} from './audit-helpers.ts';

it(
  '[AC-F1-10j-LOGS#9] 详情直达只取详情，逐字段前后值并以非颜色标识变化，无 audit.view_all 也能看本人',
  async () => {
    const { server, directFetch } = await mount(createServer(), `/audit-logs/${AID}`, OWN);
    await detailLoaded();
    await settled(server);
    expect(window.location.pathname).toBe(`/audit-logs/${AID}`);
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(server.requests('GET', LOGS)).toHaveLength(0);
    expect(mainElement().textContent).toMatch(/前值|变更前/);
    expect(mainElement().textContent).toMatch(/后值|变更后/);
    const state = diffRow('state');
    expect(state.textContent).toContain('normal');
    expect(state.textContent).toContain('banned');
    expect(changed(state)).toBe(true);
    expectDiff('state', 'normal', 'banned');
    const phone = diffRow('phone');
    expect(phone.textContent).toContain('138****5678');
    expect(changed(phone)).toBe(false);
    expect(diffRow('enabled').textContent).toContain('false');
    expect(diffRow('enabled').textContent).toContain('true');
    expect(changed(diffRow('enabled'))).toBe(true);
    expectDiff('enabled', 'false', 'true');
    expect(diffRow('count').textContent).toContain('0');
    expect(changed(diffRow('count'))).toBe(false);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#10] 新增记录 before=null 如实显示无前值，不漏掉零和 false',
  async () => {
    const server = createServer();
    server.state.detail = detail({
      before: null,
      after: { count: 0, enabled: false, nickname: '新用户' },
    });
    await mount(server, `/audit-logs/${AID}`);
    await waitFor(() => expect(mainElement().textContent).toContain('新用户'));
    expect(diffRow('count').textContent).toContain('0');
    expect(diffRow('enabled').textContent).toContain('false');
    expect(diffRow('nickname').textContent).toMatch(/无|—|null/);
    expect(changed(diffRow('nickname'))).toBe(true);
    expectDiff('nickname', /无|—|null/, '新用户');
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#11] 删除记录 after=null 保留原值并显示无后值',
  async () => {
    const server = createServer();
    server.state.detail = detail({ before: { nickname: '待删除用户' }, after: null });
    await mount(server, `/audit-logs/${AID}`);
    await waitFor(() => expect(mainElement().textContent).toContain('待删除用户'));
    expect(diffRow('nickname').textContent).toMatch(/无|—|null/);
    expect(changed(diffRow('nickname'))).toBe(true);
    expectDiff('nickname', '待删除用户', /无|—|null/);
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#12] 字段增删、嵌套对象和数组保留 JSON 内容，文本值不被当作 HTML 执行',
  async () => {
    const server = createServer();
    server.state.detail = detail({
      before: {
        removed: '旧字段',
        config: { level: 1 },
        tags: ['alpha'],
        payload: '<img src=x onerror=alert(1)>',
      },
      after: {
        added: '新字段',
        config: { level: 2 },
        tags: ['alpha', 'beta'],
        payload: '<img src=x onerror=alert(1)>',
      },
    });
    await mount(server, `/audit-logs/${AID}`);
    await waitFor(() => expect(mainElement().textContent).toContain('旧字段'));
    expect(mainElement().textContent).toContain('新字段');
    expect(mainElement().textContent).toContain('level');
    expect(mainElement().textContent).toContain('alpha');
    expect(mainElement().textContent).toContain('beta');
    expect(changed(diffRow('removed'))).toBe(true);
    expect(changed(diffRow('added'))).toBe(true);
    expect(changed(diffRow('tags'))).toBe(true);
    expectDiff('removed', '旧字段', /无|—|null/);
    expectDiff('added', /无|—|null/, '新字段');
    expect(changed(diffRow('payload'))).toBe(false);
    expect(mainElement().textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#13] 任意 JSON 的标量前后值也能显示，不能假定 before 和 after 必为对象',
  async () => {
    const server = createServer();
    server.state.detail = detail({ before: '原始标量', after: ['新的值', false, 0] });
    await mount(server, `/audit-logs/${AID}`);
    await waitFor(() => expect(mainElement().textContent).toContain('原始标量'));
    expect(mainElement().textContent).toContain('新的值');
    expect(mainElement().textContent).toContain('false');
    expect(mainElement().textContent).toContain('0');
    expect(mainElement().textContent).not.toContain('[object Object]');
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10j-LOGS#14] 他人或未知详情的 20001 不暴露记录也不回退到全量列表',
  async () => {
    const server = createServer();
    server.once('GET', DETAIL, () => failure(20001, { fields: ['id'] }, '参数错误'));
    await mount(server, `/audit-logs/${AID}`, OWN);
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).not.toBeNull());
    await settled(server);
    expect(mainElement().textContent).toMatch(/不存在|不可见|无法|失败|参数/);
    expect(document.body.textContent).not.toContain('138****5678');
    expect(within(mainElement()).queryByText('banned')).toBeNull();
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(server.requests('GET', LOGS)).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);
