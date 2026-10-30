import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { expect, vi, type Mock } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  UnionIdentity,
  type CallCtx,
  type UnionEndpoint,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoAdapterOptions,
  type TaobaoCredentials,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';

// Task-local AC labels ([AC-B1-04j#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：方法名、外层键、app_key、secret 都是合成值，不是任何淘宝接口的录制或真实凭据；
// secret 是低熵重复串（避免 gitleaks 高熵误报）。期望签名一律由本目录用 node:crypto 按任务书规则独立算出。
export const method = 'taobao.tbk.synthetic.get';
export const envelope = 'tbk_synthetic_get_response';
export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  // The adapter must use endpoint.baseUrl as given; a deployment points it at eco.taobao.com.
  baseUrl: 'https://taobao-gateway.invalid/router/rest',
  quotaKey: 'taobao-example',
};
export const appKey = 'test-app-key';
export const secret = 'plain-plain-plain-plain';
export const otherSecret = 'other-other-other-other';
/** Injected clock instant and the same instant in Beijing time (UTC+8). */
export const instant = '2026-10-30T15:55:42.000Z';
export const beijing = '2026-10-30 23:55:42';
export const formContentType = /^application\/x-www-form-urlencoded;\s*charset=utf-8$/i;
export const ctx: CallCtx = {
  appId: 'app-synthetic',
  requestId: 'req-synthetic',
  purpose: 'online',
};

export function response(body: unknown, status = 200): UnionTransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify(body),
  };
}

export function ok(inner: unknown = {}): UnionTransportResponse {
  return response({ [envelope]: inner });
}

export function setup(overrides: Partial<TaobaoAdapterOptions> = {}) {
  const clock = new FixedClock(instant);
  const credentials = vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
    appKey,
    appSecret: secret,
  }));
  const transport = vi.fn<UnionTransport>().mockResolvedValue(ok());
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const adapter = new TaobaoUnionAdapter({
    clock,
    credentials,
    transport,
    endpoint,
    warn,
    ...overrides,
  });
  return { adapter, clock, credentials, transport, warn };
}

/** The request the transport received on call `index`. */
export function sent(transport: Mock<UnionTransport>, index = 0): UnionTransportRequest {
  const call = transport.mock.calls[index];
  expect(call, `transport call ${index}`).toBeDefined();
  return call![0];
}

/** The decoded form body; every field name must appear exactly once. */
export function formFields(request: UnionTransportRequest): Record<string, string> {
  expect(request.body).toBeTypeOf('string');
  const out: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(request.body ?? '')) {
    expect(Object.hasOwn(out, name), `form field ${name} appears once`).toBe(false);
    out[name] = value;
  }
  return out;
}

export function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

export async function unionFailure(
  run: () => unknown | Promise<unknown>,
  code: UnionErrorCode,
): Promise<UnionError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnionError);
  expect(caught).toMatchObject({ code, platform: 'taobao' });
  return caught as UnionError;
}

export function expectRedacted(value: unknown, markers: readonly string[]): void {
  const visible = `${String(value)}\n${JSON.stringify(value)}\n${inspect(value, { depth: null })}`;
  for (const marker of markers) expect(visible).not.toContain(marker);
}

/** Trusted server identity fixture for convert; synthetic values only. */
export class TestIdentity extends UnionIdentity {
  constructor() {
    super({
      appId: 'app-synthetic',
      userId: 'user-synthetic',
      platform: 'taobao',
      promotionSlot: 'synthetic-slot',
      relationId: null,
    });
  }
}
