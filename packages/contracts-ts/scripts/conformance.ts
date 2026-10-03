// Cross-file checks of contracts/: the OpenAPI document against contracts/enums and
// contracts/error-codes.yaml, and the operation conventions of 规划/04 §5 (x-auth, x-signed,
// x-idempotent, examples, amounts). Run by codegen.ts in both modes, so `pnpm contracts:check`
// fails on a violation. Returns the list of problems; empty means conforming.
import { readFileSync } from 'node:fs';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef, ErrorCodeDef } from './catalog.ts';
import { openapiFile } from './paths.ts';

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

/** Codes every x-step-up operation lists in x-error-codes (04 §5 step-up and 幂等 rows). */
const STEP_UP_CODES = [10003, 20903];

/** Inline enums that may only use a subset of an enum of contracts/enums. */
export const ENUM_SUBSETS: Readonly<Record<string, string>> = {
  'ParseInputRequest/properties/scene': 'scene',
  'ConvertLinkRequest/properties/scene': 'scene',
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
        const resolved = target === null ? prop : schemas[target];
        const type = isObj(resolved) ? resolved['type'] : undefined;
        const types = Array.isArray(type) ? type : [type];
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
      if (refName(at(op, 'responses/429'), 'responses') !== 'TooManyRequests') {
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
  return problems;
}
