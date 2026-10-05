// Cross-file checks of contracts/: the OpenAPI document against contracts/enums and
// contracts/error-codes.yaml, and the operation conventions of 规划/04 §5 (x-auth, x-signed,
// x-idempotent, examples, amounts). Run by codegen.ts in both modes, so `pnpm contracts:check`
// fails on a violation. Returns the list of problems; empty means conforming.
import { readFileSync } from 'node:fs';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef, ErrorCodeDef } from './catalog.ts';
import { openapiFile, routesFile } from './paths.ts';

type Obj = Record<string, unknown>;

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
const SIGN_HEADERS = ['Timestamp', 'Nonce', 'Sign'];

/**
 * OpenAPI enums that mirror an enum of contracts/enums: JSON pointer inside
 * components.schemas → enum name. A new enum-typed schema must be added here.
 */
export const ENUM_BINDINGS: Readonly<Record<string, string>> = {
  PlatformCode: 'platform',
  ClientPlatformCode: 'client_platform',
  InstallChannelCode: 'install_channel',
  SortCode: 'sort',
  RebateBasis: 'rebate_basis',
  Availability: 'availability',
  InstalledState: 'installed_state',
  'JumpStep/properties/type': 'jump_type',
  'SendSmsCodeRequest/properties/purpose': 'sms_purpose',
  'UnionBindingState/properties/status': 'union_binding_status',
  'RiskInfo/properties/state': 'risk_state',
  'Me/properties/identity_level': 'identity_level',
  'Me/properties/realname_status': 'realname_status',
  'ProductTlj/properties/kind': 'tlj_kind',
  'ProductCard/properties/match_tag': 'match_tag',
  'InputHit/properties/kind': 'input_kind',
  StepUpAction: 'step_up_action',
  PlatformSearchStatus: 'platform_search_status',
  LinkPatternCategory: 'link_pattern_category',
  IdempotencyAbandonOutcome: 'idempotency_abandon_outcome',
  DeviceIdSource: 'device_id_source',
  SessionScope: 'session_scope',
  AuthMethod: 'auth_method',
  NoRebateCause: 'no_rebate_cause',
  TipKey: 'tip_key',
  WithdrawalStatus: 'withdrawal_status',
  WithdrawalReviewMode: 'withdrawal_review_mode',
  DeletionStatus: 'deletion_status',
  DeletionCancelReason: 'deletion_cancel_reason',
  OrderStatusGroup: 'order_status_group',
  OrderDisplayStatus: 'display_status',
  OrderReasonCode: 'order_reason',
  OrderTimelineNode: 'order_timeline_node',
  H5TokenScope: 'h5_token_scope',
  LoginProvider: 'login_provider',
  OauthAttemptPurpose: 'oauth_attempt_purpose',
  LinkKind: 'link_kind',
  AppealStatus: 'appeal_status',
  AppealTargetType: 'appeal_target_type',
};

/**
 * The four operations that need step-up and the step_up_action each one's X-Step-Up-Token must
 * carry (规划/04 §5 step-up row; enum step_up_action). An operation in this table must carry
 * `x-step-up` with exactly this value once it is declared; no other operation may carry it.
 * Until the four are declared the check has nothing to match (orchestrator decision D-18).
 */
export const STEP_UP_OPERATIONS: Readonly<Record<string, string>> = {
  withdraw: 'POST /v1/withdrawals',
  payout_account_change: 'PUT /v1/me/payout-account',
  phone_change: 'POST /v1/me/phone',
  account_deletion: 'POST /v1/me/deletion',
};

/**
 * Version gate exceptions (规划/08 BR-ID-01 细则「最低支持版本的接口层拦截」, the only place they
 * are kept; this copy is checked against the contract and follows 08 on any difference). Every
 * other /v1 write operation is gated (true). 「不判定」 operations are written false with the reason
 * in the description (orchestrator decision D-12).
 */
export const GATE_EXCEPTIONS: Readonly<Record<string, 'false' | 'conditional'>> = {
  'POST /v1/devices': 'false',
  'POST /v1/auth/sms-codes': 'conditional',
  'POST /v1/auth/login/sms': 'false',
  'POST /v1/auth/login/wechat': 'false',
  'POST /v1/auth/login/apple': 'false',
  'POST /v1/auth/login/huawei': 'false',
  'POST /v1/auth/refresh': 'false',
  'POST /v1/auth/oauth-attempts': 'conditional',
  'POST /v1/auth/step-up': 'conditional',
  'POST /v1/auth/logout': 'false',
  'POST /v1/consents': 'conditional',
  'POST /v1/me/deletion': 'false',
  'POST /v1/me/deletion/cancel': 'false',
  'POST /v1/idempotency-keys/abandon': 'conditional',
  'POST /v1/landing/sms-codes': 'false',
  'POST /v1/invites/landing-register': 'false',
  'POST /v1/share-pages/{link_id}/tpwd': 'false',
};

