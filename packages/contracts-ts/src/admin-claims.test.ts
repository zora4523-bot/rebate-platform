// CT-24d: GET /admin/v1/claims and GET /admin/v1/claims/{claim_id}, the read side of the claim
// review (01 F-ADM-06; 04 §6.6 claims, §11.1 user.lookup, §11.2 order.claim; BR-ATTR-18).
// x-implementation is not asserted, so the implementing task can drop planned. Reads the
// dereferenced contract and validates the examples with the API workspace's strict Ajv (same
// loader as the admin-audit-logs test).
import { readFileSync } from 'node:fs';
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
const { parseYamlLite } = createRequire(import.meta.url)('../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
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
type Schema = {
  required?: string[];
  properties?: Record<string, Schema>;
  description?: string;
  enum?: string[];
  additionalProperties?: boolean;
};
type Document = {
  paths: Record<string, { get?: Operation }>;
  components: { schemas: Record<string, Schema> };
};
type Row = Record<string, unknown>;

let contract: Document;
let raw: Document;
let ajv: Validator;

beforeAll(async () => {
  const file = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
  contract = (await dereference(file)) as Document;
  raw = parseYamlLite(readFileSync(file, 'utf8')) as Document;
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
const list = (): Operation => op('/admin/v1/claims');
const detail = (): Operation => op('/admin/v1/claims/{claim_id}');
const okMedia = (o: Operation): Media => o.responses['200']!.content!['application/json']!;
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const schema = (name: string): Schema => contract.components.schemas[name]!;

it('[CT-24d] both operations are read only under order.claim or user.lookup, without step-up', () => {
  for (const [o, id] of [
    [list(), 'adminListClaims'],
    [detail(), 'adminGetClaim'],
  ] as const) {
    expect(o.operationId).toBe(id);
    expect(o['x-auth']).toBe('admin');
    expect(o.security).toEqual([{ adminBearerAuth: [] }]);
    expect(o.tags).toEqual(['admin-claims']);
    expect(o['x-error-codes']).toEqual([10001, 10403, 20001]);
    expect(o['x-step-up']).toBeUndefined();
    expect(o['x-idempotent']).toBeUndefined();
    expect((o.parameters ?? []).map((p) => p.name.toLowerCase())).not.toContain('x-step-up-token');
    const text = flat(o.description);
    expect(text).toContain('Permission point `order.claim`');
    expect(text).toContain('`user.lookup`');
    expect(text).toContain('10403 with `data.reason=admin_permission_denied`');
    expect(text).toContain('no step-up');
  }
  expect(enums.admin_permission).toContain('order.claim');
  expect(enums.admin_permission).toContain('user.lookup');
});

it('[CT-24d] the list filters by platform, evidence level, status, user_id and q, page by page', () => {
  const params = list().parameters ?? [];
  expect(params.map((p) => p.name)).toEqual([
    'X-Trace-Id',
    'page',
    'page_size',
    'platform',
    'evidence_level',
    'status',
    'user_id',
    'q',
  ]);
  for (const p of params.slice(1)) {
    expect(p.in, p.name).toBe('query');
    expect(p.required ?? false, p.name).toBe(false);
  }
  const pageSize = params.find((p) => p.name === 'page_size')!.schema as { maximum: number };
  expect(pageSize.maximum).toBe(200);
  const byName = (name: string) => ajv.compile(params.find((p) => p.name === name)!.schema);
  for (const v of enums.claim_status) expect(byName('status')(v), v).toBe(true);
  for (const v of enums.claim_evidence_level) expect(byName('evidence_level')(v), v).toBe(true);
  for (const v of enums.platform) expect(byName('platform')(v), v).toBe(true);
  expect(byName('status')('pending')).toBe(false);
  const text = flat(list().description);
  expect(text).toContain('the user filter takes the user_id only');
  expect(text).toContain('display number of a claim is its claim_id');
  expect(text).toContain('matches exactly');
});

it('[CT-24d] only a user.lookup account must pass user_id; another applicant is the same 20001 as unknown', () => {
  const listText = flat(list().description);
  expect(listText).toContain('may read the list only together with `user_id`');
  const detailParams = detail().parameters ?? [];
  expect(detailParams.map((p) => p.name)).toEqual(['X-Trace-Id', 'claim_id', 'user_id']);
  expect(detailParams.find((p) => p.name === 'claim_id')!.required).toBe(true);
  expect(detailParams.find((p) => p.name === 'user_id')!.required ?? false).toBe(false);
  const detailText = flat(detail().description);
  expect(detailText).toContain('must pass `user_id`');
  expect(detailText).toContain('20001 with `data.fields=[claim_id]`');
  expect(detailText).toContain('the same as an unknown claim_id');
});

it('[CT-24d] auto_matched claims come first, then newest submitted; counts ignore the status filter', () => {
  const text = flat(list().description);
  expect(text).toContain('claims with status `auto_matched` first');
  expect(text).toContain('`submitted_at` descending');
  expect(text).toContain('every filter of the request except `status`');
  const counts = schema('AdminClaimStatusCounts');
  expect([...counts.required!].sort()).toEqual([...enums.claim_status].sort());
  expect(Object.keys(counts.properties!).sort()).toEqual([...enums.claim_status].sort());
  expect(counts.additionalProperties).toBe(false);
  expect(schema('AdminClaimPage').required).toEqual([
    'items',
    'page',
    'page_size',
    'total',
    'counts',
  ]);
});

it('[CT-24d] rows show the applicant as user_id and masked phone only, never the full number', () => {
  const applicant = schema('AdminClaimApplicant');
  expect(applicant.required).toEqual(['user_id', 'phone_masked']);
  expect(Object.keys(applicant.properties!)).toEqual(['user_id', 'phone_masked']);
  const row = schema('AdminClaimListItem');
  expect(row.required).toEqual([
    'claim_id',
    'order_no',
    'platform',
    'user',
    'paid_date',
    'submitted_at',
    'evidence_level',
    'status',
  ]);
  expect(Object.keys(row.properties!)).not.toContain('claim_no');
  const rows = (okMedia(list()).example as { data: { items: Row[] } }).data.items;
  for (const r of rows) {
    const phone = (r['user'] as Row)['phone_masked'];
    if (phone !== null) expect(phone).toMatch(/^\d{3}\*{4}\d{4}$/);
  }
  expect(JSON.stringify(okMedia(detail()).example)).not.toMatch(/1\d{10}/);
});

it('[CT-24d] the detail carries the latest note and child orders with decision, reviewer, row_version and evidence view', () => {
  const claim = schema('AdminClaimDetail');
  expect(claim.required).toEqual([
    'claim_id',
    'order_no',
    'platform',
    'user',
    'paid_date',
    'submitted_at',
    'evidence_level',
    'status',
    'reason',
    'items',
  ]);
  const item = schema('AdminClaimItem');
  expect(item.required).toEqual([
    'item_id',
    'sub_order_id',
    'evidence',
    'decision',
    'reject_reason',
    'decided_at',
    'decided_by',
    'decided_by_name',
    'row_version',
    'matches',
    'evidence_links',
  ]);
  expect(schema('AdminClaimMatch').required).toEqual([
    'field',
    'user_value',
    'union_value',
    'matched',
  ]);
  expect(schema('AdminClaimEvidenceLink').required).toEqual(['at', 'scene']);
  expect(Object.keys(schema('AdminClaimEvidenceLink').properties!)).toEqual(['at', 'scene']);
  expect([...schema('AdminClaimMatchField').enum!]).toEqual([...enums.admin_claim_match_field]);
  expect([...schema('AdminClaimEvidenceLevel').enum!]).toEqual([...enums.claim_evidence_level]);
  expect([...schema('AdminClaimEvidenceScene').enum!].sort()).toEqual([...enums.scene].sort());
  for (const name of [
    'AdminClaimApplicant',
    'AdminClaimListItem',
    'AdminClaimStatusCounts',
    'AdminClaimPage',
    'AdminClaimMatch',
    'AdminClaimEvidenceLink',
    'AdminClaimItem',
    'AdminClaimDetail',
  ]) {
    expect(schema(name).additionalProperties, name).toBe(false);
  }
});

it('[CT-24d] the admin shapes are their own: they do not reference the user-side OrderClaim schemas', () => {
  const text = JSON.stringify(
    Object.entries(raw.components.schemas).filter(([name]) => name.startsWith('AdminClaim')),
  );
  expect(text).not.toContain('#/components/schemas/OrderClaim');
  for (const [name, s] of Object.entries(raw.components.schemas)) {
    if (!name.startsWith('OrderClaim')) continue;
    expect(JSON.stringify(s), name).not.toContain('#/components/schemas/AdminClaim');
  }
  expect(Object.keys(schema('OrderClaimItem').properties!)).toEqual([
    'sub_order_id',
    'decision',
    'reject_reason',
  ]);
});

it('[CT-24d] the examples satisfy the schemas, nulls included; extra fields and bad values fail', () => {
  const listMedia = okMedia(list());
  const validateList = ajv.compile(listMedia.schema);
  expect(validateList(listMedia.example)).toBe(true);
  const listed = (listMedia.example as { data: { items: Row[] } }).data.items;
  expect(listed[0]!['status']).toBe('auto_matched');
  const empty = {
    code: 0,
    msg: '',
    data: {
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
      counts: Object.fromEntries(enums.claim_status.map((s) => [s, 0])),
    },
    trace_id: 'x',
  };
  expect(validateList(empty)).toBe(true);
  const noCounts = structuredClone(empty) as { data: Row };
  delete noCounts.data['counts'];
  expect(validateList(noCounts)).toBe(false);
  const fullPhone = structuredClone(listMedia.example) as { data: { items: Row[] } };
  (fullPhone.data.items[0]!['user'] as Row)['phone'] = '13800005678';
  expect(validateList(fullPhone)).toBe(false);

  const detailMedia = okMedia(detail());
  const validateDetail = ajv.compile(detailMedia.schema);
  expect(validateDetail(detailMedia.example)).toBe(true);
  const items = (detailMedia.example as { data: { items: Row[] } }).data.items;
  expect(items.some((i) => i['decision'] === null && i['decided_by'] === null)).toBe(true);
  expect(items.some((i) => i['decision'] === 'approved' && i['decided_by_name'] !== null)).toBe(
    true,
  );
  const rejected = structuredClone(detailMedia.example) as {
    data: { items: Row[]; reason: unknown };
  };
  rejected.data.reason = '无点击证据，驳回';
  Object.assign(rejected.data.items[1]!, {
    decision: 'rejected',
    reject_reason: 'NO_EVIDENCE',
    decided_at: '2026-10-12T10:30:00+08:00',
    decided_by: null,
    decided_by_name: null,
    evidence_links: [],
  });
  expect(validateDetail(rejected)).toBe(true);
  const rawLink = structuredClone(detailMedia.example) as { data: { items: Row[] } };
  (rawLink.data.items[0]!['evidence_links'] as Row[])[0]!['product_key'] = 'tb:680055550001';
  expect(validateDetail(rawLink)).toBe(false);
  const badReason = structuredClone(detailMedia.example) as { data: { items: Row[] } };
  badReason.data.items[0]!['reject_reason'] = 'TOO_LATE';
  expect(validateDetail(badReason)).toBe(false);
  const noItems = structuredClone(detailMedia.example) as { data: Row };
  noItems.data['items'] = [];
  expect(validateDetail(noItems)).toBe(false);
});
