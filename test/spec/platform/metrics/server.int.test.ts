// B1-01zzh brief B.2: startMetricsServer({ host, port, registry }) is its own HTTP listener (not on
// the Nest application, not in the OpenAPI contract). Only GET /metrics answers: 200 with the
// registry's text and content type, rendered per scrape; every other path is 404. Listens on a free
// loopback port, so this is an int test (outside the sandbox).
import { expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  startMetricsServer,
  type MetricsRegistry,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { businessNamesIn, expectProcessMetrics } from './kit.ts';

const HOST = '127.0.0.1';

it('[AC-B1-01zzh#9] 只有 GET /metrics 返回 200 与 registry 文本（每次 scrape 现渲染），其他路径 404，close 后不再监听', async () => {
  let scrape = 0;
  const render = vi.fn(async () => `fixture_scrapes ${++scrape}\n`);
  const registry: MetricsRegistry = {
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
    render,
  };
  const server = await startMetricsServer({ host: HOST, port: 0, registry });
  const base = `http://${HOST}:${server.port}`;
  try {
    expect(server.port).toBeGreaterThan(0);
    for (const n of [1, 2]) {
      const response = await fetch(`${base}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(registry.contentType);
      expect(await response.text()).toBe(`fixture_scrapes ${n}\n`);
    }
    expect(render).toHaveBeenCalledTimes(2);
    for (const path of ['/', '/metrics/extra', '/metricsx', '/v1/health', '/admin/v1/metrics']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
      await response.arrayBuffer();
    }
    const post = await fetch(`${base}/metrics`, { method: 'POST', body: 'x' });
    expect([404, 405]).toContain(post.status);
    await post.arrayBuffer();
    expect(render).toHaveBeenCalledTimes(2);
  } finally {
    await server.close();
  }
  await expect(fetch(`${base}/metrics`)).rejects.toThrow();
});

it('[AC-B1-01zzh#10] 以 api 入口的真实 registry 起服务：/metrics 是 Prometheus 文本，只有进程级指标', async () => {
  const server = await startMetricsServer({
    host: HOST,
    port: 0,
    registry: createMetricsRegistry({ entry: 'api' }),
  });
  try {
    const response = await fetch(`http://${HOST}:${server.port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/plain\b/);
    const text = await response.text();
    expectProcessMetrics(text);
    expect(businessNamesIn(text)).toEqual([]);
  } finally {
    await server.close();
  }
});
