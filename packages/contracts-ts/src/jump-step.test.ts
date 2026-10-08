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

it('CT-02e: a Baichuan instruction with an unknown provider, open_by or property is refused', () => {
  expect(validateStep(withSdk(byUrl, { provider: 'kepler' }))).toBe(false);
  expect(validateStep(withSdk(byUrl, { open_by: 'scheme' }))).toBe(false);
  expect(validateStep(withSdk(byUrl, { extra: true }))).toBe(false);
  expect(validateStep({ ...byUrl, sdk: without(byUrl.sdk, 'provider') })).toBe(false);
});

// The schema keeps JumpStep.sdk optional (round 2: a top-level oneOf on the already-served open
// response was breaking for oasdiff), so "sdk exactly for type=sdk" is a server-side guarantee
// (linking, B1-06f). These two cases document that the schema alone does not enforce it, and the
// contract's own examples and this file's fixtures are held to the pairing instead.
it('CT-02e: the schema alone does not pair sdk with type=sdk (server-side guarantee)', () => {
  expect(validateStep({ type: 'sdk', value: 'https://s.click.example.test/t?e=abc' })).toBe(true);
  expect(validateStep({ ...byUrl, type: 'universal_link' })).toBe(true);
});

// Walks the dereferenced contract (shared and possibly circular objects, hence `seen`).
function jumpSteps(
  node: unknown,
  found: Record<string, unknown>[] = [],
  seen = new WeakSet<object>(),
): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object' || seen.has(node)) return found;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) jumpSteps(item, found, seen);
  } else {
    for (const [key, child] of Object.entries(node)) {
      const steps = key === 'primary' ? [child] : key === 'fallbacks' ? child : [];
      for (const step of Array.isArray(steps) ? steps : []) {
        if (
          step !== null &&
          typeof step === 'object' &&
          (enums.jump_type as readonly unknown[]).includes((step as { type?: unknown }).type) &&
          typeof (step as { value?: unknown }).value === 'string'
        ) {
          found.push(step as Record<string, unknown>);
        }
      }
      jumpSteps(child, found, seen);
    }
  }
  return found;
}

it('CT-02e: every jump step in the contract examples and these fixtures pairs sdk with type=sdk', () => {
  const steps = [...jumpSteps(contract), byCode, byUrl];
  expect(steps.filter((step) => step['type'] === 'sdk').length).toBeGreaterThanOrEqual(4);
  for (const step of steps) {
    expect('sdk' in step, JSON.stringify(step)).toBe(step['type'] === 'sdk');
    expect(validateStep(step), JSON.stringify(step)).toBe(true);
  }
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

it('CT-02e: the generated type requires taoke on open_by=code and jump_type still lists sdk', () => {
  const missing: Schema<'JumpStep'> = {
    type: 'sdk',
    value: '9876543210abc',
    // @ts-expect-error an open_by=code instruction without taoke
    sdk: { provider: 'baichuan', open_by: 'code', page: 'detail', item_id: '9876543210abc' },
  };
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
