import type { BridgeMethods, BridgeRequest, BridgeResponse } from '@couli/bridge-sdk';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { installBridge } from '../bridge-sdk/kit.ts';
import { reply, server } from '../h5-notices/fixtures.ts';

export { reply } from '../h5-notices/fixtures.ts';
export type EarningsSummary = components['schemas']['EarningsSummary'];
export type EarningsPeriod = components['schemas']['EarningsPeriod'];
export type PeriodKey = 'today' | 'yesterday' | 'this_month' | 'last_month';
export const PERIODS: readonly PeriodKey[] = ['today', 'yesterday', 'this_month', 'last_month'];
export const SUMMARY_PATH = '/v1/earnings/summary';
/** 固定上海当前时刻（BR-TEXT-11 的「今天 / 昨天」按它判断）；与 AC-S2-61 的 CLOCK_NOW 同一天。 */
export const NOW = '2026-11-12T10:05:00+08:00';
export const AS_OF = '2026-11-12T10:00:00+08:00';

const texts = dictionary.texts;
/** 契约字典 contracts/texts.default.json 已有的键（BR-TEXT-01 收益看板表、表 A 错误码、H5 三态）。 */
export const copy = {
  title: texts['earnings.title'],
  self: texts['earnings.section.self'],
  share: texts['earnings.section.share'],
  referral: texts['earnings.section.referral'],
  period: {
    today: texts['earnings.period.today'],
    yesterday: texts['earnings.period.yesterday'],
    this_month: texts['earnings.period.this_month'],
    last_month: texts['earnings.period.last_month'],
  },
  paidCount: texts['earnings.metric.paid_count.name'],
  paidCountHint: texts['earnings.metric.paid_count.hint'],
  estSelf: texts['earnings.metric.est.name_self'],
  estPromo: texts['earnings.metric.est.name_promo'],
  estHint: texts['earnings.metric.est.hint'],
  credited: texts['earnings.metric.credited.name'],
  creditedHint: texts['earnings.metric.credited.hint'],
  referralNote: texts['earnings.referral.note'],
  platformNote: texts['earnings.referral.platform_note'],
  emptyHint: texts['earnings.empty_hint'],
  asOf: texts['earnings.as_of'],
  closed: texts['error.30701'],
  outdated: texts['error.10405'],
  loadFailed: texts['h5.load_failed'],
} as const;

/** 三栏标题，按页面自上而下的顺序（规格 §2）。 */
export const SECTIONS = [copy.self, copy.share, copy.referral] as const;
/** 平台筛选「全部」胶囊（规格 §2、编排裁定 2；08 无键）。 */
export const ALL = '全部';
/** 平台中文名（08 BR-TEXT-24 表，读屏读平台中文名）。 */
export const platformNames = { taobao: '淘宝', jd: '京东', pdd: '拼多多' } as const;

export function period(paid_count: number, est_fen: number, credited_fen: number): EarningsPeriod {
  return { paid_count, est_fen, credited_fen };
}

/**
 * 全部平台：每栏每期间的数各不相同，读错期间或读错栏都会对不上。金额向量按 BR-TEXT-10 手算：
 * 269 → ¥2.69，-520 → -¥5.2，1990 → ¥19.9，300 → ¥3，1001 → ¥10.01，-15 → -¥0.15。
 */
export const summary: EarningsSummary = {
  as_of: AS_OF,
  self: {
    today: period(1, 269, 0),
    yesterday: period(3, 135, 12),
    this_month: period(5, 812, -520),
    last_month: period(7, 1990, 300),
  },
  share: {
    today: period(2, 100, 0),
    yesterday: period(4, 150, 0),
    this_month: period(6, 1001, 61),
    last_month: period(8, 2000, 990),
  },
  referral: {
    this_month: { est_fen: 54, credited_fen: 30 },
    last_month: { est_fen: 77, credited_fen: -15 },
  },
};

/** platform=taobao：自购、分享只算淘宝；邀请栏原样是全部平台合计（BR-FUND-25 细则 platform 筛选）。 */
export const taobaoSummary: EarningsSummary = {
  as_of: AS_OF,
  self: {
    today: period(9, 111, 0),
    yesterday: period(0, 0, 0),
    this_month: period(2, 222, 333),
    last_month: period(1, 444, 0),
  },
  share: {
    today: period(0, 0, 0),
    yesterday: period(0, 0, 0),
    this_month: period(1, 555, 0),
    last_month: period(0, 0, 0),
  },
  referral: summary.referral,
};

const zero = period(0, 0, 0);
/** 新用户：各栏各期间全为 0（AC-S2-61 ⑧ U4）。 */
export const zeroSummary: EarningsSummary = {
  as_of: AS_OF,
  self: { today: zero, yesterday: zero, this_month: zero, last_month: zero },
  share: { today: zero, yesterday: zero, this_month: zero, last_month: zero },
  referral: {
    this_month: { est_fen: 0, credited_fen: 0 },
    last_month: { est_fen: 0, credited_fen: 0 },
  },
};

