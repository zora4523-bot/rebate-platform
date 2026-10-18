// CT-24c: GET /admin/v1/audit-logs and GET /admin/v1/audit-logs/{id}, the audit log search
// (01 F-ADM-03; 04 §6.6 audit-logs, §11.1 audit.view_all). x-implementation is not asserted, so
// B1-34 can drop planned. Reads the dereferenced contract and validates the examples with the API
// workspace's strict Ajv (same loader as admin-dashboard / admin-config tests).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { enums } from './index.ts';

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

type Media = { schema: object; example?: unknown };
type Parameter = { name: string; in: string; required?: boolean; schema: object };
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: Parameter[];
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-error-codes': number[];
  'x-step-up'?: string;
  'x-idempotent'?: boolean;
};
type Schema = { required?: string[]; properties?: Record<string, Schema> };
type Document = {
  paths: Record<string, { get?: Operation }>;
  components: { schemas: Record<string, Schema> };
};

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

function op(path: string): Operation {
  const found = contract.paths[path]?.get;
  expect(found, `GET ${path} must exist`).toBeDefined();
  return found!;
}
const list = (): Operation => op('/admin/v1/audit-logs');
const detail = (): Operation => op('/admin/v1/audit-logs/{id}');
const okMedia = (o: Operation): Media => o.responses['200']!.content!['application/json']!;
const flat = (text: string): string => text.replace(/\s+/g, ' ');

it('[CT-24c] both operations need only a signed-in admin: no permission point, no step-up', () => {
  for (const [o, id] of [
    [list(), 'adminListAuditLogs'],
    [detail(), 'adminGetAuditLog'],
  ] as const) {
    expect(o.operationId).toBe(id);
    expect(o['x-auth']).toBe('admin');
    expect(o.security).toEqual([{ adminBearerAuth: [] }]);
    expect(o.tags).toEqual(['admin-audit']);
    expect(o['x-error-codes']).toEqual([10001, 20001]);
    expect(o['x-step-up']).toBeUndefined();
    expect(o['x-idempotent']).toBeUndefined();
    expect((o.parameters ?? []).map((p) => p.name.toLowerCase())).not.toContain('x-step-up-token');
    expect(o.description).not.toContain('Permission point `');
    expect(flat(o.description)).toContain('does not write an audit record itself');
  }
  expect(enums.admin_permission).toContain('audit.view_all');
});

it('[CT-24c] the list takes actor_id, target_type, target_id, permission, from, to and page / page_size', () => {
  const params = list().parameters ?? [];
  expect(params.map((p) => p.name)).toEqual([
    'X-Trace-Id',
    'page',
    'page_size',
    'actor_id',
    'target_type',
    'target_id',
    'permission',
    'from',
    'to',
  ]);
  for (const p of params.slice(1)) {
    expect(p.in, p.name).toBe('query');
    expect(p.required ?? false, p.name).toBe(false);
  }
  const pageSize = params.find((p) => p.name === 'page_size')!.schema as { maximum: number };
  expect(pageSize.maximum).toBe(200);
  for (const name of ['from', 'to']) {
    expect(params.find((p) => p.name === name)!.schema).toMatchObject({ format: 'date-time' });
  }
  const permission = ajv.compile(params.find((p) => p.name === 'permission')!.schema);
  for (const key of enums.admin_permission) expect(permission(key), key).toBe(true);
});

it('[CT-24c] without audit.view_all the server forces actor_id to the caller and returns an empty page', () => {
  const description = flat(list().description);
  expect(description).toContain('`audit.view_all`');
  expect(description).toContain('forces `actor_id` to the caller');
  expect(description).toContain('empty page (`items=[]`, `total=0`), not an error');
  expect(description).toContain('`at` descending, then `id` descending');
  expect(description).toContain('never matches a filter');
  const detailText = flat(detail().description);
  expect(detailText).toContain("another account's record is 20001 with `data.fields=[id]`");
  expect(detailText).toContain('the same as an unknown id');
});

it('[CT-24c] rows keep nullable target / permission / ip; only the detail carries before and after', () => {
  const row = contract.components.schemas['AdminAuditLogListItem']!;
  const required = [
    'id',
    'actor_id',
    'action',
    'target_type',
    'target_id',
    'permission',
    'ip',
    'at',
  ];
  expect(row.required).toEqual(required);
  expect(Object.keys(row.properties!)).not.toContain('before');
  expect(Object.keys(row.properties!)).not.toContain('after');
  const record = contract.components.schemas['AdminAuditLog']!;
  expect(record.required).toEqual([...required, 'before', 'after']);
  expect(contract.components.schemas['AdminAuditLogPage']!.required).toEqual([
    'items',
    'page',
    'page_size',
    'total',
  ]);
});

it('[CT-24c] the examples satisfy the schemas, nulls included; ids are decimal strings', () => {
  const listMedia = okMedia(list());
  const validateList = ajv.compile(listMedia.schema);
  expect(validateList(listMedia.example)).toBe(true);
  const rows = (listMedia.example as { data: { items: Record<string, unknown>[] } }).data.items;
  expect(rows.some((r) => r['target_type'] === null && r['permission'] === null)).toBe(true);
  const empty = {
    code: 0,
    msg: '',
    data: { items: [], page: 1, page_size: 20, total: 0 },
    trace_id: 'x',
  };
  expect(validateList(empty)).toBe(true);
  const withValues = structuredClone(listMedia.example) as { data: { items: object[] } };
  (withValues.data.items[0] as Record<string, unknown>)['before'] = { a: 1 };
  expect(validateList(withValues)).toBe(false);

  const detailMedia = okMedia(detail());
  const validateDetail = ajv.compile(detailMedia.schema);
  expect(validateDetail(detailMedia.example)).toBe(true);
  const nulls = structuredClone(detailMedia.example) as { data: Record<string, unknown> };
  nulls.data['before'] = null;
  nulls.data['after'] = null;
  expect(validateDetail(nulls)).toBe(true);
  const numericId = structuredClone(detailMedia.example) as { data: Record<string, unknown> };
  numericId.data['id'] = 1031;
  expect(validateDetail(numericId)).toBe(false);

  const idParam = ajv.compile(detail().parameters!.find((p) => p.name === 'id')!.schema);
  expect(idParam('1031')).toBe(true);
  expect(idParam('9223372036854775807')).toBe(true);
  expect(idParam('0')).toBe(false);
  expect(idParam('01')).toBe(false);
});
