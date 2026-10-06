// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import * as bridgeSdk from '@couli/bridge-sdk';
import { detectRuntime } from '../../../../apps/h5/src/shared/env.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['Mozilla/5.0 MicroMessenger/8.0', 'wechat'],
  ['Mozilla/5.0 Safari/605.1.15', 'browser'],
  ['RebateApp/1.0 TrustedWebView Android', 'browser'],
  ['', 'browser'],
] as const)('[AC-F1-01c-ENV#1] 无桥时 UA %s 判为 %s', (ua, expected) => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
  expect(detectRuntime(window)).toBe(expected);
});

it.each(['MicroMessenger/8.0', 'Safari', ''])(
  '[AC-F1-01c-ENV#2] 注入桥优先于 UA %s，使用 SDK 的 isInApp',
  (ua) => {
    vi.stubGlobal('__REBATE_BRIDGE__', { version: 1 });
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
    const isInApp = vi.spyOn(bridgeSdk, 'isInApp');
    expect(detectRuntime(window)).toBe('app');
    expect(isInApp).toHaveBeenCalled();
  },
);

it('[AC-F1-01c-ENV#3] 桥的注入与移除立即生效，不缓存上次环境', () => {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('MicroMessenger/8.0');
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  expect(detectRuntime(window)).toBe('wechat');
  vi.stubGlobal('__REBATE_BRIDGE__', {});
  expect(detectRuntime(window)).toBe('app');
  vi.stubGlobal('__REBATE_BRIDGE__', null);
  expect(detectRuntime(window)).toBe('wechat');
});
