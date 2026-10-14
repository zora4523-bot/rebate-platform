// CT-02f: /admin/v1 login, first password change, authenticator binding, two-tier step-up,
// me/permissions and the read-only admins list (04 §6.6 auth / admins, §11; 08 BR-ID-34;
// codes from 13 §13.11). Reads the dereferenced contract; validates every example against its
// schema with the API workspace's strict Ajv (same loader as openapi.test.ts).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { enums, errorCodes, type Schema } from './index.ts';

const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
interface Validator {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): (data: unknown) => boolean;
}
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => Validator;
};
const addFormats = apiRequire('ajv-formats') as (ajv: Validator) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};

type Media = { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> };
type Operation = {
  operationId: string;
  security: Record<string, string[]>[];
  parameters?: { name: string; in: string }[];
  requestBody?: { required: boolean; content: { 'application/json': Media } };
  responses: Record<string, { content?: { 'application/json': Media } }>;
  'x-auth': string;
  'x-implementation'?: string;
  'x-error-codes': number[];
  'x-signed'?: boolean;
  'x-step-up'?: string;
};
type Document = {
  paths: Record<string, Partial<Record<'get' | 'post', Operation>>>;
  components: {
    schemas: Record<string, object & { enum?: string[]; pattern?: string }>;
    securitySchemes: Record<string, { type: string; scheme?: string; in?: string }>;
  };
};

/** The operations of CT-02f: method, path, x-auth and the codes each must list. */
const OPERATIONS = [
  ['post', '/admin/v1/auth/login', 'none', [10008, 10009, 10403]],
  ['post', '/admin/v1/auth/password', 'none', [10001, 10009, 10403, 20001]],
  ['post', '/admin/v1/auth/totp/secret', 'none', [10001, 10009, 10403]],
  ['post', '/admin/v1/auth/totp/bind', 'none', [10001, 10009, 10403, 20002]],
  ['post', '/admin/v1/auth/totp', 'none', [10001, 10009, 10403, 20002]],
  ['post', '/admin/v1/auth/logout', 'admin', [10001, 10403]],
  ['post', '/admin/v1/auth/step-up/sms-codes', 'admin', [10001, 10003, 10403, 42901]],
  ['post', '/admin/v1/auth/step-up', 'admin', [10001, 10003, 10403, 20002, 20003]],
  ['get', '/admin/v1/me/permissions', 'admin', [10001, 10403]],
  ['get', '/admin/v1/admins', 'super', [10001, 10403, 20001]],
  ['get', '/admin/v1/admins/{admin_id}', 'super', [10001, 10403, 20001]],
] as const;

/** The operations F1-06k, F1-06l and F1-06m implement: they carry no x-implementation marker any more. */
const IMPLEMENTED: ReadonlySet<string> = new Set([
  '/admin/v1/auth/login',
  '/admin/v1/auth/password',
  '/admin/v1/auth/totp/secret',
  '/admin/v1/auth/totp/bind',
  '/admin/v1/auth/totp',
  '/admin/v1/auth/logout',
  // F1-06l: two-tier step-up and me/permissions.
  '/admin/v1/auth/step-up/sms-codes',
  '/admin/v1/auth/step-up',
  '/admin/v1/me/permissions',
  // F1-06m: the read-only admin accounts.
  '/admin/v1/admins',
  '/admin/v1/admins/{admin_id}',
]);

/** Codes every admin operation may return without listing them (openapi info.description). */
const ADMIN_COMMON = [10403, 20001, 42901, 50001];

let contract: Document;
let ajv: Validator;

beforeAll(async () => {
  contract = (await dereference(
    fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url)),
  )) as Document;
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
});

