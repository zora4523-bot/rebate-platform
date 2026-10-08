import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import {
  createUnionAuthUrl,
  type UnionAuthUrlInput,
  type UnionAuthUrlService,
} from '../../application/union-auth-url.ts';
import { createDemoUnionAuthApps } from '../../infra/auth-apps.ts';
import { UnionAuthUrlController } from './auth-url.controller.ts';

const TRACE = '0199a3b4-5c6d-7000-8000-0000000000aa';

function request(platform: string, query?: Record<string, string>) {
  return {
    id: 'generated',
    params: { platform },
    ...(query === undefined ? {} : { query }),
    headers: { 'x-trace-id': TRACE, 'x-platform': 'android' },
  };
}

function service() {
  const get = vi.fn<UnionAuthUrlService['get']>(async (input) => ({
    status: 200,
    envelope: { code: 0, msg: 'ok', data: { platform: input.platform }, trace_id: input.traceId },
  }));
  return { get };
}

describe('UnionAuthUrlController', () => {
  it('[AC-B1-06g#8] jd and other platforms are 20001 without calling the use case', async () => {
    const s = service();
    const controller = new UnionAuthUrlController(s);
    await expect(controller.get(request('jd') as never)).rejects.toMatchObject({
      status: 400,
      response: { code: 20001, trace_id: TRACE },
    });
    expect(s.get).not.toHaveBeenCalled();
  });

  it('[AC-B1-06g#4] passes the declared client, installed and trace id; installed stays absent when not given', async () => {
    const s = service();
    const controller = new UnionAuthUrlController(s);
    await controller.get(request('pdd', { installed: 'false' }) as never);
    await controller.get(request('taobao') as never);
    expect(s.get.mock.calls.map(([input]) => input)).toEqual<UnionAuthUrlInput[]>([
      { platform: 'pdd', reportedClient: 'android', installed: 'false', traceId: TRACE },
      { platform: 'taobao', reportedClient: 'android', traceId: TRACE },
    ]);
  });

  it('[AC-B1-06g#5] a refusal of the use case keeps its code and HTTP status', async () => {
    const controller = new UnionAuthUrlController({
      get: async () => ({ status: 422, envelope: { code: 30153, msg: 'x', trace_id: TRACE } }),
    });
    await expect(controller.get(request('taobao') as never)).rejects.toMatchObject({
      status: 422,
      response: { code: 30153 },
    });
  });
});

describe('createUnionAuthUrl without a signed-in user', () => {
  it('[AC-B1-06g#7] a guest gets 10001 before any read or write', async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('database touched');
        },
      },
    ) as unknown as Kysely<DB>;
    const resolve = vi.fn();
    const auth = createUnionAuthUrl({
      db,
      clock: new FixedClock('2026-10-08T00:00:00.000Z'),
      appEnv: 'test',
      callerContext: { current: async () => ({ appId: 'a1', userId: null, deviceId: 'd' }) },
      config: { configValue: async () => null },
      authApps: { resolve },
      pids: { getActivePid: resolve },
    });
    const result = await auth.get({ platform: 'taobao', reportedClient: 'ios', traceId: TRACE });
    expect(result).toEqual({
      status: 401,
      envelope: { code: 10001, msg: expect.any(String), trace_id: TRACE },
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('createDemoUnionAuthApps', () => {
  it('[AC-B1-06g#9] gives a synthetic reference per environment, client and method, never a secret', async () => {
    const apps = createDemoUnionAuthApps();
    const result = await apps.resolve('a1', 'staging', 'harmony', 'sdk_token');
    expect(result).toEqual({ ref: 'demo/staging/taobao/harmony/sdk_token' });
  });

  it('[AC-B1-06g#10] has no production application: prod resolution fails closed', async () => {
    await expect(
      createDemoUnionAuthApps().resolve('a1', 'prod', 'ios', 'web_code'),
    ).rejects.toThrow();
  });
});
