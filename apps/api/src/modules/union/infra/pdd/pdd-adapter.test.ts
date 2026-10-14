import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { UnionError, type UnionEndpoint } from '../../domain/types.ts';
import type { UnionTransport } from '../replay.ts';
import { PddUnionAdapter, type PddAdapterOptions } from './pdd-adapter.ts';

const endpoint: UnionEndpoint = {
  platform: 'pdd',
  mode: 'live',
  baseUrl: 'https://pdd-gateway.invalid/api/router',
  quotaKey: 'unit',
};

function setup(overrides: Partial<PddAdapterOptions> = {}) {
  const credentials = vi.fn(async () => ({ clientId: 'unit-client', clientSecret: 'testSecret' }));
  const transport = vi.fn<UnionTransport>().mockResolvedValue({
    status: 200,
    headers: {},
    body: '{"p_id_generate_response":{"ok":true}}',
  });
  const adapter = new PddUnionAdapter({
    credentials,
    transport,
    clock: new FixedClock('2026-10-14T00:00:00.500Z'),
    endpoint,
    ...overrides,
  });
  return { adapter, credentials, transport };
}

async function failure(run: () => Promise<unknown>): Promise<UnionError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UnionError) return error;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it('[AC-B1-04g-UNIT#8] 公共参数与业务参数平铺，timestamp 取注入时钟的秒', async () => {
  const { adapter, transport } = setup();
  expect(await adapter.request('pdd.ddk.goods.pid.generate', { number: 1 })).toEqual({ ok: true });
  const body = JSON.parse(transport.mock.calls[0]![0].body!) as Record<string, unknown>;
  expect(body).toMatchObject({
    type: 'pdd.ddk.goods.pid.generate',
    client_id: 'unit-client',
    timestamp: String(Date.parse('2026-10-14T00:00:00Z') / 1000),
    data_type: 'JSON',
    number: 1,
  });
  expect(body.sign).toMatch(/^[0-9A-F]{32}$/);
  expect(transport.mock.calls[0]![0].body).not.toContain('testSecret');
});

it('[AC-B1-04g-UNIT#9] 业务参数不得占用公共参数名，且不取凭据', async () => {
  const { adapter, credentials, transport } = setup();
  for (const name of ['type', 'client_id', 'timestamp', 'sign', 'data_type']) {
    const error = await failure(() =>
      adapter.request('pdd.ddk.goods.pid.generate', { [name]: 'x' }),
    );
    expect(error.code).toBe('invalid_dto');
  }
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it('[AC-B1-04g-UNIT#10] 未配置网关地址或端点不是 pdd 时拒绝', async () => {
  const { adapter, credentials } = setup({ endpoint: { ...endpoint, baseUrl: null } });
  expect((await failure(() => adapter.request('pdd.ddk.goods.pid.generate', {}))).code).toBe(
    'invalid_endpoint',
  );
  expect(credentials).not.toHaveBeenCalled();
  expect(() => setup({ endpoint: { ...endpoint, platform: 'jd' } })).toThrow(UnionError);
});

it('[AC-B1-04g-UNIT#11] 传输抛出的非 UnionError 转为 upstream_unavailable 且不带原文', async () => {
  const transport = vi.fn<UnionTransport>().mockRejectedValue(new Error('raw-transport-detail'));
  const { adapter } = setup({ transport });
  const error = await failure(() => adapter.request('pdd.ddk.goods.pid.generate', {}));
  expect(error.code).toBe('upstream_unavailable');
  expect(error.message).not.toContain('raw-transport-detail');
  expect(error.cause).toBeUndefined();
});
