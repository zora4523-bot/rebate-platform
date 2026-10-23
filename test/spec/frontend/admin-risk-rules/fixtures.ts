import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { BASE_URL, TRACE_ID } from '../admin-data/fixtures.ts';

export { BASE_URL };
export type Rule = Schema<'AdminRiskRule'>;
export const LIST = '/admin/v1/risk-rules';
export const VERIFY = '/admin/v1/auth/step-up';
export const TARGET = 'DEVICE_REGISTER_LIMIT';
export const THRESHOLDS = ['risk.device_register_limit', 'risk.device_login_accounts_limit'];
export const DISABLE = `${LIST}/${TARGET}/disable`;
export const ENABLE = `${LIST}/${TARGET}/enable`;
export const NAMES = {
  enabled: '字典测试：参与判断',
  disabled: '字典测试：停止判断',
  pass: '字典测试：直接通过',
  manual_review: '字典测试：交给人工',
  block: '字典测试：阻止操作',
  void_commission: '字典测试：佣金失效',
};

export function item(patch: Partial<Rule> = {}): Rule {
  return {
    rule_id: TARGET,
    scene: 'register',
    name: '同设备注册上限',
    risk_action: 'block',
    status: 'enabled',
    threshold_keys: [...THRESHOLDS],
    version: 7,
    // The Beijing date differs from UTC; catches host-local and date-only formatting.
    updated_at: '2026-10-22T19:04:05Z',
    ...patch,
  };
}
export function rows(): Rule[] {
  return [
    item(),
    item({
      rule_id: 'inv_08_self',
      name: '开放场景规则',
      scene: 'future_scene_v2',
      risk_action: 'void_commission',
      status: 'disabled',
      threshold_keys: [],
      version: 0,
    }),
    item({
      rule_id: 'REVIEW_LOGIN',
      name: '人工复核规则',
      scene: 'login',
      risk_action: 'manual_review',
      threshold_keys: [],
    }),
    item({ rule_id: 'PASS_REGISTER', name: '放行规则', risk_action: 'pass', threshold_keys: [] }),
  ];
}
export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;
export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
export function failure(code: number, data: unknown = null): Response {
  // Deliberately generic: the page must interpret the error code and structured data.
  return Response.json(
    { code, msg: '请求未完成', data, trace_id: TRACE_ID },
    {
      status: code === 10403 ? 403 : 400,
    },
  );
}

/** Contract-shaped in-process server; no network, production service or backend assertions. */
export function createServer(initial = rows()) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let verification = 0;
  let consumed = 0;
  let pending = 0;
  function normal(request: RequestLog): Response {
    if (request.method === 'GET' && request.path === LIST) return ok({ items: state });
    if (request.method === 'POST' && request.path === VERIFY) {
      const body = request.body as Schema<'AdminStepUpRequest'>;
      if (body?.tier !== 'totp' || body.code !== '123456') return failure(20002);
      verification += 1;
      return ok({
        step_up_token: `test-totp-${verification}`,
        tier: 'totp',
        expire_at: '2099-01-01T00:00:00Z',
      });
    }
    const match = /^\/admin\/v1\/risk-rules\/([^/]+)\/(enable|disable)$/.exec(request.path);
    if (request.method === 'POST' && match) {
      if (
        verification === consumed ||
        request.headers.get('X-Step-Up-Token') !== `test-totp-${verification}`
      )
        return failure(10003, { tier: 'totp' });
      consumed = verification;
      const entry = state.find((value) => value.rule_id === decodeURIComponent(match[1]!));
      if (!entry) return failure(20001, { fields: ['rule_id'] });
      const body = request.body as Schema<'AdminRiskRuleStatusChangeRequest'>;
      if (body?.expected_version !== entry.version)
        return failure(20902, { resource: 'risk_rule' });
      if (body.reason !== undefined && (body.reason.length === 0 || body.reason.length > 200))
        return failure(20001, { fields: ['reason'] });
      const target = match[2] === 'enable' ? 'enabled' : 'disabled';
      if (entry.status !== target) {
        entry.status = target;
        entry.version += 1;
        entry.updated_at = '2026-10-23T03:06:07Z';
      }
      return ok(entry);
    }
    return failure(20001, { fields: ['path'] });
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    log.push(request);
    pending += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      pending -= 1;
    }
  };
  return {
    state,
    log,
    fetch,
    get pending() {
      return pending;
    },
    requests(method: string, path?: string) {
      return log.filter(
        (request) => request.method === method && (path === undefined || request.path === path),
      );
    },
    writes() {
      return log.filter((request) => request.method !== 'GET' && request.path !== VERIFY);
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
    hold(method: string, path: string) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return normal(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
