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

// 上级与直推 / 调等级 / 改上级 / 查看直推名单 are contract-backed since CT-24e (F1-07g) and left out.
// F1-07ja: the detail may get the contracted read-only tabs of F1-07jb (orders / claims /
// withdrawals beside the overview, design/specs/admin-user-detail.md); funds and risk tabs stay out.
// The list keeps no tabs. `granted` names only the follow-up entries a super admin may get in this
// view (F1-07jc 重置授权 / 停用返利, F1-07jd 冻结 / 封禁 on the detail; F1-07je 导出 / 导出记录 on the
// list); every other name stays forbidden.
const CONTRACT_TABS = ['概览', '订单', '找回', '提现'];

function expectContractScope(view: 'list' | 'detail', granted: readonly string[] = []): void {
  const main = within(mainElement());
  if (view === 'list') expect(main.queryAllByRole('tab', { hidden: true })).toEqual([]);
  for (const tab of main.queryAllByRole('tab', { hidden: true }))
    expect(CONTRACT_TABS, `contracted tab ${tab.textContent}`).toContain(tab.textContent?.trim());
  for (const name of [
    '余额与流水',
    '风控命中',
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
    '调整余额',
    '重置授权',
    '停用返利',
  ]) {
    if (granted.includes(name)) continue;
    expect(main.queryByRole('button', { name }), `no action ${name}`).toBeNull();
    expect(main.queryByRole('link', { name }), `no link ${name}`).toBeNull();
  }
}

it(
  '[AC-F1-07j-NOPE#1] 超管定稿列表与详情也只展示已接入契约，不生成画板中的额外列或模块',
  async () => {
    const { server } = await mount();
    await loaded();
    expectContractScope('list', ['导出', '导出记录']);
    for (const name of ['邀请码', '淘宝授权', '可用余额']) {
      expect(within(mainElement()).queryByRole('columnheader', { name })).toBeNull();
      expect(within(mainElement()).queryByLabelText(name, { exact: true })).toBeNull();
    }
    expect(within(mainElement()).queryByRole('textbox', { name: /注册时间/ })).toBeNull();
    // A finalized, contract-limited list is a positive requirement too (baseline has no title).
    expect(card('用户查询列表').textContent).toContain(UID);
    await openDetail();
    await detailLoaded();
    expectContractScope('detail', ['冻结', '封禁', '重置授权', '停用返利']);
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
    // user.lookup grants none of the follow-up write points: every action stays forbidden.
    expectContractScope('detail');
    expect(
      within(mainElement()).queryByRole('button', { name: /^查看(?:完整手机号)?$/ }),
    ).toBeNull();
    // user.level / user.inviter are not held: their entries stay hidden even though contracted.
    for (const name of ['调等级', '改上级']) {
      expect(within(mainElement()).queryByRole('button', { name }), `no action ${name}`).toBeNull();
      expect(within(mainElement()).queryByRole('link', { name }), `no link ${name}`).toBeNull();
    }
    expect(server.requests('GET', LIST)).toEqual([]);
    expect(server.requests('GET', LOOKUP)).toHaveLength(1);
    expect(server.requests('POST')).toEqual([]);
    expect(within(detailHeader()).queryByText(UID, { exact: true })).not.toBeNull();
    expect(within(card('联盟授权')).queryByRole('table', { name: '联盟授权' })).not.toBeNull();
  },
  FLOW_TIMEOUT,
);
