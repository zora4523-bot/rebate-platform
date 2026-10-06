// Unit checks for edge paths the rule tests do not pin: forged handles, malformed replies,
// late replies after a timeout, throwing transports and token discards during acquisition.
import { afterEach, expect, it, vi } from 'vitest';
import * as conformance from './index.conformance.ts';
import * as entry from './index.ts';
import { BridgeError, Capability, call, createH5TokenManager, has, isInApp, on } from './index.ts';
import type { BridgeEvent, BridgeRequest, BridgeResponse } from './index.ts';

type Reply = (request: BridgeRequest) => BridgeResponse | Promise<BridgeResponse> | unknown;

function install(methods: readonly string[], reply: Reply) {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const postMessage = vi.fn(reply);
  vi.stubGlobal('__REBATE_BRIDGE__', {
    version: 1,
    methods,
    postMessage,
    subscribe(listener: (event: BridgeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    postMessage,
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event as BridgeEvent);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('entries export the SDK surface and the conformance invoke', () => {
  expect(entry.PACKAGE_NAME).toBe('@couli/bridge-sdk');
  expect(conformance.ENTRY_NAME).toBe('@couli/bridge-sdk/conformance');
  expect(typeof conformance.invoke).toBe('function');
  expect(Object.keys(entry).sort()).toEqual(
    [
      'BridgeContract',
      'BridgeError',
      'Capability',
      'PACKAGE_NAME',
      'call',
      'createH5TokenManager',
      'has',
      'isInApp',
      'on',
    ].sort(),
  );
});

it('a non-object global is not a bridge', () => {
  vi.stubGlobal('__REBATE_BRIDGE__', 'RebateApp');
  expect(isInApp()).toBe(false);
  vi.stubGlobal('__REBATE_BRIDGE__', { version: 1, methods: 'ui.toast' });
  expect(isInApp()).toBe(true);
  expect(has('ui.toast')).toBeNull();
});

it('handles cannot be constructed or forged at runtime', async () => {
  const native = install(['ui.toast'], (request) => ({ id: request.id, code: 0, msg: '' }));
  const Ctor = Capability as unknown as new (method: string, key: symbol) => unknown;
  expect(() => new Ctor('ui.toast', Symbol('bridge-capability'))).toThrow(TypeError);
  const forged = Object.create(Capability.prototype) as Capability<'ui.toast'>;
  Object.defineProperty(forged, 'method', { value: 'ui.toast' });
  await expect(call(forged, { text: 'x' })).rejects.toMatchObject({ code: 90001 });
  expect(native.postMessage).not.toHaveBeenCalled();
  const cap = has('ui.toast');
  expect(cap).toBeInstanceOf(Capability);
  expect(Object.isFrozen(cap)).toBe(true);
});

it.each([
  ['a non-object reply', () => 'ok'],
  ['a reply for another id', () => ({ id: 'other', code: 0, msg: '' })],
  ['a code outside the bridge range', (r: BridgeRequest) => ({ id: r.id, code: 10001, msg: '' })],
  ['a rejected transport promise', () => Promise.reject(new Error('boom'))],
  [
    'a throwing transport',
    () => {
      throw new Error('boom');
    },
  ],
])('%s ends as 90500', async (_label, reply) => {
  install(['ui.toast'], reply as Reply);
  const cap = has('ui.toast');
  expect(cap).not.toBeNull();
  if (cap === null) return;
  const failure = await call(cap, { text: 'x' }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(BridgeError);
  expect(failure).toMatchObject({ code: 90500, msg: expect.any(String) });
});

it('a reply arriving after the timeout is ignored and success without data resolves to {}', async () => {
  vi.useFakeTimers();
  let late: ((response: BridgeResponse) => void) | undefined;
  install(['clipboard.read', 'ui.toast'], (request) =>
    request.method === 'ui.toast'
      ? { id: request.id, code: 0, msg: '' }
      : new Promise<BridgeResponse>((resolve) => {
          late = (response) => resolve({ ...response, id: request.id });
        }),
  );
  const read = has('clipboard.read');
  const toast = has('ui.toast');
  expect(read).not.toBeNull();
  expect(toast).not.toBeNull();
  if (read === null || toast === null) return;
  const pending = call(read, {}).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(60_000);
  late?.({ id: '', code: 0, msg: '', data: { text: 'late' } });
  await expect(pending).resolves.toMatchObject({ code: 90003 });
  await expect(call(toast, { text: 'x' })).resolves.toEqual({});
});

it('on() outside the App is a no-op and malformed events are ignored', () => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  const stop = on('app.resume', () => {});
  expect(stop).toBeTypeOf('function');
  stop();

  const native = install([], () => undefined);
  const visible = vi.fn();
  const pause = vi.fn();
  const stopVisible = on('page.visible', visible);
  const stopPause = on('app.pause', pause);
  native.emit(null);
  native.emit({ event: 'page.visible', data: { visible: true } });
  native.emit({ event: 'app.pause' });
  expect(visible).toHaveBeenCalledExactlyOnceWith({ visible: true });
  expect(pause).toHaveBeenCalledExactlyOnceWith({});
  stopVisible();
  stopPause();
});

it('concurrent token reads share one acquisition, and invalidate drops a late result', async () => {
  const replies: ((response: BridgeResponse) => void)[] = [];
  const native = install(
    ['auth.getH5Token'],
    (request) =>
      new Promise<BridgeResponse>((resolve) => {
        replies.push((response) => resolve({ ...response, id: request.id }));
      }),
  );
  const token = (suffix: string) => ({
    token: `t-${suffix}`,
    scope: 'standard' as const,
    expire_at: '2099-01-01T00:00:00Z',
  });
  const manager = createH5TokenManager();
  const a = manager.getToken({ forWrite: false });
  const b = manager.getToken({ forWrite: true });
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  replies[0]?.({ id: '', code: 0, msg: '', data: token('one') });
  await expect(a).resolves.toEqual(token('one'));
  await expect(b).resolves.toEqual(token('one'));
  expect(native.postMessage).toHaveBeenCalledTimes(1);

  manager.invalidate();
  const c = manager.getToken({ forWrite: false });
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  manager.invalidate();
  replies[1]?.({ id: '', code: 0, msg: '', data: token('dropped') });
  await expect(c).resolves.toEqual(token('dropped'));
  const d = manager.getToken({ forWrite: false });
  await vi.waitFor(() => expect(replies).toHaveLength(3));
  replies[2]?.({ id: '', code: 0, msg: '', data: token('three') });
  await expect(d).resolves.toEqual(token('three'));
});

it('a request that stays 10002 after renewal drops the renewed token', async () => {
  let n = 0;
  install(['auth.getH5Token'], (request) => {
    n += 1;
    return {
      id: request.id,
      code: 0,
      msg: '',
      data: { token: `t-${n}`, scope: 'standard', expire_at: '2099-01-01T00:00:00Z' },
    };
  });
  const manager = createH5TokenManager();
  const send = vi.fn(async () => ({ code: 10002, msg: 'expired' }));
  await expect(manager.request('get', send)).resolves.toMatchObject({ code: 10002 });
  expect(send.mock.calls).toEqual([['t-1'], ['t-2']]);
  await expect(manager.getToken({ forWrite: false })).resolves.toMatchObject({ token: 't-3' });
});

it('a GET expiring while a read_only write is re-acquiring joins that acquisition', async () => {
  const replies: ((data: unknown) => void)[] = [];
  const native = install(
    ['auth.getH5Token'],
    (request) =>
      new Promise<BridgeResponse>((resolve) => {
        replies.push((data) => resolve({ id: request.id, code: 0, msg: '', data }));
      }),
  );
  const token = (suffix: string, scope: 'standard' | 'read_only') => ({
    token: `t-${suffix}`,
    scope,
    expire_at: '2099-01-01T00:00:00Z',
  });
  const manager = createH5TokenManager();
  const first = manager.getToken({ forWrite: false });
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  replies[0]?.(token('0', 'read_only'));
  await first;

  let expireRead: ((response: { code: number; msg: string }) => void) | undefined;
  const sendRead = vi.fn<(value: string) => Promise<{ code: number; msg: string }>>(
    () =>
      new Promise<{ code: number; msg: string }>((resolve) => {
        expireRead = resolve;
      }),
  );
  const sendWrite = vi.fn<(value: string) => Promise<{ code: number; msg: string }>>(async () => ({
    code: 0,
    msg: '',
  }));
  const read = manager.request('GET', sendRead);
  await vi.waitFor(() => expect(sendRead).toHaveBeenCalledTimes(1));
  const write = manager.request('POST', sendWrite);
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  expireRead?.({ code: 10002, msg: 'expired' });
  // Let the read observe 10002 and look for a token before the shared acquisition resolves.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  sendRead.mockResolvedValueOnce({ code: 0, msg: '' });
  replies[1]?.(token('1', 'standard'));
  await expect(read).resolves.toEqual({ code: 0, msg: '' });
  await expect(write).resolves.toEqual({ code: 0, msg: '' });
  expect(sendRead.mock.calls).toEqual([['t-0'], ['t-1']]);
  expect(sendWrite.mock.calls).toEqual([['t-1']]);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  await expect(manager.getToken({ forWrite: true })).resolves.toEqual(token('1', 'standard'));
  expect(native.postMessage).toHaveBeenCalledTimes(2);
});

it('a read_only denial drops the cached token but keeps an acquisition already in flight', async () => {
  const replies: ((data: unknown) => void)[] = [];
  const native = install(
    ['auth.getH5Token'],
    (request) =>
      new Promise<BridgeResponse>((resolve) => {
        replies.push((data) => resolve({ id: request.id, code: 0, msg: '', data }));
      }),
  );
  const token = (suffix: string, scope: 'standard' | 'read_only') => ({
    token: `t-${suffix}`,
    scope,
    expire_at: '2099-01-01T00:00:00Z',
  });
  const manager = createH5TokenManager();
  const first = manager.getToken({ forWrite: false });
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  replies[0]?.(token('0', 'standard'));
  await first;

  let deny: ((response: { code: number; msg: string; data: unknown }) => void) | undefined;
  const denied = manager.request(
    'POST',
    () =>
      new Promise<{ code: number; msg: string; data: unknown }>((resolve) => {
        deny = resolve;
      }),
  );
  await vi.waitFor(() => expect(deny).toBeTypeOf('function'));
  manager.invalidate();
  const pending = manager.getToken({ forWrite: false });
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  deny?.({ code: 10403, msg: 'restricted', data: { reason: 'h5_read_only' } });
  await expect(denied).resolves.toMatchObject({ code: 10403 });
  const joined = manager.getToken({ forWrite: false });
  replies[1]?.(token('1', 'read_only'));
  await expect(pending).resolves.toEqual(token('1', 'read_only'));
  await expect(joined).resolves.toEqual(token('1', 'read_only'));
  expect(native.postMessage).toHaveBeenCalledTimes(2);
});
