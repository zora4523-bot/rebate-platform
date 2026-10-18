// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, LOOKUP, UID, PHONE, createServer, failure } from './fixtures.ts';
import { detailLoaded, loaded, lookup, mainElement, mount, searchBox, settled } from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  { value: UID, key: 'uid' },
  { value: PHONE, key: 'phone' },
])(
  '[AC-F1-07i-LOOKUP#1] $key 查找只带一个参数，使用返回详情且没有多余请求',
  async ({ value, key }) => {
    const { server } = await mount();
    await loaded();
    await lookup(value);
    await detailLoaded();
    await settled(server);
    expect(server.requests('GET', LOOKUP)).toHaveLength(1);
    expect(server.requests('GET', LOOKUP)[0]!.query).toEqual({ [key]: value });
    expect(server.log.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: LIST },
      { method: 'GET', path: LOOKUP },
    ]);
    expect(mainElement().textContent).toContain('138****5678');
  },
);

it.each([
  {
    label: 'UID 查无',
    value: UID,
    data: { fields: ['uid'] },
    pattern: /未找到|查无|不存在|没有找到/,
  },
  {
    label: '手机号查无',
    value: PHONE,
    data: { fields: ['phone'] },
    pattern: /未找到|查无|不存在|没有找到/,
  },
  {
    label: '手机号不合法',
    value: PHONE,
    data: { fields: ['phone'], reason: 'phone_invalid' },
    pattern: /手机号.*(?:不合法|无效|格式|错误)/,
  },
  {
    label: '需二选一',
    value: UID,
    data: { fields: ['uid', 'phone'] },
    pattern: /二选一|恰好.*一|任选.*一|只能.*一/,
  },
])(
  '[AC-F1-07i-LOOKUP#2] 20001 $label 在查找旁提示，不替换列表为错误页',
  async ({ value, data, pattern }) => {
    const server = createServer();
    server.once('GET', LOOKUP, () => failure(20001, data, '参数错误'));
    await mount(server);
    await loaded();
    await lookup(value);
    await waitFor(() => expect(mainElement().textContent).toMatch(pattern));
    expect(searchBox().value).toBe(value);
    expect(within(mainElement()).queryAllByRole('table').length).toBeGreaterThan(0);
    expect(within(mainElement()).queryByText('K7QX2M')).toBeNull();
    await settled(server);
    expect(server.log).toHaveLength(2);
    expect(server.requests('GET', LOOKUP)).toHaveLength(1);
  },
);