function operation(method: 'get' | 'post', path: string): Operation {
  const op = contract.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} must exist`).toBeDefined();
  return op!;
}

function examplesOf(media: Media): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (media.example !== undefined) out.push(['example', media.example]);
  for (const [name, ex] of Object.entries(media.examples ?? {})) out.push([name, ex.value]);
  return out;
}

const schema = (name: string): object => contract.components.schemas[name]!;

describe('admin operations (04 §6.6, CT-02f)', () => {
  it.each(OPERATIONS)('%s %s exists, x-auth %s', (method, path, auth, codes) => {
    const op = operation(method, path);
    // F1-06k / F1-06l / F1-06m implement these (no marker); the others stay planned.
    if (IMPLEMENTED.has(path)) expect(op['x-implementation']).toBeUndefined();
    else expect(op['x-implementation']).toBe('planned');
    expect(op['x-auth']).toBe(auth);
    expect(op.security).toEqual(auth === 'none' ? [] : [{ adminBearerAuth: [] }]);
    expect(op['x-error-codes']).toEqual(expect.arrayContaining([...codes]));
    for (const code of op['x-error-codes']) {
      const def = errorCodes[code as keyof typeof errorCodes];
      expect(def, `${code} is allocated`).toBeDefined();
      expect(def.deprecated).toBe(false);
    }
    expect(op['x-step-up']).toBeUndefined();
    expect(op['x-signed'] ?? false).toBe(false);
  });

  it('admin x-auth values are the admin_auth_level enum', () => {
    expect([...enums.admin_auth_level].sort()).toEqual(['admin', 'none', 'super']);
  });

  it('admin requests carry no app headers and no cookie (Bearer admin_token only)', () => {
    for (const [method, path] of OPERATIONS) {
      const op = operation(method, path);
      for (const param of op.parameters ?? []) {
        expect(param.in, `${path} ${param.name}`).not.toBe('cookie');
        expect(
          ['x-app-id', 'x-platform', 'x-device-id', 'x-sign', 'x-step-up-token'],
          `${path} ${param.name}`,
        ).not.toContain(param.name.toLowerCase());
      }
    }
    const scheme = contract.components.securitySchemes['adminBearerAuth'];
    expect(scheme).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(Object.values(contract.components.securitySchemes).some((s) => s.in === 'cookie')).toBe(
      false,
    );
  });

  it('request examples satisfy the request schemas', () => {
    for (const [method, path] of OPERATIONS) {
      const body = operation(method, path).requestBody;
      if (body === undefined) continue;
      expect(body.required).toBe(true);
      const media = body.content['application/json'];
      const validate = ajv.compile(media.schema);
      const examples = examplesOf(media);
      expect(examples.length, path).toBeGreaterThan(0);
      for (const [name, value] of examples) expect(validate(value), `${path} ${name}`).toBe(true);
    }
  });

  it('200 examples satisfy the response schemas', () => {
    for (const [method, path] of OPERATIONS) {
      const media = operation(method, path).responses['200']!.content!['application/json'];
      const validate = ajv.compile(media.schema);
      const examples = examplesOf(media);
      expect(examples.length, path).toBeGreaterThan(0);
      for (const [name, value] of examples) expect(validate(value), `${path} ${name}`).toBe(true);
    }
  });

  it('error examples are envelopes of listed codes with listed data.reason values', () => {
    for (const [method, path] of OPERATIONS) {
      const op = operation(method, path);
      const media = op.responses['4XX']!.content!['application/json'];
      const validate = ajv.compile(media.schema);
      const examples = examplesOf(media);
      expect(examples.length, path).toBeGreaterThan(0);
      const allowed = new Set([...op['x-error-codes'], ...ADMIN_COMMON]);
      for (const [name, value] of examples) {
        expect(validate(value), `${path} ${name}`).toBe(true);
        const { code, data } = value as { code: number; data?: Record<string, unknown> };
        expect(allowed.has(code), `${path} ${name} ${code}`).toBe(true);
        const def = errorCodes[code as keyof typeof errorCodes];
        for (const [field, v] of Object.entries(data ?? {})) {
          const listed = (def.data as Record<string, readonly string[] | null>)[field];
          expect(listed, `${path} ${name} data.${field}`).not.toBeUndefined();
          if (Array.isArray(listed)) expect(listed, `${path} ${name}`).toContain(v);
        }
      }
    }
  });
});

describe('login steps and tickets (BR-ID-34 细则「首次绑定身份验证器」)', () => {
  it('the login response names the next step; there is no admin_token before the last step', () => {
    const validate = ajv.compile(schema('AdminLoginStepResponse'));
    const base = {
      code: 0,
      msg: '',
      trace_id: 't',
      data: {
        next: 'bind_totp',
        login_ticket: 'lt',
        ticket_expires_at: '2026-10-07T10:05:00+08:00',
      },
    };
    expect(validate(base)).toBe(true);
    expect(validate({ ...base, data: { ...base.data, admin_token: 'x' } })).toBe(false);
    expect(validate({ ...base, data: { ...base.data, next: 'done' } })).toBe(false);
    expect([...(schema('AdminLoginStep') as { enum: string[] }).enum].sort()).toEqual(
      [...enums.admin_login_step].sort(),
    );
  });

  it('codes are six digits; the ticket travels in the body', () => {
    const validate = ajv.compile(schema('AdminTotpCodeRequest'));
    expect(validate({ login_ticket: 'lt', code: '012345' })).toBe(true);
    for (const code of ['12345', '1234567', 'abcdef', 123456]) {
      expect(validate({ login_ticket: 'lt', code }), String(code)).toBe(false);
    }
    expect(validate({ code: '012345' })).toBe(false);
  });

  it('a session carries the token, its absolute expiry and the idle timeout', () => {
    expectTypeOf<keyof Schema<'AdminSession'>>().toEqualTypeOf<
      'admin_token' | 'expires_at' | 'idle_timeout_sec'
    >();
    const session = schema('AdminSession') as { required: string[] };
    expect([...session.required].sort()).toEqual(['admin_token', 'expires_at', 'idle_timeout_sec']);
    // The last login step (and only it) hands out the session; its examples must carry one.
    const validate = ajv.compile(session);
    for (const path of ['/admin/v1/auth/totp', '/admin/v1/auth/totp/bind']) {
      const media = operation('post', path).responses['200']!.content!['application/json'];
      const examples = examplesOf(media);
      expect(examples.length, path).toBeGreaterThan(0);
      for (const [name, value] of examples) {
        const data = (value as { data: Record<string, unknown> }).data;
        expect(Object.keys(data).sort(), `${path} ${name}`).toEqual([
          'admin_token',
          'expires_at',
          'idle_timeout_sec',
        ]);
        expect(validate(data), `${path} ${name}`).toBe(true);
      }
    }
    expect(validate({ admin_token: 't', expires_at: '2026-10-07T18:00:00+08:00' })).toBe(false);
  });

  it('login codes follow 13 §13.11', () => {
    expect(errorCodes[10008].data).toEqual({});
    expect(errorCodes[10009].data).toEqual({ locked_until: null });
    expect(errorCodes[10001].data).toEqual({ reason: ['login_ticket_expired'] });
    expect(errorCodes[20002].data).toEqual({ reason: ['totp_invalid', 'totp_bind_invalid'] });
    expect(errorCodes[10403].data['reason']).toEqual(
      expect.arrayContaining(['admin_ip_not_allowed', 'admin_permission_denied']),
    );
  });
});

describe('step-up tiers and permissions (BR-ID-34, 04 §11)', () => {
  it('tiers are the admin_step_up_tier enum and 10003 carries data.tier', () => {
    expect([...(schema('AdminStepUpTier') as { enum: string[] }).enum].sort()).toEqual(
      [...enums.admin_step_up_tier].sort(),
    );
    expect(errorCodes[10003].data).toEqual({
      tier: [...enums.admin_step_up_tier],
      reason: ['verify_phone_missing'],
    });
  });

  it('a step-up token records its tier', () => {
    const validate = ajv.compile(schema('AdminStepUpResponse'));
    const ok = {
      code: 0,
      msg: '',
      trace_id: 't',
      data: { step_up_token: 's', tier: 'sms', expire_at: '2026-10-07T10:35:00+08:00' },
    };
    expect(validate(ok)).toBe(true);
    const withoutTier = { ...ok, data: { step_up_token: 's', expire_at: ok.data.expire_at } };
    expect(validate(withoutTier)).toBe(false);
    expect(ajv.compile(schema('AdminStepUpRequest'))({ tier: 'password', code: '123456' })).toBe(
      false,
    );
  });

  it('every admin_permission value is a valid permission key, and examples only use them', () => {
    const pattern = new RegExp((schema('AdminPermissionKey') as { pattern: string }).pattern);
    for (const key of enums.admin_permission) expect(key, key).toMatch(pattern);
    const keys: string[] = [];
    const me = operation('get', '/admin/v1/me/permissions').responses['200']!.content![
      'application/json'
    ];
    for (const [, value] of examplesOf(me)) {
      const data = (value as { data: Schema<'AdminMe'> }).data;
      keys.push(...data.permissions.map((p) => p.key));
    }
    for (const [method, path] of [
      ['get', '/admin/v1/admins'],
      ['get', '/admin/v1/admins/{admin_id}'],
    ] as const) {
      const media = operation(method, path).responses['200']!.content!['application/json'];
      for (const [, value] of examplesOf(media)) {
        const data = (value as { data: Schema<'AdminAccount'> | Schema<'AdminAccountPage'> }).data;
        const items = 'items' in data ? data.items : [data];
        for (const item of items) keys.push(...item.permissions);
      }
    }
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(enums.admin_permission, key).toContain(key);
  });

  it('a permission can annotate a tier per operation (content.app_version, fund.recon)', () => {
    const validate = ajv.compile(schema('AdminPermissionGrant'));
    expect(
      validate({
        key: 'content.app_version',
        step_up_tier: null,
        step_up_operations: [
          { operation: 'content.app_version.raise_min_supported_version', tier: 'totp' },
        ],
      }),
    ).toBe(true);
    expect(validate({ key: 'fund.adjust', step_up_tier: 'sms', step_up_operations: [] })).toBe(
      true,
    );
    expect(validate({ key: 'fund.adjust', step_up_tier: 'sms' })).toBe(false);
  });

  it('an account without permission points gets an empty list; the phone is masked or null', () => {
    const validate = ajv.compile(schema('AdminMe'));
    const me = {
      admin_id: 'a',
      username: 'ops-yi',
      is_super: false,
      verify_phone_masked: null,
      permissions: [],
    };
    expect(validate(me)).toBe(true);
    expect(validate({ ...me, verify_phone: '13800138000' })).toBe(false);
  });

  it('the admins list pages with page_size at most 200 and exposes no secrets', () => {
    const list = operation('get', '/admin/v1/admins');
    expect((list.parameters ?? []).map((p) => p.name)).toEqual(
      expect.arrayContaining(['page', 'page_size']),
    );
    const props = Object.keys(
      (schema('AdminAccount') as { properties: Record<string, unknown> }).properties,
    );
    for (const secret of ['password', 'password_hash', 'totp_secret', 'verify_phone']) {
      expect(props).not.toContain(secret);
    }
    const page = ajv.compile(schema('AdminAccountPage'));
    expect(page({ items: [], page: 1, page_size: 201, total: 0 })).toBe(false);
    expect(page({ items: [], page: 1, page_size: 200, total: 0 })).toBe(true);
  });
});
