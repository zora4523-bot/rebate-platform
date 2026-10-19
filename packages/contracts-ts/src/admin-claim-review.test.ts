// CT-24l: POST /admin/v1/claims/{claim_id}/items/{item_id}/approve and /reject, the write side of
// the claim review (01 F-ADM-06; 04 §6.6 claims, §7 20902, §11.2 order.claim; BR-ATTR-18,
// BR-ATTR-20). x-implementation is not asserted, so the implementing task can drop planned. Reads
// the dereferenced contract and validates the examples with the API workspace's strict Ajv (same
// loader as the admin-claims test).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { enums, errorCodes } from './index.ts';

// scripts/ is outside this package's rootDir, so it is loaded at run time (as in admin-config.test.ts).
const { ENUM_BINDINGS, ENUM_SUBSETS } = createRequire(import.meta.url)(
  '../scripts/conformance.ts',
) as {
  ENUM_BINDINGS: Readonly<Record<string, string>>;
  ENUM_SUBSETS: Readonly<Record<string, string>>;
};
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
const { parseYamlLite } = createRequire(import.meta.url)('../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

type Media = { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> };
type Parameter = { name: string; in: string; required?: boolean; schema: object };
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody: { required: boolean; content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-error-codes': number[];
  'x-step-up'?: string;
  'x-idempotent'?: boolean;
};
type Ref = { $ref: string };
type RawOperation = {
  requestBody: { content: Record<string, { schema: Ref }> };
  responses: Record<string, { content?: Record<string, { schema: Ref }> }>;
};
type Document = {
  paths: Record<string, { post?: Operation; get?: Operation }>;
  components: { schemas: Record<string, { enum?: string[] }> };
};
type RawDocument = { paths: Record<string, { post?: RawOperation; get?: RawOperation }> };
type Row = Record<string, unknown>;
type Detail = { data: { status: string; reason: unknown; items: Row[] } };

const base = '/admin/v1/claims/{claim_id}/items/{item_id}';
let contract: Document;
let raw: RawDocument;
let ajv: Validator;

beforeAll(async () => {
  const file = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
  contract = (await dereference(file)) as Document;
  raw = parseYamlLite(readFileSync(file, 'utf8')) as RawDocument;
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
});

function op(action: 'approve' | 'reject'): Operation {
  const found = contract.paths[`${base}/${action}`]?.post;
  expect(found, `POST ${base}/${action} must exist`).toBeDefined();
  return found!;
}
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const okMedia = (o: Operation): Media => o.responses['200']!.content!['application/json']!;
const body = (o: Operation): Media => o.requestBody.content['application/json']!;
const examples = (o: Operation): unknown[] => {
  const media = okMedia(o);
  return media.examples ? Object.values(media.examples).map((e) => e.value) : [media.example];
};
const reviewed = (example: unknown): Row =>
  (example as Detail).data.items.find(
    (i) => i['item_id'] === '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5ab2',
  )!;

it('[CT-24l] approve and reject are order.claim only, without step-up or Idempotency-Key', () => {
  for (const [o, id] of [
    [op('approve'), 'adminApproveClaimItem'],
    [op('reject'), 'adminRejectClaimItem'],
  ] as const) {
    expect(o.operationId).toBe(id);
    expect(o['x-auth']).toBe('admin');
    expect(o.security).toEqual([{ adminBearerAuth: [] }]);
    expect(o.tags).toEqual(['admin-claims']);
    expect(o['x-error-codes']).toEqual([10001, 10403, 20001, 20902]);
    expect(o['x-step-up']).toBeUndefined();
    expect(o['x-idempotent']).toBeUndefined();
    const names = (o.parameters ?? []).map((p) => p.name.toLowerCase());
    expect(names).toEqual(['x-trace-id', 'claim_id', 'item_id']);
    expect(o.requestBody.required).toBe(true);
    const text = flat(o.description);
    expect(text).toContain('Permission point `order.claim` (04 §11.2) only');
    expect(text).toContain('10403 with `data.reason=admin_permission_denied`');
    expect(text).toContain('One child order per call');
  }
  expect(enums.admin_permission).toContain('order.claim');
});

it('[CT-24l] the response is the whole claim, the same schema as the claim detail', () => {
  const detailRef =
    raw.paths['/admin/v1/claims/{claim_id}']!.get!.responses['200']!.content!['application/json']!
      .schema.$ref;
  for (const action of ['approve', 'reject'] as const) {
    const ref =
      raw.paths[`${base}/${action}`]!.post!.responses['200']!.content!['application/json']!.schema
        .$ref;
    expect(ref, action).toBe(detailRef);
    expect(ref).toBe('#/components/schemas/AdminClaimDetailResponse');
  }
});

it('[CT-24l] bodies take expected_row_version and a 5–200 character note; reject adds reject_reason', () => {
  const approve = ajv.compile(body(op('approve')).schema);
  const reject = ajv.compile(body(op('reject')).schema);
  expect(approve(body(op('approve')).example)).toBe(true);
  expect(reject(body(op('reject')).example)).toBe(true);
  expect(approve({ expected_row_version: 0, reason: '证据核实一致' })).toBe(true);
  expect(approve({ expected_row_version: 0, reason: '一二三四' })).toBe(false);
  expect(approve({ expected_row_version: 0, reason: '一二三四五' })).toBe(true);
  expect(approve({ expected_row_version: 0, reason: '字'.repeat(200) })).toBe(true);
  expect(approve({ expected_row_version: 0, reason: '字'.repeat(201) })).toBe(false);
  expect(approve({ reason: '证据核实一致' })).toBe(false);
  expect(approve({ expected_row_version: 0 })).toBe(false);
  expect(approve({ expected_row_version: -1, reason: '证据核实一致' })).toBe(false);
  expect(approve({ expected_row_version: 0, reason: '证据核实一致', item_id: 'x' })).toBe(false);
  expect(reject({ expected_row_version: 0, reason: '证据核实一致' })).toBe(false);
  for (const text of [op('approve'), op('reject')].map((o) => flat(o.description))) {
    expect(text).toContain('5–200 characters');
    expect(text).toContain('`data.fields=[reason]`');
  }
  expect(flat(op('approve').description)).toContain('trimming surrounding whitespace');
});

it('[CT-24l] reject_reason is the six reviewer codes, a registered subset of claim_reject_reason', () => {
  const staff = contract.components.schemas['AdminClaimStaffRejectReason']!.enum!;
  expect(staff).toEqual(enums.claim_reject_reason.slice(0, 6));
  expect(staff).toEqual([
    'NO_EVIDENCE',
    'EXPIRED_CLICK',
    'NOT_TRACKED',
    'OTHER_TLJ',
    'FRAUD',
    'OTHER',
  ]);
  expect(ENUM_SUBSETS['AdminClaimStaffRejectReason']).toBe('claim_reject_reason');
  expect(Object.keys(ENUM_BINDINGS)).not.toContain('AdminClaimStaffRejectReason');
  const reject = ajv.compile(body(op('reject')).schema);
  for (const code of staff) {
    expect(
      reject({ expected_row_version: 1, reason: '证据核实不一致', reject_reason: code }),
      code,
    ).toBe(true);
  }
  for (const code of ['NOT_IN_POOL', 'ORDER_INVALID', 'TOO_LATE']) {
    expect(
      reject({ expected_row_version: 1, reason: '证据核实不一致', reject_reason: code }),
      code,
    ).toBe(false);
  }
  expect(flat(op('reject').description)).toContain('`data.fields=[reject_reason]`');
});

it('[CT-24l] a decided or changed child order is 20902 claim_item; unknown ids are 20001', () => {
  expect(errorCodes[20902].data.resource).toContain('claim_item');
  const approve = flat(op('approve').description);
  expect(approve).toContain('20902 with `data.resource=claim_item`');
  expect(approve).toContain('`data.fields=[claim_id]`');
  expect(approve).toContain('`data.fields=[item_id]`');
  expect(flat(op('reject').description)).toContain('20902 with `data.resource=claim_item`');
});

it('[CT-24l] approval follows BR-ATTR-20: the lock, then auto closing an attributed order with 200, then ORDER_INVALID', () => {
  const text = flat(op('approve').description);
  expect(text).toContain('pg_advisory_xact_lock(hash(platform, sub_order_id))');
  expect(text).toContain('SELECT … FOR UPDATE');
  expect(text).toContain('`cancelled` when that user_id is the applicant');
  expect(text).toContain('`rejected` with `reject_reason=NOT_IN_POOL`');
  expect(text).toContain('This is not an error: the answer is 200');
  expect(text).toContain('「订单已被自动归属」');
  expect(text).toContain('`reject_reason=ORDER_INVALID`');
  expect(text).toContain('rejected with NOT_IN_POOL in the same transaction');
  expect(text.indexOf('NOT_IN_POOL')).toBeLessThan(text.indexOf('ORDER_INVALID'));
  for (const o of [op('approve'), op('reject')]) {
    expect(flat(o.description)).toContain('claims.reason');
    expect(flat(o.description)).toContain('audit log');
  }
});

it('[CT-24l] the examples satisfy the claim detail schema and show the reviewed child order', () => {
  const approve = op('approve');
  const validate = ajv.compile(okMedia(approve).schema);
  const [approved, auto] = examples(approve);
  expect(validate(approved)).toBe(true);
  expect(validate(auto)).toBe(true);
  expect(reviewed(approved)['decision']).toBe('approved');
  expect(reviewed(approved)['decided_by']).not.toBeNull();
  expect(reviewed(auto)['decision']).toBe('rejected');
  expect(reviewed(auto)['reject_reason']).toBe('NOT_IN_POOL');
  expect(reviewed(auto)['decided_by']).toBeNull();
  for (const example of [approved, auto]) {
    expect((example as Detail).data.reason).toBe('证据核实一致');
    expect((example as Detail).data.status).toBe('approved');
  }

  const reject = op('reject');
  const [rejected, invalid] = examples(reject);
  expect(ajv.compile(okMedia(reject).schema)(rejected)).toBe(true);
  expect(ajv.compile(okMedia(reject).schema)(invalid)).toBe(true);
  expect(reviewed(rejected)['reject_reason']).toBe('NO_EVIDENCE');
  expect(reviewed(rejected)['decided_by']).not.toBeNull();
  expect(reviewed(invalid)['decision']).toBe('rejected');
  expect(reviewed(invalid)['reject_reason']).toBe('ORDER_INVALID');
  expect(reviewed(invalid)['decided_by']).toBeNull();
  expect(reviewed(invalid)['decided_by_name']).toBeNull();
  for (const example of [rejected, invalid]) {
    expect((example as Detail).data.reason).toBe(
      (body(reject).example as { reason: string }).reason,
    );
  }
  const extra = structuredClone(rejected) as Detail & { data: Row };
  extra.data['auto_closed'] = true;
  expect(validate(extra)).toBe(false);
});

it('[CT-24l] rejecting a VOID order is a system rejection with ORDER_INVALID under BR-ATTR-18', () => {
  const text = flat(op('reject').description);
  expect(text).toContain('pg_advisory_xact_lock(hash(platform, sub_order_id))');
  expect(text).toContain('SELECT … FOR UPDATE');
  expect(text).toContain("The order's rebate_status is VOID");
  expect(text).toContain('`reject_reason=ORDER_INVALID`');
  expect(text).toContain('`decided_by` is null');
  expect(text).toContain('This is not an error: the answer is 200');
  expect(text.indexOf('ORDER_INVALID`')).toBeLessThan(text.indexOf('`decided_by` the reviewer'));
  expect(text).toContain('claims.reason');
  expect(text).toContain('the reject reason the reviewer chose');
});
