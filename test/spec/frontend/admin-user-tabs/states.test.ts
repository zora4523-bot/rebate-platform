// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LISTS, QUIET, SUPER, UID, USERS, denied } from './fixtures.ts';
import {
  EMPTY,
  FAILED,
  FLOW_TIMEOUT,
  LIST_OF,
  LOADING,
  NO_PERMISSION,
  button,
  click,
  finish,
  firstShown,
  mainElement,
  mount,
  occurrences,
  openTab,
  openUser,
  rowShown,
  rowsWith,
  settled,
  tabRow,
} from './helpers.ts';

afterEach(finish);

it.each(['订单', '找回', '提现'] as const)(
  '[AC-F1-07jb-STATES#1] 「%s」页签加载中：只拦该列表请求，在途时出现加载中提示且没有行，返回后显示该用户的行',
  async (name) => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await settled();
    const before = occurrences(LOADING);
    const release = server.hold('GET', LIST_OF[name]);
    try {
      await openTab(name);
      await waitFor(() => expect(server.requests('GET', LIST_OF[name])).toHaveLength(1));
      await waitFor(() => expect(occurrences(LOADING), 'loading notice').toBeGreaterThan(before));
      expect(rowsWith(firstShown(name))).toEqual([]);
    } finally {
      release();
    }
    await rowShown(firstShown(name));
  },
  FLOW_TIMEOUT,
);

it.each(['订单', '找回', '提现'] as const)(
  '[AC-F1-07jb-STATES#2] 「%s」页签出错：只拦该列表请求，显示加载失败与【重试】；重试只重发这一个列表（同一 user_id），不重读详情和别的列表',
  async (name) => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await settled();
    const detailReads = server.requests('GET', `${USERS}/${UID}`).length;
    const before = occurrences(FAILED);
    server.once('GET', LIST_OF[name], () => Promise.reject(new TypeError('offline')));
    await openTab(name);
    await waitFor(() => expect(occurrences(FAILED), 'load failed notice').toBeGreaterThan(before));
    await settled();
    expect(server.requests('GET', LIST_OF[name])).toHaveLength(1);
    expect(rowsWith(firstShown(name))).toEqual([]);
    await click(button(mainElement(), /重试|重新加载/));
    await rowShown(firstShown(name));
    await settled();
    const reads = server.requests('GET', LIST_OF[name]);
    expect(reads).toHaveLength(2);
    expect(reads[1]!.query['user_id']).toBe(UID);
    for (const path of LISTS.filter((list) => list !== LIST_OF[name]))
      expect(server.requests('GET', path), path).toEqual([]);
    expect(server.requests('GET', `${USERS}/${UID}`)).toHaveLength(detailReads);
  },
  FLOW_TIMEOUT,
);

it.each(['订单', '找回', '提现'] as const)(
  '[AC-F1-07jb-STATES#3] 「%s」页签空态：该用户没有记录时显示空态提示，不显示无权限或加载失败',
  async (name) => {
    const server = await mount(SUPER);
    await openUser(QUIET);
    await tabRow();
    await settled();
    const empty = occurrences(EMPTY);
    const denials = occurrences(NO_PERMISSION);
    const failures = occurrences(FAILED);
    await openTab(name);
    await waitFor(() => expect(occurrences(EMPTY), 'empty notice').toBeGreaterThan(empty));
    await settled();
    expect(occurrences(NO_PERMISSION)).toBe(denials);
    expect(occurrences(FAILED)).toBe(failures);
    const reads = server.requests('GET', LIST_OF[name]);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.query['user_id']).toBe(QUIET);
  },
  FLOW_TIMEOUT,
);

it.each(['订单', '找回', '提现'] as const)(
  '[AC-F1-07jb-STATES#4] 「%s」页签的列表返回 10403（admin_permission_denied）时显示无权限，不显示行、不自动重发',
  async (name) => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await settled();
    const before = occurrences(NO_PERMISSION);
    server.once('GET', LIST_OF[name], () => denied());
    await openTab(name);
    await waitFor(() =>
      expect(occurrences(NO_PERMISSION), 'no-permission notice').toBeGreaterThan(before),
    );
    await settled();
    expect(rowsWith(firstShown(name))).toEqual([]);
    expect(server.requests('GET', LIST_OF[name])).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
