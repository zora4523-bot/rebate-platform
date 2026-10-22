import * as sdk from '@couli/bridge-sdk';
import type { BridgeMethods, BridgeRequest } from '@couli/bridge-sdk';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { installBridge } from '../bridge-sdk/kit.ts';
import { reply, server } from '../h5-rules/fixtures.ts';

export { reply };
export const texts = dictionary.texts;
export type Claim = components['schemas']['OrderClaim'];
export type SignedResult = BridgeMethods['net.signedRequest']['result'];
// Browser-safe boundary constants: h5-app-api/kit also re-exports Node-only source readers.
const ENV = { apiBaseUrl: 'https://api.fixture.invalid', appId: 'fixture_brand' };
const NATIVE_ENV: BridgeMethods['app.getEnv']['result'] = {
  platform: 'android',
  app_version: '2.4.6',
  build: '2468',
  channel: 'official',
  os_version: '15',
  bridge_version: 1,
  safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
};
export const ORDER_NO = '3712345678901234567';
export const PAID_DATE = '2026-10-02';
export const NOW = '2026-10-22T12:00:00+08:00';
export const guideTarget = {
  route: 'Help',
  params: { article_id: 'claim-taobao-fixture' },
} as const;
export const config = {
  features: {
    flags: {},
    platform_status: { taobao: 'on', jd: 'on', pdd: 'on' },
  },
  claim: { window_days: 17 },
  help_links: {
    'claim_guide.taobao': guideTarget,
    'claim_guide.pdd': { route: 'Help', params: { article_id: 'claim-pdd-fixture' } },
  },
} satisfies Pick<components['schemas']['Config'], 'features' | 'claim' | 'help_links'>;

export const claims: Claim[] = [
  {
    claim_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5aa0',
    platform: 'taobao',
    order_no: ORDER_NO,
    paid_date: PAID_DATE,
    status: 'manual_review',
    created_at: '2026-10-04T10:15:00+08:00',
    items: [{ sub_order_id: 'child-pending-001', decision: null, reject_reason: null }],
  },
  {
    claim_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5aa1',
    platform: 'taobao',
    order_no: '3798765432109876543',
    paid_date: '2026-10-01',
    status: 'cancelled',
    created_at: '2026-10-02T10:15:00+08:00',
    items: [{ sub_order_id: 'child-auto-002', decision: 'cancelled', reject_reason: null }],
  },
  {
    claim_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5aa2',
    platform: 'jd',
    order_no: '305678901234',
    paid_date: '2026-09-20',
    status: 'approved',
    created_at: '2026-09-28T10:15:00+08:00',
    items: [{ sub_order_id: 'child-approved-003', decision: 'approved', reject_reason: null }],
  },
  {
    claim_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5aa3',
    platform: 'pdd',
    order_no: '260918-098765432109876',
    paid_date: '2026-09-18',
    status: 'rejected',
    created_at: '2026-09-20T10:15:00+08:00',
    items: [
      { sub_order_id: 'child-rejected-004', decision: 'rejected', reject_reason: 'NO_EVIDENCE' },
    ],
  },
];

// §7 design placeholders: no user-side dictionary keys or rebate amount in OrderClaim.
export const pendingText = '客服正在核对，结果会通过消息通知你';
export const autoText = '这笔订单已同步到你的订单列表，无需再找回';
export const noEvidenceText = '没有找到这笔订单经凑狸下单的记录';
export const notInPoolText = '该订单已由平台记录归属，找回已关闭';
export const emptyText = '还没有找回申请';
export const footerText = '只显示你本人提交的找回申请';

export function result(code = 0, data: unknown = claims[0]): SignedResult {
  const status =
    code === 0 ? 200 : code === 30201 ? 404 : code === 10405 ? 403 : code === 20001 ? 400 : 422;
  return {
    status,
    body: {
      code,
      msg: code === 0 ? '' : 'PRIVATE server diagnostics user=other-owner',
      data,
      trace_id: 'claim-fixture',
    },
  };
}

export function fixture(
  options: {
    config?: Pick<components['schemas']['Config'], 'features' | 'claim' | 'help_links'>;
    tokenError?: { code: 90500 | 10405; data?: unknown };
    loadConfig?: () => Promise<BridgeMethods['app.getConfig']['result']>;
    signed?: () => SignedResult | Promise<SignedResult>;
    list?: Parameters<typeof server>[0];
    items?: Claim[];
  } = {},
) {
  const signedRequests: BridgeRequest[] = [];
  const configRequests: BridgeRequest[] = [];
  const tokenRequests: BridgeRequest[] = [];
  const toastRequests: BridgeRequest[] = [];
  const native = installBridge(
    ['app.getEnv', 'app.getConfig', 'auth.getH5Token', 'net.signedRequest', 'nav.open', 'ui.toast'],
    async (request) => {
      let data: unknown;
      switch (request.method) {
        case 'app.getEnv':
          data = NATIVE_ENV;
          break;
        case 'auth.getH5Token':
          tokenRequests.push(request);
          // 10405 belongs to issueH5Token's HTTP response, not the bridge envelope.
          // Native owns ForceUpdate; a rejected native call is normalized to 90500 by the SDK.
          if (options.tokenError?.code === 10405)
            throw Object.assign(
              new Error('PRIVATE native issueH5Token failed'),
              options.tokenError,
            );
          if (options.tokenError)
            return {
              id: request.id,
              code: 90500,
              msg: 'PRIVATE token failure',
              data: options.tokenError.data,
            };
          data = {
            token: 'find-order-memory-token',
            scope: 'standard',
            expire_at: '2099-01-01T00:00:00Z',
          };
          break;
        case 'app.getConfig':
          configRequests.push(request);
          data = options.loadConfig
            ? await options.loadConfig()
            : { values: options.config ?? config };
          break;
        case 'net.signedRequest':
          signedRequests.push(request);
          data = options.signed ? await options.signed() : result();
          break;
        case 'nav.open':
          data = { opened: true };
          break;
        case 'ui.toast':
          toastRequests.push(request);
          data = {};
          break;
        default:
          throw new Error(`Unexpected fixture method ${request.method}`);
      }
      return { id: request.id, code: 0, msg: '', data };
    },
  );
  const manager = sdk.createH5TokenManager();
  const bridge = {
    isInApp: sdk.isInApp,
    has: sdk.has,
    call: sdk.call,
    createH5TokenManager: () => manager,
  };
  const http = server(
    options.list ?? (() => reply({ items: options.items ?? claims, next_cursor: null })),
  );
  const api = createAppApi({ bridge, fetch: http.fetch, env: ENV });
  return {
    native,
    bridge,
    api,
    http,
    signedRequests,
    configRequests,
    tokenRequests,
    toastRequests,
  };
}
