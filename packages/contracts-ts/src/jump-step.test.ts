// CT-02e: the Taobao Baichuan open instruction on a jump step (docs/changes/20261003 §3 of the
// planning repository; 04 §8.4). Reads the dereferenced contract and checks JumpStep and the
// open-link examples with the API workspace's strict Ajv (same loader as openapi.test.ts).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { enums, type Schema } from './index.ts';

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

type Document = {
  components: {
    schemas: Record<string, object>;
    examples: Record<string, { value: { data: { jump: { primary: unknown } } } }>;
  };
};

let contract: Document;
let validateStep: (data: unknown) => boolean;
let validateOpenResponse: (data: unknown) => boolean;

beforeAll(async () => {
  contract = (await dereference(
    fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url)),
  )) as Document;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  validateStep = ajv.compile(contract.components.schemas['JumpStep']!);
  validateOpenResponse = ajv.compile(contract.components.schemas['OpenLinkResponse']!);
});

const byCode = {
  type: 'sdk',
  value: '9876543210abc',
  sdk: {
    provider: 'baichuan',
    open_by: 'code',
    page: 'detail',
    item_id: '9876543210abc',
    taoke: { pid: 'mm_1_2_3', relation_id: '1001' },
  },
};
const byUrl = {
  type: 'sdk',
  value: 'https://s.click.example.test/t?e=abc',
  sdk: { provider: 'baichuan', open_by: 'url', url: 'https://s.click.example.test/t?e=abc' },
};

function without(sdk: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(sdk).filter(([k]) => k !== key));
}

function withSdk(base: typeof byCode | typeof byUrl, sdk: Record<string, unknown>): unknown {
  return { ...base, sdk: { ...base.sdk, ...sdk } };
}

it('CT-02e: an open_by=code step with taoke and an open_by=url step without it are valid', () => {
  expect(validateStep(byCode)).toBe(true);
  expect(validateStep(withSdk(byCode, { sku_id: '5566' }))).toBe(true);
  expect(validateStep({ ...byCode, sdk: { ...byCode.sdk, taoke: { pid: 'mm_1_2_3' } } })).toBe(
    true,
  );
  expect(validateStep(byUrl)).toBe(true);
  expect(validateStep({ type: 'scheme', value: 'openapp.example://virtual?params=abc' })).toBe(
    true,
  );
});

it('CT-02e: open_by=code without taoke, page or item_id, or with a malformed pid, is refused', () => {
  for (const key of ['taoke', 'page', 'item_id']) {
    expect(validateStep({ ...byCode, sdk: without(byCode.sdk, key) }), key).toBe(false);
  }
  for (const pid of ['mm_1_2', 'pid_1_2_3', 'mm_a_2_3', 'mm_1_2_3 ', '']) {
    expect(validateStep(withSdk(byCode, { taoke: { pid } })), pid).toBe(false);
  }
  expect(validateStep(withSdk(byCode, { taoke: { relation_id: '1001' } }))).toBe(false);
  expect(validateStep(withSdk(byCode, { taoke: { pid: 'mm_1_2_3', extra: 'x' } }))).toBe(false);
  expect(validateStep(withSdk(byCode, { url: 'https://s.click.example.test/t?e=abc' }))).toBe(
    false,
  );
});

it('CT-02e: open_by=url with taoke or code parameters, or without url, is refused', () => {
  expect(validateStep(withSdk(byUrl, { taoke: { pid: 'mm_1_2_3' } }))).toBe(false);
  expect(validateStep(withSdk(byUrl, { item_id: '9876543210abc' }))).toBe(false);
  expect(validateStep(withSdk(byUrl, { page: 'detail' }))).toBe(false);
  expect(validateStep(withSdk(byUrl, { sku_id: '5566' }))).toBe(false);
  expect(validateStep({ ...byUrl, sdk: without(byUrl.sdk, 'url') })).toBe(false);
  expect(validateStep(withSdk(byUrl, { url: 'not a url' }))).toBe(false);
});

it('CT-02e: sdk is required exactly for type=sdk', () => {
  expect(validateStep({ type: 'sdk', value: 'https://s.click.example.test/t?e=abc' })).toBe(false);
  for (const type of ['scheme', 'universal_link', 'h5', 'copy_tpwd']) {
    expect(validateStep({ ...byUrl, type }), type).toBe(false);
  }
  expect(validateStep(withSdk(byUrl, { provider: 'kepler' }))).toBe(false);
  expect(validateStep(withSdk(byUrl, { open_by: 'scheme' }))).toBe(false);
  expect(validateStep(withSdk(byUrl, { extra: true }))).toBe(false);
});

it('CT-02e: the Taobao open examples carry one open_by=code and one open_by=url step', () => {
  const examples = contract.components.examples;
  const unchanged = examples['OpenLinkUnchanged']!.value;
  const compare = examples['OpenLinkPriceCompare']!.value;
  expect(validateOpenResponse(unchanged)).toBe(true);
  expect(validateOpenResponse(compare)).toBe(true);
  expect(validateOpenResponse(examples['OpenLinkPriceChanged']!.value)).toBe(true);
  expect(unchanged.data.jump.primary).toMatchObject({
    type: 'sdk',
    sdk: { provider: 'baichuan', open_by: 'code', taoke: { pid: 'mm_1_2_3' } },
  });
  expect(compare.data.jump.primary).toMatchObject({
    type: 'sdk',
    sdk: { provider: 'baichuan', open_by: 'url' },
  });
  expect(compare.data.jump.primary).not.toHaveProperty('sdk.taoke');
});

it('CT-02e: the generated type requires sdk on a type=sdk step and jump_type still lists sdk', () => {
  // @ts-expect-error a type=sdk step without the open instruction
  const missing: Schema<'JumpStep'> = { type: 'sdk', value: 'x' };
  const code: Schema<'JumpStep'> = {
    type: 'sdk',
    value: '9876543210abc',
    sdk: {
      provider: 'baichuan',
      open_by: 'code',
      page: 'detail',
      item_id: '9876543210abc',
      taoke: { pid: 'mm_1_2_3' },
    },
  };
  expect([missing, code]).toHaveLength(2);
  expect(enums.jump_type).toContain('sdk');
});