/**
 * Operations a deletion_only session may call (BR-ID-01 细则「受限会话」 table; 08 wins on any
 * difference): marked x-session-scopes [full, deletion_only]. The conditional ones accept it for
 * some request bodies only and say which in the description.
 */
export const DELETION_ONLY_SCOPE: Readonly<Record<string, 'always' | 'conditional'>> = {
  'POST /v1/me/deletion': 'always',
  'POST /v1/me/deletion/cancel': 'always',
  'GET /v1/me/deletion': 'always',
  'POST /v1/auth/sms-codes': 'conditional',
  'POST /v1/auth/oauth-attempts': 'conditional',
  'POST /v1/auth/step-up': 'conditional',
  'POST /v1/idempotency-keys/abandon': 'conditional',
  'POST /v1/consents': 'conditional',
  'POST /v1/auth/refresh': 'always',
  'POST /v1/auth/logout': 'always',
  'POST /v1/devices': 'always',
  'POST /v1/auth/login/sms': 'always',
  'POST /v1/auth/login/wechat': 'always',
  'POST /v1/auth/login/apple': 'always',
  'POST /v1/auth/login/huawei': 'always',
  'GET /v1/articles': 'always',
  'GET /v1/app-versions/check': 'always',
  'GET /v1/config': 'always',
  'GET /v1/dict': 'always',
  'GET /v1/me': 'always',
  'GET /v1/wallet/summary': 'always',
};

/** Logins that answer a client below the minimum version with a restricted login (10405 no_account). */
const RESTRICTED_LOGINS = [
  'POST /v1/auth/login/sms',
  'POST /v1/auth/login/wechat',
  'POST /v1/auth/login/apple',
  'POST /v1/auth/login/huawei',
];

/** Codes every x-step-up operation lists in x-error-codes (04 §5 step-up and 幂等 rows). */
const STEP_UP_CODES = [10003, 20903];

