// CT-20b: the user-side withdrawal responses (GET /v1/withdrawals, GET /v1/withdrawals/{id},
// POST /v1/withdrawals) carry the time points and the server-computed sub-text branch key that
// BR-WDR-25 needs (② 各个时间点, ① 副文案分支), for withdrawals of every channel. Shape only:
// x-implementation is not asserted, so the implementing task can drop planned. Reads the
// dereferenced contract and validates every example with the API workspace's strict Ajv (as
// admin-unions.test.ts does).
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

type Media = { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> };
type Operation = {
  description: string;
  responses: Record<string, { content?: Record<string, Media> }>;
};
type Schema = {
  type?: string | string[];
  enum?: string[];
  format?: string;
  anyOf?: Schema[];
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
};
type Document = {
  paths: Record<string, Partial<Record<'get' | 'post', Operation>>>;
  components: { schemas: Record<string, Schema> };
};

const TIME_POINTS = [
  'review_deadline',
  'executed_at',
  'first_attempt_at',
  'paid_at',
  'confirm_deadline',
] as const;
const ADDED = [...TIME_POINTS, 'channel_state', 'sub_text_branch', 'hold_days'] as const;
const SCHEMAS = ['WithdrawalSummary', 'Withdrawal'] as const;
const OPERATIONS = [
  ['get', '/v1/withdrawals'],
  ['post', '/v1/withdrawals'],
  ['get', '/v1/withdrawals/{withdrawal_id}'],
] as const;
// BR-WDR-25 细则 table, top to bottom (the first and the APPROVED rows share processing; the
// PAID_API / PAID_MANUAL row splits by status, BR-TEXT-06).
const BRANCHES = [
  'processing',
  'wechat_wait_confirm',
  'wechat_confirm_expired',
  'wechat_canceling',
  'wechat_processing',
  'auto_expected_soon',
  'manual_review_pending',
  'manual_review_overdue',
  'channel_processing',
  'paying_delayed',
  'paid_api',
  'paid_manual',
  'rejected',
  'failed_account',
  'failed_other',
  'failed_manual',
];

let contract: Document;
let ajv: Validator;

beforeAll(async () => {
  const file = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
  contract = (await dereference(file)) as Document;
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
});

const schema = (name: string): Schema => contract.components.schemas[name]!;
const flat = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ');
function examplesOf(media: Media): unknown[] {
  const out: unknown[] = [];
  if (media.example !== undefined) out.push(media.example);
  for (const ex of Object.values(media.examples ?? {})) out.push(ex.value);
  return out;
}
function okExamples(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [method, path] of OPERATIONS) {
    const media = contract.paths[path]![method]!.responses['200']!.content!['application/json']!;
    for (const value of examplesOf(media)) {
      const data = (value as { data: Record<string, unknown> }).data;
      const items = data['items'] as Record<string, unknown>[] | undefined;
      rows.push(...(items ?? [data]));
    }
  }
  return rows;
}

it.each(SCHEMAS)(
  '[CT-20b] %s requires the time points, channel_state, sub_text_branch and hold_days, all nullable but the branch',
  (name) => {
    const s = schema(name);
    expect(s.additionalProperties).toBe(false);
    for (const field of ADDED) expect(s.required, field).toContain(field);
    for (const field of TIME_POINTS) {
      expect(s.properties![field], field).toMatchObject({
        type: ['string', 'null'],
        format: 'date-time',
      });
    }
    expect(s.properties!['hold_days']).toMatchObject({ type: ['integer', 'null'], minimum: 1 });
    const state = s.properties!['channel_state']!;
    expect(state.anyOf).toEqual([expect.objectContaining({ type: 'string' }), { type: 'null' }]);
    expect(state.anyOf![0]!.enum).toEqual([...enums.withdrawal_channel_state]);
    expect(s.properties!['sub_text_branch']!.type).toBe('string');
    expect(s.properties!['sub_text_branch']!.enum).toEqual([...enums.withdrawal_sub_text_branch]);
  },
);

it('[CT-20b] the sub-text branch enum has one key per BR-WDR-25 row in table order', () => {
  expect([...enums.withdrawal_sub_text_branch]).toEqual(BRANCHES);
  expect(schema('WithdrawalSubTextBranch').enum).toEqual(BRANCHES);
  const described = flat(schema('WithdrawalSubTextBranch').description);
  expect(described).toContain('BR-WDR-25');
  expect(described).toContain('first matching row');
});

it.each(SCHEMAS)(
  '[CT-20b] %s payout_channel lists every payout_method, wechat included',
  (name) => {
    expect(schema(name).properties!['payout_channel']!.enum).toEqual([...enums.payout_method]);
    expect(enums.payout_method).toContain('wechat');
  },
);

it.each(SCHEMAS)(
  '[CT-20b] %s fail_action is null for a W10 failure (manual_resolution=failed)',
  (name) => {
    const text = flat(schema(name).properties!['fail_action']!.description);
    expect(text).toContain('manual_resolution=failed');
    expect(text).toContain('failed_manual');
  },
);

it('[CT-20b] the descriptions reference BR-WDR-25 without restating its durations or copy', () => {
  for (const name of SCHEMAS) {
    for (const field of ADDED) {
      const text = flat(schema(name).properties![field]!.description);
      expect(text, `${name}.${field}`).not.toMatch(/\d+\s*(hour|minute|day)s?\b|T\s*\+/i);
      expect(text, `${name}.${field}`).not.toMatch(/[一-鿿]{4,}/u);
    }
  }
  expect(flat(schema('WithdrawalSubTextBranch').description)).not.toMatch(/\d+\s*hour|T\s*\+/i);
});

it('[CT-20b] the 200 examples of the three operations satisfy their schemas and cover the new fields', () => {
  for (const [method, path] of OPERATIONS) {
    const op = contract.paths[path]![method]!;
    const ok = op.responses['200']!.content!['application/json']!;
    const validate = ajv.compile(ok.schema);
    const values = examplesOf(ok);
    expect(values.length, path).toBeGreaterThan(0);
    for (const value of values) expect(validate(value), `${method} ${path}`).toBe(true);
    expect(flat(op.description), path).toMatch(/sub_text_branch/);
  }
  const rows = okExamples();
  const branches = rows.map((row) => row['sub_text_branch']);
  expect(branches).toEqual(
    expect.arrayContaining(['manual_review_pending', 'wechat_wait_confirm', 'paid_api']),
  );
  const wechat = rows.find((row) => row['payout_channel'] === 'wechat')!;
  expect(wechat['channel_state']).toBe('wait_user_confirm');
  expect(wechat['confirm_deadline']).not.toBeNull();
  for (const row of rows.filter((r) => r['payout_channel'] !== 'wechat')) {
    expect(row['channel_state']).toBeNull();
    expect(row['confirm_deadline']).toBeNull();
  }
});
