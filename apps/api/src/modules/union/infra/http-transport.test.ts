import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnionError } from '../domain/types.ts';
import { createUnionHttpTransport } from './http-transport.ts';

// 替换运行时 fetch：不开套接字、不监听端口。
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(run: () => Promise<unknown>): Promise<UnionError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UnionError) return error;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it('[AC-B1-04g-UNIT#12] 拒绝跳转，不自行设超时', async () => {
  await createUnionHttpTransport()({
    platform: 'pdd',
    url: 'https://pdd-gateway.invalid/api/router',
    method: 'POST',
    headers: {},
    body: '{}',
  });
  const init = fetchMock.mock.calls[0]![1];
  expect(init?.redirect).toBe('error');
  expect(init?.signal).toBeUndefined();
});

it('[AC-B1-04g-UNIT#13] 非 https 地址在 fetch 前拒绝，错误信息不含地址', async () => {
  const error = await failure(() =>
    createUnionHttpTransport()({
      platform: 'jd',
      url: 'http://private-host.invalid/?k=v',
      method: 'GET',
      headers: {},
    }),
  );
  expect(error).toMatchObject({ code: 'invalid_endpoint', platform: 'jd' });
  expect(error.message).not.toContain('private-host');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('[AC-B1-04g-UNIT#14] 网络错误转为 upstream_unavailable，不挂 cause', async () => {
  fetchMock.mockRejectedValue(new TypeError('fetch failed: raw-detail'));
  const error = await failure(() =>
    createUnionHttpTransport()({
      platform: 'pdd',
      url: 'https://pdd-gateway.invalid/api/router',
      method: 'GET',
      headers: {},
    }),
  );
  expect(error.code).toBe('upstream_unavailable');
  expect(error.message).not.toContain('raw-detail');
  expect(error.cause).toBeUndefined();
});