/** Inline enums that may only use a subset of an enum of contracts/enums. */
export const ENUM_SUBSETS: Readonly<Record<string, string>> = {
  'ParseInputRequest/properties/scene': 'scene',
  'ConvertLinkRequest/properties/scene': 'scene',
  'StepUpByWechatRequest/properties/provider': 'login_provider',
  'AuthJumpStep/properties/type': 'jump_type',
  'BindUnionByWebCode/properties/auth_method': 'auth_method',
  'BindUnionBySdkToken/properties/auth_method': 'auth_method',
  'StepUpByAppleRequest/properties/provider': 'login_provider',
  'StepUpByHuaweiRequest/properties/provider': 'login_provider',
  ResettableTipKey: 'tip_key',
  'WithdrawalSummary/properties/payout_channel': 'payout_method',
  'Withdrawal/properties/payout_channel': 'payout_method',
  'LedgerPostingEntry/properties/ledger_type': 'ledger_type',
  'LedgerWithdrawPaidEntry/properties/ledger_type': 'ledger_type',
  'SavePayoutAccountByAlipay/properties/payout_method': 'payout_method',
  'SavePayoutAccountByBankCard/properties/payout_method': 'payout_method',
  'PayoutAccountAlipay/properties/payout_method': 'payout_method',
  'PayoutAccountBankCard/properties/payout_method': 'payout_method',
  'RecordConsentRequest/properties/type': 'consent_type',
  'RecordConsentRequest/properties/channel': 'consent_channel',
};

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function at(root: Obj, pointer: string): unknown {
  let cur: unknown = root;
  for (const part of pointer.split('/')) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function refName(v: unknown, kind: string): string | null {
  if (!isObj(v) || typeof v['$ref'] !== 'string') return null;
  const prefix = `#/components/${kind}/`;
  return v['$ref'].startsWith(prefix) ? v['$ref'].slice(prefix.length) : null;
}

function sameSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Every `*_fen` property is an int64 integer, directly or through Fen / NullableFen. */
function checkAmounts(schemas: Obj, problems: string[]): void {
  const visit = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, `${where}/${i}`));
      return;
    }
    if (!isObj(node)) return;
    const props = node['properties'];
    if (isObj(props)) {
      for (const [name, prop] of Object.entries(props)) {
        if (!name.endsWith('_fen')) continue;
        const target = refName(prop, 'schemas');
        let resolved = target === null ? prop : schemas[target];
        let type = isObj(resolved) ? resolved['type'] : undefined;
        let types = Array.isArray(type) ? type : [type];
        // A list of amounts (e.g. quick_amounts_fen): every item is an int64 amount.
        if (isObj(resolved) && types.includes('array')) {
          const item = resolved['items'];
          const itemTarget = refName(item, 'schemas');
          resolved = itemTarget === null ? item : schemas[itemTarget];
          type = isObj(resolved) ? resolved['type'] : undefined;
          types = Array.isArray(type) ? type : [type];
        }
        if (!isObj(resolved) || !types.includes('integer') || resolved['format'] !== 'int64') {
          problems.push(`${where}/properties/${name}: amounts must be int64 integers (04 §5)`);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${where}/${key}`);
  };
  visit(schemas, 'components/schemas');
}

/**
 * `x-step-up` (04 §5 step-up row): the value is a step_up_action and is the one the table maps
 * this operation to; the operation is idempotent, lists the X-Step-Up-Token parameter and the
 * codes 10003 and 20903. Without `x-step-up` an operation lists neither the parameter nor 20903
 * (20903 only answers a key abandoned on one of these operations).
 */
function checkStepUp(
  op: Obj,
  where: string,
  actions: readonly string[],
  expected: string | undefined,
  problems: string[],
): void {
  const value = op['x-step-up'];
  const params = Array.isArray(op['parameters'])
    ? op['parameters'].map((p) => refName(p, 'parameters'))
    : [];
  const listed = Array.isArray(op['x-error-codes']) ? op['x-error-codes'] : [];
  if (value === undefined) {
    if (expected !== undefined) {
      problems.push(`${where}: needs x-step-up ${expected} (04 §5 step-up row)`);
    }
    if (params.includes('StepUpToken')) {
      problems.push(`${where}: X-Step-Up-Token is listed only on x-step-up operations`);
    }
    if (listed.includes(20903)) {
      problems.push(`${where}: 20903 is listed only on x-step-up operations`);
    }
    return;
  }
  if (typeof value !== 'string' || !actions.includes(value)) {
    problems.push(`${where}: x-step-up must be one of ${actions.join(', ')}`);
  } else if (value !== expected) {
    problems.push(
      `${where}: x-step-up ${value} does not match 04 §5 (expected ${expected ?? 'none'})`,
    );
  }
  if (op['x-idempotent'] !== true) problems.push(`${where}: x-step-up operations are x-idempotent`);
  if (!params.includes('StepUpToken')) {
    problems.push(`${where}: x-step-up operations list the X-Step-Up-Token parameter`);
  }
  for (const code of STEP_UP_CODES) {
    if (!listed.includes(code)) {
      problems.push(`${where}: x-step-up operations list ${code} in x-error-codes`);
    }
  }
}

/**
 * help_links targets (04 §10.1) are routes of contracts/routes.json: every route the
 * HelpLinkTarget schema allows exists there, and each declared param has exactly that route's
 * param schema (a subset of the route's params, so a valid target is a valid RouteTarget).
 */
function checkHelpLinkTarget(schemas: Obj, problems: string[], routes: string = routesFile): void {
  const target = schemas['HelpLinkTarget'];
  if (!isObj(target)) return;
  const doc: unknown = JSON.parse(readFileSync(routes, 'utf8'));
  const table = isObj(doc) && isObj(doc['routes']) ? doc['routes'] : {};
  const allowed = at(target, 'properties/route/enum');
  const params = at(target, 'properties/params/properties');
  if (!Array.isArray(allowed) || allowed.length === 0) {
    problems.push('components/schemas/HelpLinkTarget: route must be an enum of routes.json names');
    return;
  }
  for (const name of allowed) {
    const route = typeof name === 'string' ? table[name] : undefined;
    const routeParams = isObj(route) ? at(route, 'params/properties') : undefined;
    if (!isObj(route) || !isObj(routeParams)) {
      problems.push(
        `components/schemas/HelpLinkTarget: route ${String(name)} is not in routes.json`,
      );
      continue;
    }
    for (const [param, schema] of Object.entries(isObj(params) ? params : {})) {
      if (JSON.stringify(routeParams[param]) !== JSON.stringify(schema)) {
        problems.push(
          `components/schemas/HelpLinkTarget: param ${param} differs from routes.json ${String(name)}`,
        );
      }
    }
  }
}

/**
 * x-min-version-gate and x-session-scopes (04 §5; BR-ID-01 细则 two tables, copied above).
 */
function checkGateAndScopes(
  op: Obj,
  where: string,
  method: string,
  scopes: readonly string[],
  problems: string[],
): void {
  const gate = op['x-min-version-gate'];
  const listed = Array.isArray(op['x-error-codes']) ? op['x-error-codes'] : [];
  const description =
    typeof op['description'] === 'string' ? op['description'].replace(/\s+/g, ' ') : '';
  if (method === 'get') {
    if (gate !== undefined) problems.push(`${where}: GET operations carry no x-min-version-gate`);
  } else {
    const expected = GATE_EXCEPTIONS[where] ?? 'true';
    const actual = gate === true ? 'true' : gate === false ? 'false' : gate;
    if (gate === undefined) {
      problems.push(`${where}: write operations carry x-min-version-gate (04 §5)`);
    } else if (gate !== true && gate !== false && gate !== 'conditional') {
      problems.push(
        `${where}: x-min-version-gate is the boolean true / false or the string conditional`,
      );
    } else if (actual !== expected) {
      problems.push(
        `${where}: x-min-version-gate ${String(actual)} differs from BR-ID-01 细则 (${expected})`,
      );
    }
    if ((actual === 'true' || actual === 'conditional') && !listed.includes(10405)) {
      problems.push(`${where}: a gated operation lists 10405 in x-error-codes`);
    }
    if (actual === 'conditional' && !/Version gate \(conditional/.test(description)) {
      problems.push(`${where}: a conditional version gate states its condition in the description`);
    }
  }
  if (RESTRICTED_LOGINS.includes(where) && !listed.includes(10405)) {
    problems.push(`${where}: a restricted login lists 10405 (data.reason=no_account)`);
  }
  const marked = op['x-session-scopes'];
  const expectedScope = DELETION_ONLY_SCOPE[where];
  if (marked === undefined) {
    if (expectedScope !== undefined) {
      problems.push(
        `${where}: needs x-session-scopes [full, deletion_only] (BR-ID-01 细则「受限会话」)`,
      );
    }
    return;
  }
  if (!Array.isArray(marked) || marked.some((s) => typeof s !== 'string' || !scopes.includes(s))) {
    problems.push(`${where}: x-session-scopes is a list of session_scope values`);
    return;
  }
  const set = [...new Set(marked)].sort().join(',');
  if (expectedScope === undefined) {
    if (set !== 'full')
      problems.push(
        `${where}: only the operations of BR-ID-01 细则「受限会话」 accept deletion_only`,
      );
  } else if (set !== 'deletion_only,full') {
    problems.push(`${where}: x-session-scopes must be [full, deletion_only]`);
  } else if (
    expectedScope === 'conditional' &&
    !/deletion_only session is accepted only/.test(description)
  ) {
    problems.push(`${where}: a conditional session scope states its condition in the description`);
  }
}

export function checkConformance(
  enums: readonly EnumDef[],
  codes: readonly ErrorCodeDef[],
  file: string = openapiFile,
): string[] {
  const problems: string[] = [];
  const doc = parseYamlLite(readFileSync(file, 'utf8'));
  if (!isObj(doc) || !isObj(doc['paths']) || !isObj(doc['components'])) {
    return ['openapi.yaml: paths and components are required'];
  }
  const components = doc['components'];
  const schemas = isObj(components['schemas']) ? components['schemas'] : {};
  const enumValues = new Map(enums.map((e) => [e.name, e.values.map((v) => v.value)]));
  const authLevels = enumValues.get('auth_level') ?? [];
  const live = new Map(codes.filter((c) => !c.deprecated).map((c) => [c.code, c]));
  const stepUpActions = enumValues.get('step_up_action') ?? [];
  if (!sameSet(Object.keys(STEP_UP_OPERATIONS), stepUpActions)) {
    problems.push(
      `conformance.ts STEP_UP_OPERATIONS: actions differ from contracts/enums step_up_action ` +
        `(${JSON.stringify(Object.keys(STEP_UP_OPERATIONS))} vs ${JSON.stringify(stepUpActions)})`,
    );
  }
  const stepUpByOperation = new Map(
    Object.entries(STEP_UP_OPERATIONS).map(([action, where]) => [where, action]),
  );

  for (const [pointer, enumName] of Object.entries(ENUM_BINDINGS)) {
    const node = at(schemas, pointer);
    const expected = enumValues.get(enumName);
    const actual = isObj(node) ? node['enum'] : undefined;
    if (expected === undefined) problems.push(`${pointer}: unknown enum ${enumName}`);
    else if (!Array.isArray(actual)) problems.push(`components/schemas/${pointer}: no enum`);
    else if (!sameSet(actual, expected)) {
      problems.push(
        `components/schemas/${pointer}: enum differs from contracts/enums ${enumName} ` +
          `(${JSON.stringify(actual)} vs ${JSON.stringify(expected)})`,
      );
    }
  }

  for (const [pointer, enumName] of Object.entries(ENUM_SUBSETS)) {
    const node = at(schemas, pointer);
    const expected = enumValues.get(enumName) ?? [];
    const actual = isObj(node) ? node['enum'] : undefined;
    if (
      !Array.isArray(actual) ||
      actual.length === 0 ||
      actual.some((v) => !expected.includes(v))
    ) {
      problems.push(
        `components/schemas/${pointer}: enum must be a subset of contracts/enums ${enumName}`,
      );
    }
  }

  for (const [path, item] of Object.entries(doc['paths'])) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const auth = op['x-auth'];
      if (typeof auth !== 'string' || !authLevels.includes(auth)) {
        problems.push(`${where}: x-auth must be one of ${authLevels.join(', ')}`);
      }
      const security = op['security'];
      const schemes = Array.isArray(security)
        ? security.map((s) => (isObj(s) ? Object.keys(s).join('+') : '?'))
        : null;
      const expectSecurity =
        auth === 'none' ? [] : auth === 'optional' ? ['', 'bearerAuth'] : ['bearerAuth'];
      if (schemes === null || !sameSet(schemes, expectSecurity)) {
        problems.push(`${where}: security does not match x-auth ${String(auth)}`);
      }
      const impl = op['x-implementation'];
      if (impl !== undefined && impl !== 'planned') {
        problems.push(`${where}: x-implementation may only be "planned"`);
      }
      checkStepUp(op, where, stepUpActions, stepUpByOperation.get(where), problems);
      if (!path.startsWith('/v1/')) continue;
      checkGateAndScopes(op, where, method, enumValues.get('session_scope') ?? [], problems);
      // NoStoreTooManyRequests is the same response with Cache-Control: no-store (share pages).
      const r429 = refName(at(op, 'responses/429'), 'responses');
      if (r429 !== 'TooManyRequests' && r429 !== 'NoStoreTooManyRequests') {
        problems.push(
          `${where}: /v1 operations declare 429 → TooManyRequests (42901, Retry-After)`,
        );
      }
      const params = Array.isArray(op['parameters'])
        ? op['parameters'].map((p) => refName(p, 'parameters'))
        : [];
      const signed = op['x-signed'];
      const idem = op['x-idempotent'];
      if (typeof signed !== 'boolean') problems.push(`${where}: x-signed must be true or false`);
      if (typeof idem !== 'boolean') problems.push(`${where}: x-idempotent must be true or false`);
      for (const h of SIGN_HEADERS) {
        if (params.includes(h) !== (signed === true)) {
          problems.push(`${where}: ${h} header must be present exactly when x-signed is true`);
        }
      }
      if (params.includes('IdempotencyKey') !== (idem === true)) {
        problems.push(`${where}: Idempotency-Key must be present exactly when x-idempotent`);
      }
      const listed = op['x-error-codes'];
      if (!Array.isArray(listed)) problems.push(`${where}: x-error-codes must be a list`);
      else {
        for (const c of listed) {
          if (typeof c !== 'number' || !live.has(c)) {
            problems.push(`${where}: x-error-codes ${String(c)} is not an allocated, live code`);
          }
        }
      }
      const media = at(op, 'responses/200/content');
      const json = isObj(media) ? media['application/json'] : undefined;
      if (!isObj(json) || (json['example'] === undefined && !isObj(json['examples']))) {
        problems.push(`${where}: the 200 response needs at least one example`);
      }
    }
  }
  checkAmounts(schemas, problems);
  checkHelpLinkTarget(schemas, problems);
  return problems;
}
