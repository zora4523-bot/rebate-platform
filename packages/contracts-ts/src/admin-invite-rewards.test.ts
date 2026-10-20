// CT-25a: the invite reward campaign in the contract (BR-INV-24; 04 §3.2 invite_rewards, §6.6
// invite-rewards, §10.1 invite). Console read-only list and detail, the enums behind them, and the
// two optional /v1/config invite keys. x-implementation is not asserted, so the implementing task
// can drop planned. Reads the dereferenced contract and validates the examples with the API
// workspace's strict Ajv (same loader as admin-search.test.ts).
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
  type?: string | string[];
  format?: string;
  minimum?: number;
  deprecated?: boolean;
  required?: string[];
  properties?: Record<string, Schema>;
  enum?: string[];
};
type Document = {
  paths: Record<string, { get?: Operation; post?: Operation; put?: Operation }>;
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

const LIST = '/admin/v1/invite-rewards';
const DETAIL = '/admin/v1/invite-rewards/{invitee_id}';

it('[CT-25a] list and detail are read-only admin operations under fund.view, without step-up or idempotency key', () => {
  const cases: [string, string, number[]][] = [
    [LIST, 'adminListInviteRewards', [10001, 10403, 20001]],
    [DETAIL, 'adminGetInviteReward', [10001, 10403, 20001, 30701]],
  ];
  for (const [path, id, codes] of cases) {
    const o = op(path);
    expect(o.operationId).toBe(id);
    expect(o['x-auth']).toBe('admin');
    expect(o.security).toEqual([{ adminBearerAuth: [] }]);
    expect(o.tags).toEqual(['admin-users']);
    expect(o['x-error-codes']).toEqual(codes);
    expect(o['x-step-up']).toBeUndefined();
    expect(o['x-idempotent']).toBeUndefined();
    const names = (o.parameters ?? []).map((p) => p.name.toLowerCase());
    expect(names).not.toContain('idempotency-key');
    expect(names).not.toContain('x-step-up-token');
    expect(o.description).toContain('`fund.view`');
    expect(enums.admin_permission).toContain('fund.view');
    expect(enums.admin_permission).toContain('pii.reveal_phone');
    const others = contract.paths[path]!;
    expect(others.post).toBeUndefined();
    expect(others.put).toBeUndefined();
  }
  const filters = op(LIST).parameters!.map((p) => p.name);
  for (const name of ['invitee_id', 'inviter_id', 'status', 'qualified_from', 'qualified_to'])
    expect(filters).toContain(name);
});

it('[CT-25a] the five enum schemas mirror contracts/enums', () => {
  const pairs: [string, readonly string[]][] = [
    ['AdminInviteRewardStatus', enums.invite_reward_status],
    ['AdminInviteRewardPartyResult', enums.invite_reward_party_result],
    ['AdminInviteRewardSkipReason', enums.invite_reward_skip_reason],
    ['AdminInviteRewardVoidReason', enums.invite_reward_void_reason],
    ['AdminInviteRewardBindSource', enums.invite_reward_bind_source],
  ];
  for (const [schema, values] of pairs)
    expect(contract.components.schemas[schema]!.enum, schema).toEqual([...values]);
  expect([...enums.invite_reward_status]).toEqual([
    'qualified',
    'deferred',
    'processed',
    'voided',
    'expired',
  ]);
  expect([...enums.invite_reward_status]).not.toContain('budget_exhausted');
  expect([...enums.invite_reward_bind_source]).not.toContain('admin');
});

it('[CT-25a] a record carries no client IP, HMAC or voucher id, and amounts are int64 fen', () => {
  const record = contract.components.schemas['AdminInviteReward']!;
  const props = Object.keys(record.properties!);
  for (const name of props) expect(name).not.toMatch(/(^|_)(ip|hmac|voucher)(_|$)/);
  expect(record.required).toEqual(props);
  const amount = record.properties!['amount_fen']!;
  expect(amount.format).toBe('int64');
  expect(amount.minimum).toBe(0);
  const days = record.properties!['eligibility_days']!;
  expect(days.type).toBe('integer');
  expect(days.minimum).toBe(1);
  const budget = contract.components.schemas['AdminInviteRewardBudget']!;
  expect(budget.properties!['today']!.required).toEqual(['date', 'granted_fen']);
  expect(budget.properties!['total']!.required).toEqual(['reserved_fen', 'granted_fen']);
});

it('[CT-25a] the 200 examples satisfy the schema', () => {
  for (const path of [LIST, DETAIL]) {
    const media = op(path).responses['200']!.content!['application/json']!;
    const validate = ajv.compile(media.schema);
    expect(validate(media.example), path).toBe(true);
  }
  const list = op(LIST).responses['200']!.content!['application/json']!;
  const validate = ajv.compile(list.schema);
  const broken = structuredClone(list.example) as { data: { items: Record<string, unknown>[] } };
  broken.data.items[0]!['bind_ip_hmac'] = 'x';
  expect(validate(broken)).toBe(false);
});

it('[CT-25a] ConfigInvite adds optional reward_enabled and reward_amount_fen; before_buy_tip is deprecated, not removed', () => {
  const invite = contract.components.schemas['ConfigInvite']!;
  expect(invite.required).toEqual(['required', 'backfill_hours']);
  expect(invite.properties!['reward_enabled']!.type).toBe('boolean');
  const amount = invite.properties!['reward_amount_fen']!;
  expect(amount.type).toBe('integer');
  expect(amount.minimum).toBe(0);
  expect(invite.properties!['before_buy_tip']!.deprecated).toBe(true);
  expect([...enums.tip_key]).toContain('inviter_before_buy');
  expect(contract.components.schemas['TipsData']!.required).toContain('inviter_before_buy');
});
