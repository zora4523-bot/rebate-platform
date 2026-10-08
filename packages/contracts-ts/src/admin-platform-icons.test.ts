// CT-17g: /admin/v1/platform-icons, the admin side of the platform mark replacement images
// (04 §6.6, §11.2 content.platform_icon; 08 BR-TEXT-24 细则). Reads the dereferenced contract and
// validates every example with the API workspace's strict Ajv (same loader as admin-auth.test.ts).
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
type Method = 'get' | 'post' | 'patch';
type Operation = {
  operationId: string;
  description: string;
  security: Record<string, string[]>[];
  parameters?: { name: string; in: string }[];
  requestBody?: { required: boolean; content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-implementation'?: string;
  'x-error-codes': number[];
  'x-idempotent'?: boolean;
  'x-step-up'?: string;
};
type Document = {
  paths: Record<string, Partial<Record<Method, Operation>>>;
  components: {
    schemas: Record<
      string,
      object & { enum?: string[]; properties?: Record<string, object>; required?: string[] }
    >;
  };
};

const BASE = '/admin/v1/platform-icons';
/** The operations of CT-17g and the codes each must list (台账 ①–⑦). */
const OPERATIONS = [
  ['get', BASE, [10001, 10403]],
  ['get', `${BASE}/{key}/versions`, [10001, 10403, 20001]],
  ['post', `${BASE}/{key}/uploads`, [10001, 10403, 20001]],
  ['post', `${BASE}/{key}/versions`, [10001, 10403, 20001]],
  ['patch', `${BASE}/{key}/versions/{version}`, [10001, 10403, 20001, 20902]],
  ['post', `${BASE}/{key}/publish`, [10001, 10403, 20001, 20902]],
  ['post', `${BASE}/{key}/restore-builtin`, [10001, 10403, 20001, 20902]],
] as const;

/** Codes every admin operation may return without listing them (openapi info.description). */
const ADMIN_COMMON = [10403, 20001, 42901, 50001];
const MARK_KEYS = ['taobao', 'tmall', 'jd', 'pdd', 'wechat', 'wechat_pay', 'alipay', 'wecom'];
const DIGEST = '88e2cce43eeadb36ce19668116709ef3f6f44b7b364d4d23fd545d2af826e6da';
const UPLOAD_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';

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

function operation(method: Method, path: string): Operation {
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

const compile = (name: string) => ajv.compile(contract.components.schemas[name]!);

describe('platform mark operations (04 §6.6, §11.2)', () => {
  it.each(OPERATIONS)(
    '[CT-17g] %s %s is a planned admin operation of content.platform_icon',
    (method, path, codes) => {
      const op = operation(method, path);
      expect(op['x-implementation']).toBe('planned');
      expect(op['x-auth']).toBe('admin');
      expect(op.security).toEqual([{ adminBearerAuth: [] }]);
      expect(op.description).toContain('Permission point `content.platform_icon`');
      expect(op['x-error-codes']).toEqual([...codes]);
      // 04 §11.2: no step-up for this point; admin writes use CAS, not Idempotency-Key.
      expect(op['x-step-up']).toBeUndefined();
      expect(op['x-idempotent']).toBeUndefined();
      for (const param of op.parameters ?? []) {
        expect(['idempotency-key', 'x-step-up-token']).not.toContain(param.name.toLowerCase());
      }
    },
  );

  it('[CT-17g] the permission point is a listed admin_permission', () => {
    expect(enums.admin_permission).toContain('content.platform_icon');
  });

  it('[CT-17g] request, 200 and error examples satisfy their schemas; errors use listed codes and data', () => {
    for (const [method, path] of OPERATIONS) {
      const op = operation(method, path);
      const json = op.requestBody?.content['application/json'];
      if (json !== undefined) {
        const validate = ajv.compile(json.schema);
        for (const [name, value] of examplesOf(json)) {
          expect(validate(value), `${path} request ${name}`).toBe(true);
        }
      }
      const ok = op.responses['200']!.content!['application/json']!;
      const validateOk = ajv.compile(ok.schema);
      expect(examplesOf(ok).length, path).toBeGreaterThan(0);
      for (const [name, value] of examplesOf(ok)) {
        expect(validateOk(value), `${path} 200 ${name}`).toBe(true);
      }
      const allowed = new Set([...op['x-error-codes'], ...ADMIN_COMMON]);
      for (const status of ['4XX', '413']) {
        const media = op.responses[status]?.content?.['application/json'];
        if (media === undefined) continue;
        const validate = ajv.compile(media.schema);
        for (const [name, value] of examplesOf(media)) {
          expect(validate(value), `${path} ${status} ${name}`).toBe(true);
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
    }
  });

  it('[CT-17g] examples cover the three upload rejections and the 20902 conflict', () => {
    const upload = operation('post', `${BASE}/{key}/uploads`);
    const reasons = examplesOf(upload.responses['4XX']!.content!['application/json']!).map(
      ([, v]) => (v as { data?: { reason?: string } }).data?.reason,
    );
    expect(reasons).toEqual(
      expect.arrayContaining(['icon_format_invalid', 'icon_too_large', 'icon_svg_unconvertible']),
    );
    for (const [method, path] of [
      ['post', `${BASE}/{key}/publish`],
      ['post', `${BASE}/{key}/restore-builtin`],
      ['patch', `${BASE}/{key}/versions/{version}`],
    ] as const) {
      const conflicts = examplesOf(
        operation(method, path).responses['4XX']!.content!['application/json']!,
      ).filter(([, v]) => (v as { code: number }).code === 20902);
      expect(
        conflicts.map(([, v]) => v),
        path,
      ).toEqual([expect.objectContaining({ data: { resource: 'platform_icon' } })]);
    }
  });
});

describe('platform mark keys (BR-TEXT-24 细则标识键表)', () => {
  it('[CT-17g] PlatformIconKey, enum platform_icon_key and the platform_icons keys are one list', () => {
    expect([...enums.platform_icon_key]).toEqual(MARK_KEYS);
    expect(contract.components.schemas['PlatformIconKey']!.enum).toEqual(MARK_KEYS);
    expect(Object.keys(contract.components.schemas['ConfigPlatformIcons']!.properties!)).toEqual(
      MARK_KEYS,
    );
    const validate = compile('PlatformIconKey');
    for (const key of ['douyin', 'Alipay', 'wechat-pay', 'pinduoduo']) {
      expect(validate(key), key).toBe(false);
    }
  });

  it('[CT-17g] the list example has every key once, in enum order', () => {
    const ok = operation('get', BASE).responses['200']!.content!['application/json']!;
    const { data } = ok.example as { data: { items: { key: string }[] } };
    expect(data.items.map((item) => item.key)).toEqual(MARK_KEYS);
  });
});

describe('upload, save, register, publish and restore bodies', () => {
  it('[CT-17g] the upload is multipart/form-data with one file part', () => {
    const body = operation('post', `${BASE}/{key}/uploads`).requestBody!;
    expect(body.required).toBe(true);
    expect(Object.keys(body.content)).toEqual(['multipart/form-data']);
    const schema = contract.components.schemas['AdminPlatformIconUploadRequest']!;
    expect(schema.required).toEqual(['file']);
    expect(Object.keys(schema.properties!)).toEqual(['file']);
  });

  it('[CT-17g] an upload result carries the cleaned file, its digest and the sanitized flag', () => {
    const validate = compile('AdminPlatformIconUpload');
    const upload = {
      upload_id: UPLOAD_ID,
      url: `https://media.example.test/${DIGEST}.svg`,
      sha256: DIGEST,
      format: 'svg',
      bytes: 4096,
      sanitized: true,
      expires_at: '2026-10-10T10:00:00+08:00',
    };
    expect(validate(upload)).toBe(true);
    for (const change of [
      { url: `http://media.example.test/${DIGEST}.svg` },
      { sha256: DIGEST.toUpperCase() },
      { format: 'gif' },
      { bytes: 0 },
      { sanitized: 'yes' },
      { svg_markup: '<svg/>' },
    ]) {
      expect(validate({ ...upload, ...change }), JSON.stringify(change)).toBe(false);
    }
    for (const field of Object.keys(upload)) {
      const partial: Record<string, unknown> = { ...upload };
      delete partial[field];
      expect(validate(partial), `missing ${field}`).toBe(false);
    }
  });

  it('[CT-17g] saving needs upload_id; source and download date are optional (draft)', () => {
    const validate = compile('AdminPlatformIconVersionCreateRequest');
    expect(validate({ upload_id: UPLOAD_ID })).toBe(true);
    expect(
      validate({
        upload_id: UPLOAD_ID,
        sanitized_confirmed: true,
        source_url: 'https://example.test/brand/alipay',
        downloaded_on: '2026-10-08',
      }),
    ).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ upload_id: UPLOAD_ID, downloaded_on: '2026-10-08T00:00:00+08:00' })).toBe(
      false,
    );
    expect(validate({ upload_id: UPLOAD_ID, source_url: 'javascript:alert(1)' })).toBe(false);
    expect(validate({ upload_id: UPLOAD_ID, publish: true })).toBe(false);
  });

  it('[CT-17g] registration carries the version revision (CAS) and at least one of source_url and downloaded_on', () => {
    const validate = compile('AdminPlatformIconSourceRequest');
    expect(validate({ expected_revision: 1, source_url: 'https://example.test/brand/jd' })).toBe(
      true,
    );
    expect(validate({ expected_revision: 2, downloaded_on: '2026-10-09' })).toBe(true);
    // Without the revision two tabs could silently overwrite each other's registration.
    expect(validate({ source_url: 'https://example.test/brand/jd' })).toBe(false);
    expect(validate({ expected_revision: 1 })).toBe(false);
    expect(validate({ expected_revision: 0, downloaded_on: '2026-10-09' })).toBe(false);
    expect(validate({})).toBe(false);
    expect(validate({ expected_revision: 1, version: 2 })).toBe(false);
    const patch = operation('patch', `${BASE}/{key}/versions/{version}`);
    expect(patch.description).toContain('`expected_revision`');
    expect(patch.description).toContain('20902');
  });

  it('[CT-17g] publish and restore carry the mark revision, never the version number, as CAS', () => {
    const publish = compile('AdminPlatformIconPublishRequest');
    expect(publish({ version: 1, expected_revision: 0 })).toBe(true);
    expect(publish({ version: 2, expected_revision: 3 })).toBe(true);
    expect(publish({ version: 2 })).toBe(false);
    expect(publish({ version: 2, expected_current_version: 1 })).toBe(false);
    expect(publish({ version: 2, expected_revision: null })).toBe(false);
    expect(publish({ version: 2, expected_revision: -1 })).toBe(false);
    expect(publish({ version: 0, expected_revision: 0 })).toBe(false);
    expect(publish({ version: 2, expected_revision: 3, gray_percent: 10 })).toBe(false);
    const restore = compile('AdminPlatformIconRestoreRequest');
    expect(restore({ expected_revision: 3 })).toBe(true);
    expect(restore({ expected_revision: 0 })).toBe(true);
    expect(restore({ expected_current_version: 2 })).toBe(false);
    expect(restore({})).toBe(false);
  });

  it('[CT-17g] a retried publish cannot undo a later rollback (revision only grows)', () => {
    const description = operation('post', `${BASE}/{key}/publish`).description;
    expect(description).toContain('`expected_revision`');
    expect(description).toContain('never matches again');
    const revision = contract.components.schemas['AdminPlatformIcon']!.properties!['revision'] as {
      type: string;
      minimum: number;
    };
    expect(revision).toMatchObject({ type: 'integer', minimum: 0 });
    // Example walk-through: publish 2 with revision 2 → revision 3; restore with 3 → revision 4.
    const ok = (path: string) =>
      (
        operation('post', path).responses['200']!.content!['application/json']!.example as {
          data: { revision: number };
        }
      ).data.revision;
    expect(ok(`${BASE}/{key}/publish`)).toBe(3);
    expect(ok(`${BASE}/{key}/restore-builtin`)).toBe(4);
  });

  it('[CT-17g] saving the same upload again returns the existing version (retry-safe)', () => {
    const save = operation('post', `${BASE}/{key}/versions`);
    expect(save.description).toContain('already saved as a version');
    expect(save.description).toContain('returns 200 with that existing version');
    const invalid = examplesOf(save.responses['4XX']!.content!['application/json']!).find(
      ([name]) => name === 'uploadInvalid',
    );
    expect(invalid?.[1]).toMatchObject({ code: 20001, data: { fields: ['upload_id'] } });
  });

  it('[CT-17g] publishing a draft lists every missing registration', () => {
    const publish = operation('post', `${BASE}/{key}/publish`);
    const missing = examplesOf(publish.responses['4XX']!.content!['application/json']!).find(
      ([name]) => name === 'sourceMissing',
    );
    expect(missing?.[1]).toMatchObject({
      code: 20001,
      data: { fields: ['source_url', 'downloaded_on'] },
    });
    expect(publish.description).toContain('listing every missing');
  });

  it('[CT-17g] a version is publishable only as a field the server derives; the row may be built-in', () => {
    const row = compile('AdminPlatformIcon');
    const builtin = {
      key: 'alipay',
      current_version: null,
      revision: 0,
      current: null,
      latest_version: null,
      updated_by: null,
      updated_at: null,
    };
    expect(row(builtin)).toBe(true);
    expect(row({ ...builtin, key: 'douyin' })).toBe(false);
    expect(row({ ...builtin, current_version: 0 })).toBe(false);
    expect(row({ ...builtin, revision: -1 })).toBe(false);
    const withoutRevision: Record<string, unknown> = { ...builtin };
    delete withoutRevision['revision'];
    expect(row(withoutRevision)).toBe(false);
    expectTypeOf<Schema<'AdminPlatformIcon'>['revision']>().toEqualTypeOf<number>();
    expectTypeOf<Schema<'AdminPlatformIconVersion'>['revision']>().toEqualTypeOf<number>();
    expectTypeOf<Schema<'AdminPlatformIcon'>['current_version']>().toEqualTypeOf<number | null>();
    expectTypeOf<Schema<'AdminPlatformIconVersion'>['publishable']>().toEqualTypeOf<boolean>();
    // expectTypeOf is compile-time only; pin the same shape in the contract at run time.
    expect(contract.components.schemas['AdminPlatformIconVersion']!.required).toEqual(
      expect.arrayContaining([
        'publishable',
        'ever_published',
        'revision',
        'source_url',
        'downloaded_on',
      ]),
    );
  });
});
