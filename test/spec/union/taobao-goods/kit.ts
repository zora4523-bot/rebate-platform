import { inspect } from 'node:util';
import { expect, vi, type Mock } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  TaobaoPriceOptions,
  TaobaoPriceSettingsReader,
} from '../../../../apps/api/src/modules/union/domain/taobao-price.ts';
import {
  UnionError,
  type CallCtx,
  type ItemRef,
  type RegisteredPlatform,
  type UnionEndpoint,
  type UnionErrorCode,
  type UnionMode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoAdapterOptions,
  type TaobaoCredentials,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';

// Task-local AC labels ([AC-B1-04l#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：报文只按任务书第 9 节「已录形状」的字段名 / 类型 / 嵌套构造，取值全部是合成的掩码形状
// （ID、链接、口令、标题、类目、价格），不是任何录制原值；不读私有录制、不联网、不监听端口。
// app_key / secret 是低熵合成串。

export const DETAIL = 'taobao.tbk.item.info.upgrade.get';
export const DETAIL_ENVELOPE = 'tbk_item_info_upgrade_get_response';
export const TPWD = 'taobao.tbk.tpwd.create';
export const TPWD_ENVELOPE = 'tbk_tpwd_create_response';
export const SPREAD = 'taobao.tbk.spread.get';
export const SPREAD_ENVELOPE = 'tbk_spread_get_response';

/** TOP public parameters (B1-04j); everything else in the form is a business parameter. */
export const PUBLIC_FIELDS: readonly string[] = [
  'method',
  'app_key',
  'timestamp',
  'format',
  'v',
  'sign_method',
  'sign',
];

export const APP_KEY = 'synthetic-goods-key';
export const SECRET = 'goods-goods-goods-goods';
export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-goods.invalid/router/rest',
  quotaKey: 'synthetic-taobao-goods',
};
export const instant = '2026-10-31T09:00:00.000Z';
export const nowMs = Date.parse(instant);
export const DAY_MS = 86_400_000;
export const ctx: CallCtx = {
  appId: 'synthetic-goods-app',
  requestId: 'synthetic-goods-request',
  purpose: 'online',
};

/** New-format style synthetic item id (letters, digits, a "-" segment). */
export const ITEM_ID = 'SyNth3t1c-4012345678';
export const ref: ItemRef = { platform: 'taobao', item_id: ITEM_ID };

export const MAIN_IMAGE = 'https://img.synthetic.invalid/bao/main-0001.jpg';
export const WHITE_IMAGE = 'https://img.synthetic.invalid/bao/white-0001.png';
export const SMALL_IMAGES: readonly string[] = [
  'https://img.synthetic.invalid/bao/small-0001.jpg',
  'https://img.synthetic.invalid/bao/small-0002.jpg',
];
/** Seller id beyond Number.MAX_SAFE_INTEGER (18–19 digits upstream); written raw into the body. */
export const SELLER_ID_TEXT = '2219876543210987654';
const SELLER_PLACEHOLDER = '"__synthetic_seller_id__"';

export const SHORT_LINK = 'https://s.click.taobao.com/SyNtHeTiCs01';
export const SHARE_PASSWORD = '￥SyNtHeTiC01￥';
export const SHARE_MODEL = `【合成商品标题】${SHORT_LINK} ${SHARE_PASSWORD} 合成分享文本`;

export type Row = Record<string, unknown>;

/** A promotion path entry (yuan strings, 13-digit millisecond strings), valid around the instant. */
export function promotion(title: string, fee: string, id: string, overrides: Row = {}): Row {
  return {
    promotion_title: title,
    promotion_fee: fee,
    promotion_id: id,
    promotion_start_time: String(nowMs - DAY_MS),
    promotion_end_time: String(nowMs + DAY_MS),
    ...overrides,
  };
}

export interface RowParts {
  readonly top?: Row;
  readonly basic?: Row;
  readonly price?: Row;
  readonly publish?: Row;
  /** Replaces the promotion path entries (wrapped as final_promotion_path_map_data). */
  readonly promotions?: readonly Row[];
}

/**
 * One TbkItemDetail (10-06 material-search shape). Defaults: discount price 59.90, a 商品券 of
 * 10.00 and an 88VIP item of 5.00, promotion final price 44.90; commission_rate "2050"
 * (income_rate deliberately differs, it must not be used); reserve_price is not the price.
 */
export function detailRow(parts: RowParts = {}): Row {
  const promotions = parts.promotions ?? [
    promotion('商品券', '10.00', 'syn-coupon-0001'),
    promotion('88VIP', '5.00', 'syn-member-0001'),
  ];
  return {
    item_id: ITEM_ID,
    item_basic_info: {
      title: '合成详情商品',
      pict_url: MAIN_IMAGE,
      white_image: WHITE_IMAGE,
      small_images: { string: [...SMALL_IMAGES] },
      level_one_category_id: 50008090,
      level_one_category_name: '合成一级类目',
      seller_id: '__synthetic_seller_id__',
      user_type: 1,
      ...parts.basic,
    },
    price_promotion_info: {
      zk_final_price: '59.90',
      reserve_price: '99.00',
      final_promotion_price: '44.90',
      final_promotion_path_list: { final_promotion_path_map_data: [...promotions] },
      ...parts.price,
    },
    publish_info: {
      income_rate: '18.00',
      income_info: { commission_rate: '2050' },
      click_url: 'https://s.click.taobao.com/t?e=synthetic-click',
      ...parts.publish,
    },
    ...parts.top,
  };
}

