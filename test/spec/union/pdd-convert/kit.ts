import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionIdentity,
  type CallCtx,
  type ConvertReq,
  type IdentityClaims,
  type UnionEndpoint,
  type UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';

// AC-B1-04h-* 为任务内验收编号。只按任务书 probe 字段清单构造合成报文，
// 不读取私有录制、不标 doc-derived；传输全在内存中。
export const convertMethod = 'pdd.ddk.goods.promotion.url.generate';
export const queryMethod = 'pdd.ddk.member.authority.query';
export const authorityUrlMethod = 'pdd.ddk.rp.prom.url.generate';
export const ctx: CallCtx = {
  appId: 'synthetic-app',
  requestId: 'synthetic-request',
  purpose: 'online',
};
export const endpoint: UnionEndpoint = {
  platform: 'pdd',
  mode: 'live',
  baseUrl: 'https://synthetic-gateway.invalid/router',
  quotaKey: 'synthetic-pdd-account',
};
export const req: ConvertReq = {
  item: { platform: 'pdd', goods_sign: 'synthetic-goods-sign', goods_id: 'synthetic-id' },
  idempotencyKey: 'synthetic-idempotency',
};
export const custom = { app: 'n', uid: 'attr-synth', sc: 's', lk: 'link-synth' } as const;

/** Structural stand-in for linking's server-built subclass; no linking import in union. */
export class TestIdentity extends UnionIdentity {
  readonly custom_parameters: Readonly<Record<string, string>>;

  constructor(
    parameters: Readonly<Record<string, string>> = custom,
    claims: Partial<IdentityClaims> = {},
  ) {
    super({
      appId: ctx.appId,
      platform: 'pdd',
      promotionSlot: 'synthetic-self-pid',
      userId: 'internal-user-must-not-leak',
      relationId: null,
      ...claims,
    });
    this.custom_parameters = Object.freeze({ ...parameters });
    Object.freeze(this);
  }
}

export const identity = new TestIdentity();
export const mobile = 'https://synthetic-mobile.invalid/landing';
export const mobileShort = 'https://synthetic-mobile.invalid/short';
export const browser = 'https://synthetic-browser.invalid/wechat';
export const schema = 'pinduoduo://synthetic-landing';

export function convertReply(row: Record<string, unknown> = { mobile_url: mobile }) {
  return { goods_promotion_url_generate_response: { goods_promotion_url_list: [row] } };
}

export function authorityReply(row: Record<string, unknown> = { mobile_url: mobile }) {
  return { rp_promotion_url_generate_response: { url_list: [row] } };
}

export function setup(reply: unknown, status = 200) {
  const requests: Record<string, unknown>[] = [];
  const credentials = vi.fn(async () => ({
    clientId: 'synthetic-client',
    clientSecret: 'fake-key',
  }));
  const queryIdentity = vi.fn(async () => ({
    pid: 'synthetic-query-pid',
    customParameters: '{"app":"n","uid":"query-attr","sc":"q"}',
  }));
  const transport = vi.fn<UnionTransport>(async (request) => {
    expect(request.body).toBeTypeOf('string');
    requests.push(JSON.parse(request.body!) as Record<string, unknown>);
    return { status, headers: {}, body: JSON.stringify(reply) };
  });
  const adapter = new PddUnionAdapter({
    credentials,
    queryIdentity,
    transport,
    clock: new FixedClock('2032-04-05T06:07:08.000Z'),
    endpoint,
  });
  return { adapter, transport, credentials, queryIdentity, requests };
}

export const operations = ['convert', 'queryPddAuthority', 'pddAuthorityUrl'] as const;
export type Operation = (typeof operations)[number];

export function successReply(operation: Operation): unknown {
  if (operation === 'convert') return convertReply();
  if (operation === 'queryPddAuthority') return { authority_query_response: { bind: 1 } };
  return authorityReply();
}

export function invoke(adapter: PddUnionAdapter, operation: Operation, who = identity) {
  if (operation === 'convert') return adapter.convert(req, who, ctx);
  return adapter[operation](who, ctx);
}
