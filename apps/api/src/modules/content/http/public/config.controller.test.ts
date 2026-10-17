import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import { FixedClock, createRootLogger, loadConfig } from '../../../platform/index.ts';
import { ClientConfigService } from '../../application/client-config.ts';
import type { ClientConfig } from '../../domain/client-config.ts';

const VERSION = '0123456789abcdef0123456789abcdef';
const ETAG = `"${VERSION}"`;
const HEADERS = { 'x-app-id': 'unit_app', 'x-platform': 'ios', 'x-app-version': '2.0.0' };

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function start(): Promise<NestFastifyApplication> {
  vi.spyOn(ClientConfigService.prototype, 'read').mockResolvedValue({
    texts: {},
    config_version: VERSION,
  } as unknown as ClientConfig);
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-18T00:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  await app.init();
  return app;
}

function get(target: NestFastifyApplication, extra: Record<string, string> = {}) {
  return target.inject({ method: 'GET', url: '/v1/config', headers: { ...HEADERS, ...extra } });
}

it('[AC-F1-02h] 200 carries the strong ETag equal to data.config_version in quotes', async () => {
  const response = await get(await start());
  expect(response.statusCode).toBe(200);
  expect(response.headers['etag']).toBe(ETAG);
  expect(response.json()).toMatchObject({ code: 0, data: { config_version: VERSION } });
});

it('[AC-F1-02h] a matching If-None-Match answers 304 with no body, ETag and X-Trace-Id', async () => {
  const target = await start();
  for (const header of [ETAG, `W/${ETAG}`, `"x", ${ETAG}`, '*']) {
    const response = await get(target, { 'if-none-match': header });
    expect(response.statusCode).toBe(304);
    expect(response.body).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
    expect(response.headers['etag']).toBe(ETAG);
    expect(response.headers['x-trace-id']).toEqual(expect.any(String));
  }
});

it('[AC-F1-02h] a non-matching If-None-Match answers 200 with the full body', async () => {
  const target = await start();
  for (const header of ['"abc"', VERSION, `w/${ETAG}`]) {
    const response = await get(target, { 'if-none-match': header });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0, data: { config_version: VERSION } });
  }
});

it('[AC-F1-02h] a failed configuration read answers 50001 even with If-None-Match *', async () => {
  const target = await start();
  vi.mocked(ClientConfigService.prototype.read).mockRejectedValueOnce(new Error('down'));
  const response = await get(target, { 'if-none-match': '*' });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({ code: 50001 });
});