/** Raw detail body; `results` holds the rows under one wrapper key of any name. */
export function detailBody(rows: readonly Row[], wrapper = 'tbk_item_detail'): string {
  const inner = { results: { [wrapper]: rows }, request_id: 'synthetic-request-id' };
  const text = JSON.stringify({ [DETAIL_ENVELOPE]: inner });
  // The seller id goes into the wire text as a bare integer literal beyond the safe range.
  return text.split(SELLER_PLACEHOLDER).join(SELLER_ID_TEXT);
}

export function shareBody(data: unknown): unknown {
  return { [TPWD_ENVELOPE]: { data, request_id: 'synthetic-request-id' } };
}

export function shareData(overrides: Row = {}): Row {
  return { model: SHARE_MODEL, password_simple: SHARE_PASSWORD, ...overrides };
}

export function spreadBody(items: readonly Row[]): unknown {
  return {
    [SPREAD_ENVELOPE]: {
      results: { tbk_spread: items },
      total_results: items.length,
      request_id: 'synthetic-request-id',
    },
  };
}

export function errorBody(code: number | string, subCode?: number | string): unknown {
  const sub = subCode === undefined ? {} : { sub_code: subCode, sub_msg: '合成错误说明' };
  return {
    error_response: {
      code,
      msg: 'synthetic remote error',
      ...sub,
      request_id: 'synthetic-error-request',
    },
  };
}

/** The decoded form of a request (lenient: never throws inside the transport). */
export function formOf(request: UnionTransportRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(request.body ?? '')) out[name] = value;
  return out;
}

/** What the fake gateway answers: an object (JSON-encoded), a raw string body, or withStatus. */
export type Reply = (form: Readonly<Record<string, string>>) => unknown;

export interface ReplyWithStatus {
  readonly status: number;
  readonly body: unknown;
}

export function withStatus(status: number, body: unknown = {}): ReplyWithStatus {
  return { status, body };
}

function isWithStatus(value: unknown): value is ReplyWithStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 2 &&
    'status' in value &&
    'body' in value &&
    typeof value.status === 'number'
  );
}

type ReadSettings = (appId: string) => Promise<TaobaoPriceOptions>;
type SettingsFor = (appId: string) => TaobaoPriceOptions;

export interface PriceReader {
  readonly reader: TaobaoPriceSettingsReader;
  readonly read: Mock<ReadSettings>;
}

/** A price settings port answering `answer(appId)`; `read` records every read. */
export function priceReader(answer: SettingsFor = () => ({})): PriceReader {
  const read = vi.fn<ReadSettings>(async (appId) => answer(appId));
  return { reader: { read }, read };
}

export function setup(reply: Reply, overrides: Partial<TaobaoAdapterOptions> = {}) {
  const clock = new FixedClock(instant);
  const credentials = vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
    appKey: APP_KEY,
    appSecret: SECRET,
  }));
  const transport = vi.fn<UnionTransport>(async (request) => {
    const answer = reply(formOf(request));
    const status = isWithStatus(answer) ? answer.status : 200;
    const body = isWithStatus(answer) ? answer.body : answer;
    return {
      status,
      headers: { 'content-type': 'application/json;charset=utf-8' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    };
  });
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

/** A gateway that answers the detail method with `rows` (any other method is refused). */
export function detailSetup(
  rows: readonly Row[] = [detailRow()],
  overrides: Partial<TaobaoAdapterOptions> = {},
  wrapper?: string,
) {
  return setup((form) => {
    if (form['method'] === DETAIL) return detailBody(rows, wrapper);
    return errorBody('synthetic-unexpected-method');
  }, overrides);
}

/** The request the transport received on call `index`. */
export function sent(transport: Mock<UnionTransport>, index = 0): UnionTransportRequest {
  const call = transport.mock.calls[index];
  expect(call, `transport call ${index}`).toBeDefined();
  return call![0];
}

/** Form fields of a sent request other than the TOP public parameters. */
export function businessFields(request: UnionTransportRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(formOf(request))) {
    if (!PUBLIC_FIELDS.includes(name)) out[name] = value;
  }
  return out;
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

/** Every number anywhere inside a value (a bigint is not a number). */
export function numbersIn(value: unknown, seen = new Set<unknown>()): number[] {
  if (typeof value === 'number') return [value];
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => numbersIn(entry, seen));
}

export function visible(value: unknown): string {
  return `${String(value)}\n${inspect(value, { depth: null })}`;
}

/**
 * Registry endpoints: taobao gets `mode`; pdd is replay and jd live (both unimplemented, no
 * credential involved).
 */
export function registryEndpoints(mode: UnionMode = 'live'): readonly UnionEndpoint[] {
  const modes: Readonly<Record<RegisteredPlatform, UnionMode>> = {
    jd: 'live',
    pdd: 'replay',
    taobao: mode,
  };
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => ({
    platform,
    mode: modes[platform],
    baseUrl: modes[platform] === 'demo' ? null : `https://${platform}.invalid/router/rest`,
    quotaKey: `synthetic-goods-registry:${platform}`,
  }));
}
