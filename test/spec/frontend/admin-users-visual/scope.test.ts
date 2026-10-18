// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, LOOKUP, UID, createServer } from '../admin-users/fixtures.ts';
import {
  FLOW_TIMEOUT,
  card,
  detailHeader,
  detailLoaded,
  loaded,
  lookup,
  mainElement,
  mount,
  openDetail,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function expectContractScope(): void {
  const main = within(mainElement());
  expect(main.queryAllByRole('tab')).toEqual([]);
  for (const name of [
    '余额与流水',
    '风控命中',
    '上级与直推',
    '余额',
    '风控与名单',
    '客服代办',
    '实名',
    '实名状态',
    '身份证',
    '收款账号',
    '绑定方式',
    '直推数',
    '直推人数',
  ])
    expect(main.queryByText(name, { exact: true }), `no placeholder ${name}`).toBeNull();
  for (const name of [
    '导出',
    '导出记录',
    '加入黑名单',
    '冻结',
    '封禁',
    '调等级',
    '改上级',
    '调整余额',
    '重置授权',
    '停用返利',
    '查看直推名单',
  ]) {
    expect(main.queryByRole('button', { name }), `no action ${name}`).toBeNull();
    expect(main.queryByRole('link', { name }), `no link ${name}`).toBeNull();
  }
}

it(
  '[AC-F1-07j-NOPE#1] 超管定稿列表与详情也只展示已接入契约，不生成画板中的额外列或模块',
  async () => {
    const { server } = await mount();
    await loaded();
    expectContractScope();
    for (const name of ['邀请码', '淘宝授权', '可用余额']) {
      expect(within(mainElement()).queryByRole('columnheader', { name })).toBeNull();
      expect(within(mainElement()).queryByLabelText(name, { exact: true })).toBeNull();
    }
    expect(within(mainElement()).queryByRole('textbox', { name: /注册时间/ })).toBeNull();
    // A finalized, contract-limited list is a positive requirement too (baseline has no title).
    expect(card('用户查询列表').textContent).toContain(UID);
    await openDetail();
    await detailLoaded();
    expectContractScope();
    expect(within(detailHeader()).queryByText(UID, { exact: true })).not.toBeNull();
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07j-NOPE#2] 只有 lookup 权限的详情仍有定稿标题和具名授权表，不出现操作或占位卡',
  async () => {
    const server = createServer();
    await mount(server, { isSuper: false, permissions: ['user.lookup'] });
    await lookup(UID);
    await detailLoaded();
    expectContractScope();
    expect(
      within(mainElement()).queryByRole('button', { name: /^查看(?:完整手机号)?$/ }),
    ).toBeNull();
    expect(server.requests('GET', LIST)).toEqual([]);
    expect(server.requests('GET', LOOKUP)).toHaveLength(1);
    expect(server.requests('POST')).toEqual([]);
    expect(within(detailHeader()).queryByText(UID, { exact: true })).not.toBeNull();
    expect(within(card('联盟授权')).queryByRole('table', { name: '联盟授权' })).not.toBeNull();
  },
  FLOW_TIMEOUT,
);
