// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { PlatformBadge } from '../../../../apps/h5/src/components/platform/index.ts';
import { getPlatformName } from '../../../../apps/h5/src/texts/platform.ts';
import { platforms, remoteIcon } from './fixtures.ts';
import { displayedImage, expectBuiltin, recordImages } from './images.ts';

let images: ReturnType<typeof recordImages>;
const fetchSpy = vi.fn();
const alertSpy = vi.fn();
let xhrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  images = recordImages();
  fetchSpy.mockReset().mockResolvedValue(new Response(''));
  alertSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('alert', alertSpy);
  xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function badge(props: ComponentProps<typeof PlatformBadge>) {
  // A named parent proves the decorative image does not change what a screen reader reads.
  return createElement('button', { type: 'button' }, createElement(PlatformBadge, props));
}

function expectName(container: HTMLElement, name: string): void {
  expect(within(container).getByRole('button', { name })).toBeTruthy();
  expect(container.textContent).toBe(name);
  const outer = container.querySelector('button')!.firstElementChild!;
  expect(outer.tagName).toBe('SPAN');
  expect([null, name]).toContain(outer.getAttribute('aria-label'));
  expect(outer.getAttribute('aria-hidden')).not.toBe('true');
  for (const image of container.querySelectorAll('img')) {
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('aria-hidden')).toBe('true');
  }
  expect(within(container).queryByRole('alert')).toBeNull();
  expect(within(container).queryByRole('status')).toBeNull();
  expect(alertSpy).not.toHaveBeenCalled();
}

