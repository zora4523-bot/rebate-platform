// B1-01zzq: the global onSend of the real HTTP entries (bootstrap createHttpApp, D10-396 ③).
// Probe routes outside the contract put the verified carrier on the request themselves (see
// kit.ts); no database, Redis or listener. Each test also checks a control route, so the hook is
// shown to be active wherever it is shown to leave a response alone.
import { afterEach, expect, it } from 'vitest';
import { NO_STORE, TRACE, cacheControl, entry, type Probe } from './kit.ts';

let app: Awaited<ReturnType<typeof entry>>['app'] | undefined;
afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
  }
}, 30_000);

async function open(name: 'api' | 'admin', probes: readonly Probe[]) {
  const e = await entry(name, probes);
  app = e.app;
  return e;
}

it('[AC-B1-01zzq#6] api：App 令牌与 H5 令牌的请求，成功、错误与无 body 的响应都缺省带 no-store', async () => {
  const e = await open('api', [
    { path: '/__no_store/app', identity: 'app' },
    { path: '/__no_store/h5', identity: 'h5' },
    { path: '/__no_store/app-error', identity: 'app', status: 400 },
    { path: '/__no_store/app-empty', identity: 'app', status: 204, empty: true },
  ]);
  for (const [path, status] of [
    ['/__no_store/app', 200],
    ['/__no_store/h5', 200],
    ['/__no_store/app-error', 400],
    ['/__no_store/app-empty', 204],
  ] as const) {
    const response = await e.get(path);
    expect(response.statusCode, path).toBe(status);
    expect(cacheControl(response), path).toBe(NO_STORE);
    // The existing onSend work is kept.
    expect(response.headers['x-trace-id'], path).toBe(TRACE);
  }
}, 30_000);

it('[AC-B1-01zzq#7] api：路由自己设的 Cache-Control 不被覆盖（带身份或匿名）', async () => {
  const e = await open('api', [
    {
      path: '/__no_store/private',
      identity: 'app',
      cacheControl: ['Cache-Control', 'private, max-age=60'],
    },
    {
      path: '/__no_store/public',
      identity: 'h5',
      cacheControl: ['cache-control', 'public, max-age=300'],
    },
    { path: '/__no_store/no-cache', identity: 'app', cacheControl: ['Cache-Control', 'no-cache'] },
    {
      path: '/__no_store/anon-cached',
      identity: 'none',
      cacheControl: ['Cache-Control', 'public, max-age=300'],
    },
    { path: '/__no_store/control', identity: 'app' },
  ]);
  for (const [path, value] of [
    ['/__no_store/private', 'private, max-age=60'],
    ['/__no_store/public', 'public, max-age=300'],
    ['/__no_store/no-cache', 'no-cache'],
    ['/__no_store/anon-cached', 'public, max-age=300'],
    ['/__no_store/control', NO_STORE],
  ] as const) {
    const response = await e.get(path);
    expect(response.statusCode, path).toBe(200);
    expect(cacheControl(response), path).toBe(value);
  }
}, 30_000);

it('[AC-B1-01zzq#8] api：匿名请求的响应不加 Cache-Control（含 404）', async () => {
  const e = await open('api', [
    { path: '/__no_store/anonymous', identity: 'none' },
    { path: '/__no_store/anonymous-error', identity: 'none', status: 400 },
    { path: '/__no_store/control', identity: 'app' },
  ]);
  for (const [path, status] of [
    ['/__no_store/anonymous', 200],
    ['/__no_store/anonymous-error', 400],
    ['/__no_store/not-registered', 404],
  ] as const) {
    const response = await e.get(path);
    expect(response.statusCode, path).toBe(status);
    expect(cacheControl(response), path).toBeUndefined();
    expect(response.headers['x-trace-id'], path).toBe(TRACE);
  }
  const control = await e.get('/__no_store/control');
  expect(control.statusCode).toBe(200);
  expect(cacheControl(control)).toBe(NO_STORE);
}, 30_000);

it('[AC-B1-01zzq#9] admin：后台会话的请求缺省带 no-store，路由已设的不覆盖，匿名不加', async () => {
  const e = await open('admin', [
    { path: '/__no_store/session', identity: 'admin' },
    { path: '/__no_store/session-error', identity: 'admin', status: 403 },
    {
      path: '/__no_store/session-cached',
      identity: 'admin',
      cacheControl: ['Cache-Control', 'private, max-age=30'],
    },
    { path: '/__no_store/anonymous', identity: 'none' },
  ]);
  for (const [path, status, value] of [
    ['/__no_store/session', 200, NO_STORE],
    ['/__no_store/session-error', 403, NO_STORE],
    ['/__no_store/session-cached', 200, 'private, max-age=30'],
    ['/__no_store/anonymous', 200, undefined],
  ] as const) {
    const response = await e.get(path);
    expect(response.statusCode, path).toBe(status);
    expect(cacheControl(response), path).toBe(value);
    expect(response.headers['x-trace-id'], path).toBe(TRACE);
  }
}, 30_000);
