// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  CLAIMS,
  LISTS,
  ORDERS,
  PARENT,
  SUPER,
  UID,
  USERS,
  WITHDRAWALS,
  createServer,
  data,
  manyUidClaims,
  manyUidOrders,
  manyUidWithdrawals,
  parentOrders,
  uidOrders,
  type ServerData,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  LIST_OF,
  click,
  detailLoaded,
  finish,
  firstShown,
  mainElement,
  mount,
  nextPageControl,
  openLinkedUser,
  openOverview,
  openTab,
  openUser,
  rowShown,
  rowsWith,
  settled,
  tabRow,
  type TabName,
} from './helpers.ts';

afterEach(finish);

it(
  '[AC-F1-07jb-REQ#1] 打开详情只读详情；切到某页签才读该列表，每次一条、带当前用户 user_id 与第 1 页，其余列表不读',
  async () => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await settled();
    for (const path of LISTS) expect(server.requests('GET', path), path).toEqual([]);

    await openTab('订单');
    await rowShown(firstShown('订单'));
    await settled();
    const orders = server.requests('GET', ORDERS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.query['user_id']).toBe(UID);
    expect(orders[0]!.query['page']).toBe('1');
    expect(server.requests('GET', CLAIMS)).toEqual([]);
    expect(server.requests('GET', WITHDRAWALS)).toEqual([]);

    await openTab('找回');
    await rowShown(firstShown('找回'));
    await settled();
    const claims = server.requests('GET', CLAIMS);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.query['user_id']).toBe(UID);
    expect(claims[0]!.query['page']).toBe('1');
    expect(server.requests('GET', WITHDRAWALS)).toEqual([]);

    await openTab('提现');
    await rowShown(firstShown('提现'));
    await settled();
    const withdrawals = server.requests('GET', WITHDRAWALS);
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]!.query['user_id']).toBe(UID);
    expect(withdrawals[0]!.query['page']).toBe('1');

    expect(server.requests('GET', `${USERS}/${UID}`)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-REQ#2] 切回已加载的页签：仍显示当前用户的列表，所有列表请求都只带当前用户的 user_id',
  async () => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await openTab('订单');
    await rowShown(firstShown('订单'));
    await openTab('找回');
    await rowShown(firstShown('找回'));
    await openTab('订单');
    await rowShown(firstShown('订单'));
    await settled();
    expect(server.requests('GET', ORDERS).length).toBeGreaterThan(0);
    for (const path of [ORDERS, CLAIMS])
      for (const read of server.requests('GET', path)) expect(read.query['user_id']).toBe(UID);
  },
  FLOW_TIMEOUT,
);

/** A server whose UID has 205 rows in the list of `name`, and the numbers of those rows. */
function paged(name: TabName): { initial: ServerData; numbers: string[] } {
  if (name === '订单') {
    const rows = manyUidOrders();
    return { initial: { ...data(), orders: rows }, numbers: rows.map((row) => row.sub_order_id) };
  }
  if (name === '找回') {
    const rows = manyUidClaims();
    return { initial: { ...data(), claims: rows }, numbers: rows.map((row) => row.claim_id) };
  }
  const rows = manyUidWithdrawals();
  return {
    initial: { ...data(), withdrawals: rows },
    numbers: rows.map((row) => row.out_biz_no),
  };
}

it.each(['订单', '找回', '提现'] as const)(
  '[AC-F1-07jb-REQ#3] 「%s」页签页码分页：下一页按同一 user_id 读第 2 页，显示第 2 页的行、不再显示第 1 页的行',
  async (name) => {
    const { initial, numbers } = paged(name);
    const server = await mount(SUPER, createServer(SUPER, initial));
    await openUser(UID);
    await tabRow();
    await openTab(name);
    await rowShown(numbers[0]!);
    await settled();
    const first = server.requests('GET', LIST_OF[name]);
    expect(first).toHaveLength(1);
    const size = Number(first[0]!.query['page_size'] ?? '20');
    await click(nextPageControl());
    await rowShown(numbers[size]!);
    await settled();
    const later = server.requests('GET', LIST_OF[name]).slice(1);
    expect(later.length, 'a read for page 2').toBeGreaterThan(0);
    for (const read of later) {
      expect(read.query['page']).toBe('2');
      expect(read.query['user_id']).toBe(UID);
    }
    expect(rowsWith(numbers[0]!)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-REQ#4] 在详情里点上级换到另一个用户：页签请求的 user_id 跟着换，新列表到来前后都不显示上一个用户的订单',
  async () => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await openTab('订单');
    await rowShown(firstShown('订单'));
    await settled();
    await openOverview();
    const mark = server.log.length;
    const release = server.hold('GET', ORDERS);
    try {
      await openLinkedUser(PARENT);
      await detailLoaded(PARENT);
      await tabRow();
      await openTab('订单');
      await waitFor(() =>
        expect(
          server.requests('GET', ORDERS).filter((read) => read.query['user_id'] === PARENT).length,
          'orders read for the new user',
        ).toBeGreaterThan(0),
      );
      for (const order of uidOrders())
        expect(mainElement().textContent, 'old user order while loading').not.toContain(
          order.sub_order_id,
        );
    } finally {
      release();
    }
    await rowShown(parentOrders()[0]!.sub_order_id);
    await settled();
    for (const order of uidOrders()) expect(rowsWith(order.sub_order_id)).toEqual([]);
    const after = server.log
      .slice(mark)
      .filter((read) => (LISTS as readonly string[]).includes(read.path));
    expect(after.length).toBeGreaterThan(0);
    for (const read of after) expect(read.query['user_id']).toBe(PARENT);
    expect(server.requests('GET', `${USERS}/${PARENT}`).length).toBeGreaterThan(0);
  },
  FLOW_TIMEOUT,
);
