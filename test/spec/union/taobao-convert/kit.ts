import { inspect } from 'node:util';
import { expect, vi, type Mock } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  UnionIdentity,
  type CallCtx,
  type ConvertReq,
  type ConvertResult,
  type IdentityClaims,
  type UnionEndpoint,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DataokeClient,
  type DataokeCredentials,
  type DataokeRandom,
  type DataokeWarning,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoConvertSource,
  type TaobaoCredentials,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';

// Task-local AC labels ([AC-B1-04d#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：网关、商品 ID、推广位、relation_id、链接、淘口令、金额都是合成值；只用编排者给出的
// get-privilege-link 字段名（无原值），不读私有录制。secret 是低熵重复串。传输全在内存中。
// TODO(规划/11 §4.5): 出参字段类型（金额是数字还是字符串等）待大淘客转链录制核对 — blocked on 大淘客录制

export const PRIVILEGE_PATH = '/api/tb-service/get-privilege-link';
export const PRIVILEGE_VERSION = 'v1.3.1';
/** A synthetic https gateway; a deployment wires https://openapi.dataoke.com. */
export const DATAOKE_BASE = 'https://dataoke-convert.invalid';
export const DATAOKE_APP_KEY = 'fake-dataoke-app-key';
export const DATAOKE_SECRET = 'dtk-dtk-dtk-dtk-dtk-dtk';
export const TAOBAO_APP_KEY = 'fake-taobao-app-key';
export const TAOBAO_SECRET = 'plain-plain-plain-plain';
/** The injected clock before the request; the transport may move it while "on the wire". */
export const instant = '2026-11-01T02:03:04.000Z';
export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-convert.invalid/router/rest',
  quotaKey: 'fake-taobao-convert-account',
};
export const ctx: CallCtx = {
  appId: 'fake-convert-app',
  requestId: 'fake-convert-request',
  purpose: 'online',
};

/** The 大淘客 goods id carried on the ItemRef (D10-504), passed as is. */
export const GOODS_ID = 'synthetic-goods-0702';
export const req: ConvertReq = {
  item: { platform: 'taobao', item_id: GOODS_ID },
  idempotencyKey: 'fake-idempotency-key-must-not-leak',
};
/** Synthetic mm_ three-segment promotion slots (self-buy / share). */
export const SELF_SLOT = 'mm_1001_2002_3003';
export const SHARE_SLOT = 'mm_1001_2002_4004';
export const RELATION_ID = 'synthetic-relation-77';
export const USER_ID = 'internal-user-must-not-leak';

/** Structural stand-in for linking's server-built subclass; no linking import in union. */
export class TestIdentity extends UnionIdentity {
  constructor(claims: Partial<IdentityClaims> = {}) {
    super({
      appId: ctx.appId,
      userId: USER_ID,
      platform: 'taobao',
      promotionSlot: SELF_SLOT,
      relationId: RELATION_ID,
      ...claims,
    });
  }
}

export const identity = new TestIdentity();

export const SHORT_URL = 'https://s.click.taobao.com/synthetic-short';
export const COUPON_CLICK_URL = 'https://uland.taobao.com/coupon/edetail?e=synthetic-coupon';
export const KUAIZHAN_URL = 'https://kuaizhan-synthetic.invalid/page-must-not-leak';
export const ITEM_URL = 'https://item.taobao.com/item.htm?id=synthetic-item-url-must-not-leak';
export const UPSTREAM_ITEM_ID = 'synthetic-tb-item-id-must-not-leak';
export const TITLE = 'synthetic-title-must-not-leak';
export const TPWD = '$SynthTpwd01$';
export const LONG_TPWD = 'synthetic long share text $SynthTpwd01$ /';

/** The full documented `data` key set with synthetic values. */
export function privilegeData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actualPrice: '39.90',
    couponClickUrl: COUPON_CLICK_URL,
    couponEndTime: '2026-11-11 23:59:59',
    couponInfo: 'synthetic coupon: 10 off 50',
    couponRemainCount: 70,
    couponStartTime: '2026-11-01 00:00:00',
    couponTotalCount: 100,
    itemId: UPSTREAM_ITEM_ID,
    itemUrl: ITEM_URL,
    kuaiZhanUrl: KUAIZHAN_URL,
    longTpwd: LONG_TPWD,
    maxCommissionRate: '20.50',
    minCommissionRate: '10.50',
    originalPrice: '49.90',
    shortUrl: SHORT_URL,
    title: TITLE,
    tpwd: TPWD,
    ...overrides,
  };
}

/** `privilegeData()` without the named keys. */
export function dataWithout(...keys: string[]): Record<string, unknown> {
  const data = privilegeData();
  for (const key of keys) delete data[key];
  return data;
}

export function response(body: unknown, status = 200): UnionTransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify(body),
  };
}

