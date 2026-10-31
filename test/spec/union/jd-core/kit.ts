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
import {
  JdUnionAdapter,
  type JdAdapterOptions,
  type JdCredentials,
  type JdWarning,
} from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import { JdRawNumber } from '../../../../apps/api/src/modules/union/infra/jd/response.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';

// Task-local AC labels ([AC-B1-04za#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：方法名、外层键、app_key、secret 都是合成值，不是任何京东接口的录制或真实凭据；
// secret 是低熵重复串（避免 gitleaks 高熵误报）。期望签名一律由本目录用 node:crypto 按任务书规则独立算出。
export const method = 'jd.union.open.synthetic.get';
/** Spelled `_responce` on the wire; the misspelling is the gateway's own. */
export const envelope = 'jd_union_open_synthetic_get_responce';
export const resultKey = 'queryResult';
export const keys = { envelope, resultKey };
export const endpoint: UnionEndpoint = {
  platform: 'jd',
  mode: 'live',
  // The adapter must use endpoint.baseUrl as given; a deployment points it at the JD gateway.
  baseUrl: 'https://jd-gateway.invalid/routerjson',
  quotaKey: 'jd-example',
};
export const appKey = 'test-jd-app-key';
export const secret = 'plain-plain-plain-plain';
export const otherSecret = 'other-other-other-other';
/** Injected clock instant and the same instant at GMT+8. */
export const instant = '2026-10-30T15:55:42.000Z';
export const beijing = '2026-10-30 23:55:42';
export const formContentType = /^application\/x-www-form-urlencoded;\s*charset=utf-8$/i;
export const ctx: CallCtx = {
  appId: 'app-synthetic',
  requestId: 'req-synthetic',
  purpose: 'online',
};
/** The inner result of a success, as the JSON text the gateway nests. */
export const innerOk = '{"code":200,"message":"success"}';

export function response(body: unknown, status = 200): UnionTransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify(body),
  };
}

/** A gateway answer: outer `code` plus the inner result as a JSON string inside the envelope. */
export function wrapped(innerText = innerOk, outerCode: unknown = '0') {
  return response({ [envelope]: { code: outerCode, [resultKey]: innerText } });
}

export function setup(overrides: Partial<JdAdapterOptions> = {}) {
  const clock = new FixedClock(instant);
  const credentials = vi.fn<() => Promise<JdCredentials>>(async () => ({
    appKey,
    appSecret: secret,
  }));
  const transport = vi.fn<UnionTransport>().mockResolvedValue(wrapped());
  const warn = vi.fn<(event: JdWarning) => void>();
  const adapter = new JdUnionAdapter({
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

/** The signature of one request, its parameters written out in byte order of their names. */
export function expectedSign(
  payload: string,
  signer: {
    readonly appKey?: string;
    readonly secret?: string;
    readonly timestamp?: string;
  } = {},
): string {
  const { appKey: key = appKey, secret: wrap = secret, timestamp = beijing } = signer;
  return md5(
    `${wrap}360buy_param_json${payload}app_key${key}formatjsonmethod${method}sign_methodmd5timestamp${timestamp}v1.0${wrap}`,
  );
}

/** The exact source text of a JSON number in the inner object. */
export function rawText(value: unknown): string {
  expect(value).toBeInstanceOf(JdRawNumber);
  return (value as JdRawNumber).text;
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
  expect(caught).toMatchObject({ code, platform: 'jd' });
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
      platform: 'jd',
      promotionSlot: 'synthetic-slot',
      relationId: null,
    });
  }
}
