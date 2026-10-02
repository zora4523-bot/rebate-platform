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
  SceneCode: 'scene',
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
      if (!path.startsWith('/v1/')) continue;
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
