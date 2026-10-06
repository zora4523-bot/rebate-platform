// @vitest-environment jsdom
// 03 §5.2–5.4 / TECH-28. AC-F1-01b numbers are local acceptance cases for this task.
import { afterEach, expect, it, vi } from 'vitest';
import { call, has, isInApp } from '@couli/bridge-sdk';
import { invoke } from '@couli/bridge-sdk/conformance';
import { contract, installBridge, outcome } from './kit.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('[AC-F1-01b#1] UA 冒充 App 但没有注入对象时，仍然是 App 外', () => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('RebateApp/1.0 iPhone Android');
  expect(isInApp()).toBe(false);
  expect(has('ui.toast')).toBeNull();
});

it('[AC-F1-01b#2] 浏览器 UA 下只凭注入对象识别 App，不读取 UA', () => {
  // Document-start capability marker is sufficient; transport methods need not be installed yet.
  vi.stubGlobal('__REBATE_BRIDGE__', { version: 1, methods: [] });
  const ua = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0');
  expect(isInApp()).toBe(true);
  expect(ua).not.toHaveBeenCalled();
});

it('[AC-F1-01b#3] 逐个契约方法探测：只接受原生 methods 声明，不把同命名空间或契约存在当作支持', () => {
  const methods = Object.keys(contract.bridgeMethods) as (keyof typeof contract.bridgeMethods)[];
  for (const supported of methods) {
    const native = installBridge([supported]);
    expect(isInApp()).toBe(true);
    for (const method of methods) {
      if (method === supported) expect(has(method)).not.toBeNull();
      else expect(has(method)).toBeNull();
    }
    expect(native.postMessage).not.toHaveBeenCalled();
  }
});

it('[AC-F1-01b#4] 能力以当前注入对象为准：注入、移除均不沿用旧探测结果', () => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  expect(has('ui.toast')).toBeNull();
  installBridge(['ui.toast']);
  expect(has('ui.toast')).not.toBeNull();
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  expect(isInApp()).toBe(false);
  expect(has('ui.toast')).toBeNull();
});

it('[AC-F1-01b#5] App 外无类型入口拒绝为 90001', async () => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  await expect(outcome(() => invoke('ui.toast', { text: 'test' }))).rejects.toMatchObject({
    code: 90001,
    msg: expect.any(String),
  });
});

it('[AC-F1-01b#6] 已取得句柄后离开 App，call 也拒绝为 90001', async () => {
  const native = installBridge(['ui.toast']);
  const cap = has('ui.toast');
  expect(cap).not.toBeNull();
  if (cap === null) return;
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  await expect(outcome(() => call(cap, { text: 'test' }))).rejects.toMatchObject({
    code: 90001,
    msg: expect.any(String),
  });
  expect(native.postMessage).not.toHaveBeenCalled();
});

it('[AC-F1-01b#7] 无类型入口对未知方法和原生未支持方法返回同一 90001 形状', async () => {
  const native = installBridge(['ui.toast', 'future.unknown']);
  for (const method of ['future.unknown', 'auth.getUser']) {
    await expect(outcome(() => invoke(method, {}))).rejects.toMatchObject({
      code: 90001,
      msg: expect.any(String),
    });
  }
  expect(native.postMessage).not.toHaveBeenCalled();
});
