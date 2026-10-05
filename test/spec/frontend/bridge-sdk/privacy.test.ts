// @vitest-environment jsdom
// BR-ID-32 / 03 §5.4: exercise acquisition, cache hits, refresh and invalidation.
import { afterEach, expect, it, vi } from 'vitest';
import { createH5TokenManager } from '@couli/bridge-sdk';
import { token, tokenBridge } from './kit.ts';
import type { H5ApiResponse } from '@couli/bridge-sdk';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = 'bridge_fixture=; Max-Age=0; Path=/';
});

it('[AC-F1-01b#30] 缓存、续取、只读失效、invalidate 全程不读写持久存储、不改 URL、不传别的页面', async () => {
  const local = window.localStorage;
  const session = window.sessionStorage;
  local.setItem('fixture', 'unrelated-local');
  session.setItem('fixture', 'unrelated-session');
  document.cookie = 'bridge_fixture=unrelated-cookie; Path=/';
  const before = {
    local: { ...local },
    session: { ...session },
    cookie: document.cookie,
    url: window.location.href,
  };
  const localRead = vi.spyOn(window, 'localStorage', 'get');
  const sessionRead = vi.spyOn(window, 'sessionStorage', 'get');
  const cookieRead = vi.spyOn(document, 'cookie', 'get');
  const cookieWrite = vi.spyOn(document, 'cookie', 'set');
  const storageRead = vi.spyOn(Storage.prototype, 'getItem');
  const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
  const storageRemove = vi.spyOn(Storage.prototype, 'removeItem');
  const storageClear = vi.spyOn(Storage.prototype, 'clear');
  const idbOpen = vi.fn();
  const idbDelete = vi.fn();
  vi.stubGlobal('indexedDB', { open: idbOpen, deleteDatabase: idbDelete });
  const pushState = vi.spyOn(window.history, 'pushState');
  const replaceState = vi.spyOn(window.history, 'replaceState');
  const openPage = vi.spyOn(window, 'open').mockReturnValue(null);
  const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const broadcast = vi.fn();
  vi.stubGlobal('BroadcastChannel', broadcast);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);

  const original = token('read_only', 'private-original');
  const upgraded = token('standard', 'private-upgraded');
  const renewed = token('standard', 'private-renewed');
  const afterDenial = token('read_only', 'private-after-denial');
  const native = tokenBridge(original, upgraded, renewed, afterDenial);
  const manager = createH5TokenManager();
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(original);
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(original);
  await expect(manager.getToken({ forWrite: true })).resolves.toEqual(upgraded);
  const send = vi
    .fn<(value: string) => Promise<H5ApiResponse>>()
    .mockResolvedValueOnce({ code: 10002, msg: 'expired' })
    .mockResolvedValueOnce({ code: 0, msg: '', data: {} })
    .mockResolvedValueOnce({ code: 10403, msg: 'restricted', data: { reason: 'h5_read_only' } });
  await manager.request('GET', send);
  await manager.request('POST', send);
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(afterDenial);
  manager.invalidate();
  expect(native.postMessage).toHaveBeenCalledTimes(4);
  expect(send.mock.calls).toEqual([[upgraded.token], [renewed.token], [renewed.token]]);
  for (const observer of [
    localRead,
    sessionRead,
    cookieRead,
    cookieWrite,
    storageRead,
    storageWrite,
    storageRemove,
    storageClear,
    idbOpen,
    idbDelete,
    pushState,
    replaceState,
    openPage,
    postMessage,
    broadcast,
    fetch,
  ])
    expect(observer).not.toHaveBeenCalled();

  vi.restoreAllMocks();
  expect({
    local: { ...local },
    session: { ...session },
    cookie: document.cookie,
    url: window.location.href,
  }).toEqual(before);
});

it('[AC-F1-01b#31] 页面生命周期各自创建的 manager 不共享令牌，按原生当前状态取得 read_only', async () => {
  const old = token('standard', 'old-page');
  const fresh = token('read_only', 'new-page');
  const native = tokenBridge(old, fresh);
  const pageOne = createH5TokenManager();
  await expect(pageOne.getToken({ forWrite: false })).resolves.toEqual(old);
  const pageTwo = createH5TokenManager();
  await expect(pageTwo.getToken({ forWrite: false })).resolves.toEqual(fresh);
  pageOne.invalidate();
  await expect(pageTwo.getToken({ forWrite: false })).resolves.toEqual(fresh);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
});