/** AC-S2-61 ① 的期望响应（CLOCK_NOW=2026-11-12T10:00+08:00 的 U1）。 */
export const acSummary: EarningsSummary = {
  as_of: '2026-11-12T10:00:00+08:00',
  self: {
    today: zero,
    yesterday: zero,
    this_month: period(2, 404, 0),
    last_month: period(2, 520, 0),
  },
  share: {
    today: period(1, 100, 0),
    yesterday: zero,
    this_month: period(1, 100, 0),
    last_month: zero,
  },
  referral: {
    this_month: { est_fen: 54, credited_fen: 0 },
    last_month: { est_fen: 0, credited_fen: 0 },
  },
};

/** /v1/config 中本页读的部分（features.platform_status，编排裁定 2；经桥 app.getConfig 读取）。 */
export function config(
  status: Record<string, string> = { taobao: 'on', jd: 'maintenance', pdd: 'not_launched' },
): Record<string, unknown> {
  return {
    config_version: 'cfg-earnings-1',
    features: {
      flags: { 'earnings.dashboard.visible': true },
      platform_status: status,
      search_status: {},
    },
  };
}

// Browser-safe data, same as the ledger fixture.
const nativeEnv: BridgeMethods['app.getEnv']['result'] = {
  platform: 'android',
  app_version: '2.4.6',
  build: '2468',
  channel: 'official',
  os_version: '15',
  bridge_version: 1,
  safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
};

function requestedKeys(request: BridgeRequest): string[] {
  const keys = (request.params as { keys?: unknown } | undefined)?.keys;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
}

/** Native hands back only the top-level keys the page asked for (a dotted key selects its root). */
function pick(values: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) =>
      keys.some((asked) => asked === key || asked.startsWith(`${key}.`)),
    ),
  );
}

export function defaultSummary(url: URL): Response {
  return reply(url.searchParams.get('platform') === 'taobao' ? taobaoSummary : summary);
}

export interface EarningsServerOptions {
  /** HTTP answer for GET /v1/earnings/summary; `count` counts only summary requests. */
  summary?: (url: URL, count: number) => Response | Promise<Response>;
  /** Values of app.getConfig; default: taobao on, jd maintenance, pdd not_launched. */
  config?: () => Record<string, unknown>;
  /** issueH5Token failed with 10405 on the native side (native owns ForceUpdate). */
  tokenFailure?: 10405;
}

/**
 * Real app API + SDK token manager; only the native bridge and the HTTP boundary are fake. The
 * config comes only through app.getConfig; any other HTTP path (including /v1/config) is 30001.
 * No net.signedRequest capability: the dashboard is not a signed operation.
 */
export function earningsServer(options: EarningsServerOptions = {}) {
  let tokens = 0;
  let summaries = 0;
  const native = installBridge(
    ['app.getEnv', 'app.getConfig', 'auth.getH5Token', 'nav.open', 'ui.toast'],
    async (request) => {
      const ok = (data: unknown): BridgeResponse => ({ id: request.id, code: 0, msg: '', data });
      switch (request.method) {
        case 'app.getEnv':
          return ok(nativeEnv);
        case 'app.getConfig':
          return ok({ values: pick(options.config?.() ?? config(), requestedKeys(request)) });
        case 'auth.getH5Token':
          tokens += 1;
          // 10405 belongs to issueH5Token's HTTP response, not the bridge envelope; a rejected
          // native call is normalized by the SDK (same as the find-order fixture).
          if (options.tokenFailure === 10405)
            throw Object.assign(new Error('PRIVATE native issueH5Token failed'), {
              code: 10405,
              data: { min_supported_version: '9.9.9' },
            });
          return ok({
            token: `earnings-token-${tokens}`,
            scope: 'standard',
            expire_at: '2099-01-01T00:00:00Z',
          });
        default:
          return ok({});
      }
    },
  );
  const http = server((url) => {
    if (url.pathname === SUMMARY_PATH) {
      summaries += 1;
      return options.summary?.(url, summaries) ?? defaultSummary(url);
    }
    return reply(null, 30001, 404);
  });
  const api = createAppApi({
    env: { apiBaseUrl: 'https://api.example.invalid', appId: 'fixture_brand' },
    fetch: http.fetch,
  });
  const calls = (method: string): BridgeRequest[] =>
    native.postMessage.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === method);
  return {
    api,
    requests: http.requests,
    summaryRequests: () =>
      http.requests.filter((request) => new URL(request.url).pathname === SUMMARY_PATH),
    tokenCalls: () => tokens,
    calls,
  };
}

export type EarningsServer = ReturnType<typeof earningsServer>;
