// @vitest-environment jsdom
import { within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LISTS, SUPER, UID, USERS, grants, type Server } from './fixtures.ts';
import {
  ALLOWED_TABS,
  FLOW_TIMEOUT,
  LIST_OF,
  TAB_NAMES,
  clean,
  expectFirstPage,
  expectTabUnavailable,
  findTab,
  finish,
  firstShown,
  mainElement,
  mount,
  openTab,
  openUser,
  rowShown,
  settled,
  tabNames,
  tabRow,
  type TabName,
} from './helpers.ts';

afterEach(finish);

/** Every tab title is a whitelisted one; 余额与流水 / 风控命中 are not tabs. */
function expectOnlyAllowedTabs(): void {
  for (const name of tabNames(true)) expect(ALLOWED_TABS, `tab 「${name}」`).toContain(name);
  expect(tabNames(true)).not.toContain('余额与流水');
  expect(tabNames(true)).not.toContain('风控命中');
}

/** The tab bar holds tabs only: no extra button or link that names a list. */
function expectBareTabBar(): void {
  const bars = Array.from(mainElement().querySelectorAll<HTMLElement>('[role="tablist"]'));
  expect(bars.length, 'the detail has a tab bar').toBeGreaterThan(0);
  for (const bar of bars) {
    const extras = [
      ...within(bar).queryAllByRole('button', { hidden: true }),
      ...within(bar).queryAllByRole('link', { hidden: true }),
    ].filter((node) => /订单|找回|提现/.test(clean(node.textContent)));
    expect(
      extras.map((node) => clean(node.textContent)),
      'buttons / links in the tab bar',
    ).toEqual([]);
  }
}

/** The list `name` was read for UID only, page 1 first. */
function expectReadForUid(server: Server, name: TabName): void {
  const reads = server.requests('GET', LIST_OF[name]);
  expect(reads.length, `${LIST_OF[name]} read`).toBeGreaterThan(0);
  for (const read of reads) expect(read.query['user_id']).toBe(UID);
  expectFirstPage(reads[0]!);
}

it(
  '[AC-F1-07jb-TABS#1] 超管打开用户详情：页签行依次为概览 / 订单 / 找回 / 提现，默认停在概览（现有详情内容）；没有余额与流水、风控命中页签，页签栏里没有别的订单 / 找回 / 提现按钮或链接；打开详情不读任何列表',
  async () => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    expect(tabNames()).toEqual(['概览', '订单', '找回', '提现']);
    expectOnlyAllowedTabs();
    expectBareTabBar();
    expect(findTab('概览')?.getAttribute('aria-selected'), '概览 is the open tab').toBe('true');
    expect(mainElement().textContent).toContain('基本信息');
    await settled();
    for (const path of LISTS) expect(server.requests('GET', path), path).toEqual([]);
    expect(server.requests('GET', `${USERS}/${UID}`)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-TABS#2] 只持 user.lookup：订单、找回页签可读（带 user_id），提现页签不出现或显示无权限且不发请求',
  async () => {
    const server = await mount(grants('user.lookup'));
    await openUser(UID);
    await tabRow();
    expectOnlyAllowedTabs();
    await expectTabUnavailable('提现');
    await openTab('订单');
    await rowShown(firstShown('订单'));
    await openTab('找回');
    await rowShown(firstShown('找回'));
    await settled();
    expectReadForUid(server, '订单');
    expectReadForUid(server, '找回');
    expect(server.requests('GET', LIST_OF['提现'])).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-TABS#3] 只持 user.list：订单 / 找回 / 提现页签都不出现或显示无权限，三个列表都不读；概览照常',
  async () => {
    const server = await mount(grants('user.list'));
    await openUser(UID);
    await tabRow();
    expectOnlyAllowedTabs();
    for (const name of TAB_NAMES) await expectTabUnavailable(name);
    for (const path of LISTS) expect(server.requests('GET', path), path).toEqual([]);
    expect(mainElement().textContent).toContain('基本信息');
  },
  FLOW_TIMEOUT,
);

it.each([
  ['order.view', '订单'],
  ['order.claim', '找回'],
  ['withdraw.review', '提现'],
  ['fund.view', '提现'],
] as const)(
  '[AC-F1-07jb-TABS#4] user.list 加 %s：只有「%s」页签可读（带 user_id），另两个列表页签不出现或显示无权限且不发请求',
  async (point, name) => {
    const server = await mount(grants('user.list', point));
    await openUser(UID);
    await tabRow();
    expectOnlyAllowedTabs();
    for (const other of TAB_NAMES.filter((tab) => tab !== name)) await expectTabUnavailable(other);
    await openTab(name);
    await rowShown(firstShown(name));
    await settled();
    expectReadForUid(server, name);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-TABS#5] user.lookup 加 fund.view：订单、找回、提现三个页签都可读，每个列表都带当前用户的 user_id',
  async () => {
    const server = await mount(grants('user.lookup', 'fund.view'));
    await openUser(UID);
    await tabRow();
    expect(tabNames()).toEqual(['概览', '订单', '找回', '提现']);
    for (const name of TAB_NAMES) {
      await openTab(name);
      await rowShown(firstShown(name));
    }
    await settled();
    for (const name of TAB_NAMES) expectReadForUid(server, name);
  },
  FLOW_TIMEOUT,
);