for (const { key, name, file } of platforms) {
  it(`[AC-F1-01n-MAPPING#1] ${key} 无下发项时只显示 ${file}.svg 和 ${name}`, () => {
    const config: Schema<'ConfigPlatformIcons'> = {};
    const view = render(badge({ platform: key, remote: config[key] }));
    expectTypeOf<ComponentProps<typeof PlatformBadge>['platform']>().toEqualTypeOf<
      keyof Schema<'ConfigPlatformIcons'>
    >();
    expectTypeOf<ComponentProps<typeof PlatformBadge>['remote']>().toEqualTypeOf<
      Schema<'ConfigPlatformIcon'> | undefined
    >();
    expect(getPlatformName(key)).toBe(name);
    expectBuiltin(view.container, file);
    expectName(view.container, name);
    expect(view.container.querySelectorAll('img')).toHaveLength(1);
    expect(images.requests).toHaveLength(1); // the built-in img only; no detached loader
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it(`[AC-F1-01n-LOAD#1] ${key} 加载前有内置图，load 后显示原 URL，读屏名不变`, () => {
    const remote = remoteIcon(`https://media.example.test/${key}.svg?version=1`);
    const view = render(badge({ platform: key, remote }));
    expectBuiltin(view.container, file);
    expectName(view.container, name);
    fireEvent.load(images.loader(remote.url));
    expect(displayedImage(view.container).getAttribute('src')).toBe(remote.url);
    expectName(view.container, name);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    view.rerender(badge({ platform: key }));
    expectBuiltin(view.container, file);
    expectName(view.container, name);
  });
}

it('[AC-F1-01n-ERROR#1] error 后一直兜底，同 URL 重渲染、改元数据、移除再传入均不重试且无提示', async () => {
  const remote = remoteIcon('https://media.example.test/error-1.svg');
  const view = render(badge({ platform: 'taobao', remote }));
  expectBuiltin(view.container, 'taobao');
  fireEvent.error(images.loader(remote.url));
  expectBuiltin(view.container, 'taobao');
  expectName(view.container, '淘宝');
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  view.rerender(badge({ platform: 'taobao', remote: { ...remote } }));
  view.rerender(
    badge({ platform: 'taobao', remote: { ...remote, version: 2, sha256: 'b'.repeat(64) } }),
  );
  view.rerender(badge({ platform: 'taobao' }));
  view.rerender(badge({ platform: 'taobao', remote }));
  expectBuiltin(view.container, 'taobao');
  expectName(view.container, '淘宝');
  expect(images.forUrl(remote.url)).toHaveLength(1);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(xhrSpy).not.toHaveBeenCalled();
});

it('[AC-F1-01n-ERROR#2] 替换图已显示后再 error，也回内置图并停止请求', () => {
  const remote = remoteIcon('https://media.example.test/error-2.svg');
  const view = render(badge({ platform: 'pdd', remote }));
  fireEvent.load(images.loader(remote.url));
  const displayed = displayedImage(view.container);
  expect(displayed.getAttribute('src')).toBe(remote.url);
  const count = images.forUrl(remote.url).length;
  fireEvent.error(displayed);
  expectBuiltin(view.container, 'pinduoduo');
  view.rerender(badge({ platform: 'pdd', remote: { ...remote } }));
  expectBuiltin(view.container, 'pinduoduo');
  expectName(view.container, '拼多多');
  expect(images.forUrl(remote.url)).toHaveLength(count);
});

it('[AC-F1-01n-ERROR#3] A 失败后 B 可尝试，B 失败再回 A 及卸载后新实例均不重试', () => {
  const a = remoteIcon('https://media.example.test/error-3-a.svg');
  const b = remoteIcon('https://media.example.test/error-3-b.svg');
  const view = render(badge({ platform: 'jd', remote: a }));
  fireEvent.error(images.loader(a.url));
  view.rerender(badge({ platform: 'jd', remote: b }));
  expectBuiltin(view.container, 'jd');
  fireEvent.error(images.loader(b.url));
  view.rerender(badge({ platform: 'jd', remote: a }));
  expectBuiltin(view.container, 'jd');
  expect(images.forUrl(a.url)).toHaveLength(1);
  expect(images.forUrl(b.url)).toHaveLength(1);
  view.unmount();
  const fresh = render(badge({ platform: 'jd', remote: a }));
  expectBuiltin(fresh.container, 'jd');
  expect(images.forUrl(a.url)).toHaveLength(1);
  expectName(fresh.container, '京东');
});

it('[AC-F1-01n-ERROR#4] 同屏首个实例加载失败后，另一实例收到相同 URL 直接兜底且不请求', () => {
  const remote = remoteIcon('https://media.example.test/error-4.svg');
  const first = render(badge({ platform: 'taobao', remote }));
  const second = render(badge({ platform: 'tmall' }));
  expectBuiltin(first.container, 'taobao');
  expectBuiltin(second.container, 'tmall');
  expect(images.forUrl(remote.url)).toHaveLength(1);
  fireEvent.error(images.loader(remote.url));
  second.rerender(badge({ platform: 'tmall', remote }));
  expectBuiltin(first.container, 'taobao');
  expectBuiltin(second.container, 'tmall');
  expectName(first.container, '淘宝');
  expectName(second.container, '天猫');
  expect(images.forUrl(remote.url)).toHaveLength(1);
});

for (const event of ['load', 'error'] as const) {
  it(`[AC-F1-01n-RACE#1] 切换 URL 后旧请求的 ${event} 不覆盖当前图片`, () => {
    const a = remoteIcon(`https://media.example.test/race-1-${event}-a.svg`);
    const b = remoteIcon(`https://media.example.test/race-1-${event}-b.svg`);
    const view = render(badge({ platform: 'wechat', remote: a }));
    const oldLoader = images.loader(a.url);
    view.rerender(badge({ platform: 'wechat', remote: b }));
    expectBuiltin(view.container, 'wechat');
    const newLoader = images.loader(b.url);
    // Reusing a DOM img cancels its previous source request in the browser. Only a
    // distinct old image can still deliver a stale event after the URL changes.
    if (oldLoader !== newLoader) fireEvent[event](oldLoader);
    expectBuiltin(view.container, 'wechat');
    fireEvent.load(newLoader);
    expect(displayedImage(view.container).getAttribute('src')).toBe(b.url);
    if (oldLoader !== newLoader) fireEvent[event](oldLoader);
    expect(displayedImage(view.container).getAttribute('src')).toBe(b.url);
    expectName(view.container, '微信');
  });
}

it('[AC-F1-01n-RACE#2] 换平台与移除 remote 立即回当前平台内置图，迟到 load 无效', () => {
  const a = remoteIcon('https://media.example.test/race-2-a.svg');
  const b = remoteIcon('https://media.example.test/race-2-b.svg');
  const view = render(badge({ platform: 'taobao', remote: a }));
  fireEvent.load(images.loader(a.url));
  expect(displayedImage(view.container).getAttribute('src')).toBe(a.url);
  view.rerender(badge({ platform: 'wechat_pay', remote: b }));
  expectBuiltin(view.container, 'wechat-pay');
  expectName(view.container, '微信支付');
  const pending = images.loader(b.url);
  view.rerender(badge({ platform: 'alipay' }));
  fireEvent.load(pending);
  expectBuiltin(view.container, 'alipay');
  expectName(view.container, '支付宝');
});

for (const url of [
  '',
  'http://media.example.test/icon.svg',
  '//media.example.test/icon.svg',
  '/icon.svg',
  'data:image/svg+xml,<svg/>',
  'blob:https://media.example.test/id',
  'javascript:alert(1)',
  'file:///icon.svg',
  'ftp://media.example.test/icon.svg',
]) {
  it(`[AC-F1-01n-URL#1] 非 https 下发项 ${JSON.stringify(url)} 等同缺失`, () => {
    const view = render(badge({ platform: 'wecom', remote: remoteIcon(url) }));
    expectBuiltin(view.container, 'wecom');
    expectName(view.container, '企业微信');
    expect(view.container.querySelectorAll('img')).toHaveLength(1);
    expect(images.requests).toHaveLength(1);
    expect(images.forUrl(url)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });
}
