// CT-24a: GET /admin/v1/dashboard, the console workbench (01 F-ADM-26; 04 §6.6 dashboard, §11.1
// dashboard.view). x-implementation is not asserted, so B1-34 can drop planned. Reads the
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
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: { name: string }[];
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-error-codes': number[];
  'x-step-up'?: string;
  'x-idempotent'?: boolean;
};
type Schema = { required?: string[]; properties?: Record<string, Schema>; enum?: string[] };
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

function dashboard(): Operation {
  const op = contract.paths['/admin/v1/dashboard']?.get;
  expect(op, 'GET /admin/v1/dashboard must exist').toBeDefined();
  return op!;
}

const okMedia = (): Media => dashboard().responses['200']!.content!['application/json']!;

it('[CT-24a] GET /admin/v1/dashboard is a read-only admin operation guarded by dashboard.view', () => {
  const op = dashboard();
  expect(op.operationId).toBe('adminGetDashboard');
  expect(op['x-auth']).toBe('admin');
  expect(op.security).toEqual([{ adminBearerAuth: [] }]);
  expect(op.tags).toEqual(['admin-dashboard']);
  expect(op['x-error-codes']).toEqual([10001, 10403]);
  expect(op['x-step-up']).toBeUndefined();
  expect(op['x-idempotent']).toBeUndefined();
  expect((op.parameters ?? []).map((p) => p.name.toLowerCase())).not.toContain('x-step-up-token');
  expect(op.description).toContain('Permission point `dashboard.view`');
  expect(enums.admin_permission[0]).toBe('dashboard.view');
});

it('[CT-24a] each to-do key names its permission point, and those points are admin_permission values', () => {
  const points = {
    withdraw_review_pending: 'withdraw.review',
    claim_review_pending: 'order.claim',
    settle_bill_pending: 'settle.bill',
    recon_diff_open: 'fund.recon',
    appeal_pending: 'risk.appeal',
    agent_report_overdue: 'agent.report',
    beneficiary_held_overdue: 'risk.freeze',
    union_auth_expiring: 'union.account_auth',
  };
  expect([...enums.admin_dashboard_todo_key]).toEqual(Object.keys(points));
  const description = dashboard().description.replace(/\s+/g, ' ');
  for (const [key, point] of Object.entries(points)) {
    expect(enums.admin_permission).toContain(point);
    expect(description, key).toContain(`${key} \`${point}\``);
  }
  expect(contract.components.schemas['AdminDashboardTodoKey']!.enum).toEqual(Object.keys(points));
});

it('[CT-24a] todo and yesterday are required, status is optional, and there is no open_alerts', () => {
  const data = contract.components.schemas['AdminDashboard']!;
  expect(data.required).toEqual(['todo', 'yesterday']);
  expect(Object.keys(data.properties!)).toEqual(['todo', 'yesterday', 'status']);
  const status = data.properties!['status']!;
  expect(status.required).toEqual([
    'payout_queue_paused',
    'payout_channel_paused',
    'settle_auto_enabled',
    'balance_w_expired',
  ]);
  expect(JSON.stringify(okMedia())).not.toContain('open_alerts');
  expect(contract.components.schemas['AdminDashboardTodo']!.required).toEqual([
    'key',
    'count',
    'route',
  ]);
});

it('[CT-24a] the 200 examples satisfy the schema; the account without fund.view has no status', () => {
  const media = okMedia();
  const validate = ajv.compile(media.schema);
  const examples = Object.entries(media.examples ?? {});
  expect(examples.length).toBeGreaterThan(0);
  for (const [name, example] of examples) {
    expect(validate(example.value), name).toBe(true);
  }
  const noFund = media.examples!['noFundView']!.value as { data: Record<string, unknown> };
  expect(noFund.data).not.toHaveProperty('status');
  expect(validate({ code: 0, msg: '', data: { todo: [] }, trace_id: 'x' })).toBe(false);
});
