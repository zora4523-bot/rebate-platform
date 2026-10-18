// CT-24b: GET /admin/v1/search, the console's top-bar search (01 F-ADM-04; 04 §6.6 search, §11.1;
// BR-ID-34 细则「一框搜」). x-implementation is not asserted, so B1-34 can drop planned. Reads the
// dereferenced contract and validates the examples with the API workspace's strict Ajv (same
// loader as admin-config.test.ts).
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

type Media = { schema: object; examples?: Record<string, { value: unknown }> };
type Parameter = { name: string; in: string; required?: boolean; schema: Record<string, unknown> };
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
type Schema = {
  required?: string[];
  properties?: Record<string, Schema>;
  enum?: string[];
  maxItems?: number;
};
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

function search(): Operation {
  const op = contract.paths['/admin/v1/search']?.get;
  expect(op, 'GET /admin/v1/search must exist').toBeDefined();
  return op!;
}

const okMedia = (): Media => search().responses['200']!.content!['application/json']!;

it('[CT-24b] GET /admin/v1/search is a read-only admin operation that never answers 10403 for permissions', () => {
  const op = search();
  expect(op.operationId).toBe('adminSearch');
  expect(op['x-auth']).toBe('admin');
  expect(op.security).toEqual([{ adminBearerAuth: [] }]);
  expect(op.tags).toEqual(['admin-search']);
  expect(op['x-error-codes']).toEqual([10001, 20001]);
  expect(op['x-step-up']).toBeUndefined();
  expect(op['x-idempotent']).toBeUndefined();
  const names = (op.parameters ?? []).map((p) => p.name.toLowerCase());
  expect(names).not.toContain('x-step-up-token');
  const q = op.parameters!.find((p) => p.name === 'q')!;
  expect(q.in).toBe('query');
  expect(q.required).toBe(true);
  const description = op.description.replace(/\s+/g, ' ');
  expect(description).toContain('never answers 10403 `admin_permission_denied`');
  expect(description).toContain('`data.fields=[q]`');
  expect(description).toContain('writes an audit entry');
  const errors = JSON.stringify(op.responses['4XX']);
  expect(errors).not.toContain('admin_permission_denied');
});

it('[CT-24b] each hit type names its permission point, and those points are admin_permission values', () => {
  const points = { order: 'order.view', user: 'user.lookup', withdrawal: 'fund.view' };
  expect([...enums.admin_search_hit_type]).toEqual(Object.keys(points));
  const description = search().description.replace(/\s+/g, ' ');
  for (const [type, point] of Object.entries(points)) {
    expect(enums.admin_permission).toContain(point);
    expect(description, type).toContain(`${type} \`${point}\``);
  }
  expect(contract.components.schemas['AdminSearchHitType']!.enum).toEqual(Object.keys(points));
});

it('[CT-24b] data has items (at most 10, each type / id / summary) and truncated', () => {
  const data = contract.components.schemas['AdminSearch']!;
  expect(data.required).toEqual(['items', 'truncated']);
  expect(data.properties!['items']!.maxItems).toBe(10);
  expect(contract.components.schemas['AdminSearchItem']!.required).toEqual([
    'type',
    'id',
    'summary',
  ]);
});

it('[CT-24b] the 200 examples satisfy the schema; the empty one has no items and no truncation', () => {
  const media = okMedia();
  const validate = ajv.compile(media.schema);
  const examples = Object.entries(media.examples ?? {});
  expect(examples.length).toBeGreaterThanOrEqual(2);
  for (const [name, example] of examples) {
    expect(validate(example.value), name).toBe(true);
  }
  const empty = media.examples!['empty']!.value as { data: unknown };
  expect(empty.data).toEqual({ items: [], truncated: false });
  const hit = media.examples!['orderWithOwner']!.value as { data: { items: { type: string }[] } };
  expect(hit.data.items.map((item) => item.type)).toEqual(['order', 'user']);
  const item = { type: 'user', id: 'u', summary: 's' };
  expect(
    validate({
      code: 0,
      msg: '',
      data: { items: Array.from({ length: 11 }, () => item), truncated: true },
      trace_id: 'x',
    }),
  ).toBe(false);
  expect(validate({ code: 0, msg: '', data: { items: [] }, trace_id: 'x' })).toBe(false);
});
