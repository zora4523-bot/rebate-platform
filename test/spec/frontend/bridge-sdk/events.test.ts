// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { on } from '@couli/bridge-sdk';
import { installBridge } from './kit.ts';
import type { BridgeEvent } from '@couli/bridge-sdk';

afterEach(() => vi.unstubAllGlobals());

it('[AC-F1-01b#14] 按契约事件名分发 data，多个订阅者互不覆盖，取消订阅只移除自身', () => {
  const native = installBridge([]);
  const first = vi.fn();
  const second = vi.fn();
  const auth = vi.fn();
  const stopFirst = on('app.resume', first);
  const stopSecond = on('app.resume', second);
  const stopAuth = on('auth.changed', auth);
  native.emit({ event: 'app.pause', data: {} });
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  native.emit({ event: 'app.resume', data: {} });
  expect(first).toHaveBeenCalledExactlyOnceWith({});
  expect(second).toHaveBeenCalledExactlyOnceWith({});
  expect(auth).not.toHaveBeenCalled();
  stopFirst();
  stopFirst();
  native.emit({ event: 'app.resume', data: {} });
  native.emit({ event: 'auth.changed', data: { logged_in: false } });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
  expect(auth).toHaveBeenCalledExactlyOnceWith({ logged_in: false });
  stopSecond();
  stopAuth();
  native.emit({ event: 'app.resume', data: {} });
  native.emit({ event: 'auth.changed', data: { logged_in: true } });
  expect(second).toHaveBeenCalledTimes(2);
  expect(auth).toHaveBeenCalledTimes(1);
  expect(native.postMessage).not.toHaveBeenCalled();
});

const events = [
  { event: 'app.resume', data: {} },
  { event: 'app.pause', data: {} },
  { event: 'auth.changed', data: { logged_in: true } },
  { event: 'page.visible', data: { visible: false } },
] satisfies BridgeEvent[];

it.each(events)('[AC-F1-01b#15] 契约事件 $event 可以独立订阅和取消', (event) => {
  const native = installBridge([]);
  const listener = vi.fn();
  const stop = on(event.event, listener);
  native.emit(event);
  expect(listener).toHaveBeenCalledExactlyOnceWith(event.data);
  stop();
  native.emit(event);
  expect(listener).toHaveBeenCalledTimes(1);
});