/** The documented 大淘客 success envelope around `data`. */
export function envelope(data: unknown = privilegeData()): Record<string, unknown> {
  return { time: 1793500984000, code: 0, msg: 'ok', data };
}

export interface SetupOptions {
  /** The whole transport response; default: success envelope around privilegeData(). */
  readonly reply?: UnionTransportResponse;
  /** 'absent' leaves the switch out of the adapter options. Default 'dataoke'. */
  readonly convertSource?: TaobaoConvertSource | 'absent';
  /** Whether the adapter gets the 大淘客 client as orderSource. Default true. */
  readonly withSource?: boolean;
  /** Runs inside the 大淘客 transport, before it answers. */
  readonly onSend?: (clock: FixedClock) => void;
}

export function setup(options: SetupOptions = {}) {
  const clock = new FixedClock(instant);
  const taobaoCredentials = vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
    appKey: TAOBAO_APP_KEY,
    appSecret: TAOBAO_SECRET,
  }));
  const taobaoTransport = vi.fn<UnionTransport>(async () => response({}));
  const dataokeCredentials = vi.fn<() => Promise<DataokeCredentials>>(async () => ({
    appKey: DATAOKE_APP_KEY,
    appSecret: DATAOKE_SECRET,
  }));
  const random = vi.fn<DataokeRandom>().mockReturnValue(42);
  const reply = options.reply ?? response(envelope());
  const dataokeTransport = vi.fn<UnionTransport>(async () => {
    options.onSend?.(clock);
    return reply;
  });
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const dataokeWarn = vi.fn<(event: DataokeWarning) => void>();
  const orderSource = new DataokeClient({
    credentials: dataokeCredentials,
    transport: dataokeTransport,
    clock,
    random,
    baseUrl: DATAOKE_BASE,
    warn: dataokeWarn,
  });
  const convertSource = options.convertSource ?? 'dataoke';
  const adapter = new TaobaoUnionAdapter({
    credentials: taobaoCredentials,
    transport: taobaoTransport,
    clock,
    endpoint,
    warn,
    ...(options.withSource === false ? {} : { orderSource }),
    ...(convertSource === 'absent' ? {} : { convertSource }),
  });
  return {
    adapter,
    clock,
    taobaoCredentials,
    taobaoTransport,
    dataokeCredentials,
    dataokeTransport,
    random,
    warn,
    dataokeWarn,
  };
}

export type Harness = ReturnType<typeof setup>;
export type UrlResult = Extract<ConvertResult, { kind: 'url' }>;

/** The request a transport received on call `index`. */
export function sent(transport: Mock<UnionTransport>, index = 0): UnionTransportRequest {
  const call = transport.mock.calls[index];
  expect(call, `transport call ${index}`).toBeDefined();
  return call![0];
}

/** The decoded query string; every field name must appear exactly once. */
export function queryFields(request: UnionTransportRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new URL(request.url).searchParams) {
    expect(Object.hasOwn(out, name), `query field ${name} appears once`).toBe(false);
    out[name] = value;
  }
  return out;
}

/** The one 大淘客 request of a conversion: GET to the gateway + path, no body. */
export function privilegeRequest(h: Harness): {
  readonly request: UnionTransportRequest;
  readonly fields: Record<string, string>;
} {
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  const request = sent(h.dataokeTransport);
  expect(request.platform).toBe('taobao');
  expect(request.method).toBe('GET');
  expect(request.body).toBeUndefined();
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${DATAOKE_BASE}${PRIVILEGE_PATH}`);
  return { request, fields: queryFields(request) };
}

/** Runs a conversion that must succeed with kind 'url'; any rejection is an assertion failure. */
export async function converted(run: () => Promise<ConvertResult>): Promise<UrlResult> {
  let result: ConvertResult | undefined;
  let failure: unknown;
  try {
    result = await run();
  } catch (error) {
    failure = error;
  }
  expect(failure, 'convert must succeed').toBeUndefined();
  expect(result?.kind).toBe('url');
  return result as UrlResult;
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

/** Everything a value would show when printed, serialized (bigint as text) or inspected. */
export function visible(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? `${item}n` : item,
  );
  return `${String(value)}\n${json}\n${inspect(value, { depth: null })}`;
}

/** Nothing was fetched or sent on either the taobao or the 大淘客 side. */
export function expectNothingSent(h: Harness): void {
  expect(h.dataokeCredentials).not.toHaveBeenCalled();
  expect(h.dataokeTransport).not.toHaveBeenCalled();
  expect(h.random).not.toHaveBeenCalled();
  expect(h.taobaoCredentials).not.toHaveBeenCalled();
  expect(h.taobaoTransport).not.toHaveBeenCalled();
}

/** The only keys a 大淘客 conversion may expose. */
export const ALLOWED_RESULT_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'url',
  'tpwd',
  'long_tpwd',
  'short_url',
  'coupon_click_url',
  'requote',
]);
