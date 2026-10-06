import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createUnionReplayClient,
  loadUnionEndpoints,
  type UnionEndpoint,
  type UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import { platforms, recording, scenario, workspace } from './kit.ts';

const endpoints: readonly UnionEndpoint[] = platforms.map((platform) => ({
  platform,
  mode: 'replay',
  baseUrl: `https://${platform}.synthetic.invalid/synthetic-api/`,
  quotaKey: `synthetic:${platform}`,
}));

it.each(platforms)(
  '[AC-B1-04c-TRANSPORT#1] %s 从独立 JSON 配置取 base URL 并只调用注入传输',
  async (platform) => {
    await workspace(async (root) => {
      const directory = join(root, 'config', 'union-endpoints');
      await mkdir(directory, { recursive: true });
      await Promise.all(
        endpoints.map((value) =>
          writeFile(join(directory, `${value.platform}.json`), JSON.stringify(value)),
        ),
      );
      const transport = vi.fn<UnionTransport>().mockResolvedValue(recording().response);
      const client = createUnionReplayClient({
        endpoints: await loadUnionEndpoints(directory, 'test'),
        transport,
      });
      const controller = new AbortController();
      const result = await client.send(platform, {
        method: 'POST',
        path: 'echo?case=synthetic',
        scenario,
        headers: { 'content-type': 'text/plain', 'x-synthetic': 'synthetic-header' },
        body: 'synthetic-input',
        signal: controller.signal,
      });
      expect(transport).toHaveBeenCalledTimes(1);
      const sent = transport.mock.calls[0]![0];
      expect(sent).toMatchObject({
        platform,
        url: `https://${platform}.synthetic.invalid/synthetic-api/echo?case=synthetic`,
        method: 'POST',
        body: 'synthetic-input',
      });
      expect(sent.signal).toBe(controller.signal);
      const headers = new Headers(sent.headers);
      expect(headers.get('x-scenario')).toBe(scenario);
      expect(headers.get('content-type')).toBe('text/plain');
      expect(headers.get('x-synthetic')).toBe('synthetic-header');
      expect(result).toEqual(recording().response);
    });
  },
);

it.each(['X-Scenario', 'x-scenario', 'X-SCENARIO'])(
  '[AC-B1-04c-TRANSPORT#2] 场景参数覆盖调用方 %s 请求头且不修改输入',
  async (header) => {
    const transport = vi.fn<UnionTransport>().mockResolvedValue(recording().response);
    const client = createUnionReplayClient({ endpoints, transport });
    const headers = Object.freeze({ [header]: 'synthetic-wrong' });
    await client.send('jd', { method: 'GET', path: 'echo', scenario, headers });
    const sent = transport.mock.calls[0]![0];
    expect(new Headers(sent.headers).get('x-scenario')).toBe(scenario);
    expect(
      Object.keys(sent.headers).filter((name) => name.toLowerCase() === 'x-scenario'),
    ).toHaveLength(1);
    expect(headers[header]).toBe('synthetic-wrong');
    expect(sent.method).toBe('GET');
    expect(sent.body).toBeUndefined();
  },
);

it('[AC-B1-04c-TRANSPORT#3] 传输的非成功响应与异常不被替换成演示成功结果', async () => {
  const response = {
    status: 503,
    headers: { 'x-synthetic': 'synthetic-error' },
    body: 'synthetic-unavailable',
  };
  const failure = new Error('synthetic-transport-failure');
  const transport = vi
    .fn<UnionTransport>()
    .mockResolvedValueOnce(response)
    .mockRejectedValueOnce(failure);
  const client = createUnionReplayClient({ endpoints, transport });
  const input = { method: 'GET', path: 'echo', scenario } as const;
  expect(await client.send('jd', input)).toEqual(response);
  await expect(client.send('jd', input)).rejects.toBe(failure);
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each([
  'https://other.invalid/echo',
  '//other.invalid/echo',
  '../escape',
  '/absolute',
  'echo#fragment',
])('[AC-B1-04c-TRANSPORT#4] 拒绝绕过配置 base URL 的路径 %s', async (path) => {
  const transport = vi.fn<UnionTransport>();
  const client = createUnionReplayClient({ endpoints, transport });
  await expect(client.send('jd', { method: 'GET', path, scenario })).rejects.toMatchObject({
    code: 'invalid_replay_request',
  });
  expect(transport).not.toHaveBeenCalled();
});
