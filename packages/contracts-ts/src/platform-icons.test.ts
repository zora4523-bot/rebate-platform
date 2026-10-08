// CT-17f: /v1/config platform_icons, the platform mark replacement images (04 §10.1, BR-TEXT-24).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, expectTypeOf, it } from 'vitest';
import type { Schema } from './index.ts';

// Reuse the API workspace's installed contract validator (ADR-0001 §4.2 #15).
// This test-only loader adds no runtime dependency from contracts-ts to the API.
const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
interface ContractValidator {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): (data: unknown) => boolean;
}
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => ContractValidator;
};
const addFormats = apiRequire('ajv-formats') as (ajv: ContractValidator) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};

type ConfigExample = { data: Record<string, unknown> };
type ContractDocument = {
  paths: {
    '/v1/config': {
      get: {
        responses: { '200': { content: { 'application/json': { example: ConfigExample } } } };
      };
    };
  };
  components: {
    schemas: Record<string, object & { required?: string[]; properties?: Record<string, object> }>;
  };
};

const MARK_KEYS = ['taobao', 'tmall', 'jd', 'pdd', 'wechat', 'wechat_pay', 'alipay', 'wecom'];
const DIGEST = '88e2cce43eeadb36ce19668116709ef3f6f44b7b364d4d23fd545d2af826e6da';
const icon = { url: `https://media.example.test/${DIGEST}.svg`, sha256: DIGEST, version: 1 };

let contract: ContractDocument;
let validateIcons: (data: unknown) => boolean;
let validateConfig: (data: unknown) => boolean;

beforeAll(async () => {
  contract = (await dereference(
    fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url)),
  )) as ContractDocument;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  validateIcons = ajv.compile(contract.components.schemas['ConfigPlatformIcons']!);
  validateConfig = ajv.compile(contract.components.schemas['Config']!);
});

it('[CT-17f] platform_icons is an optional Config key (04 §10.1, 04 §5「兼容」)', () => {
  const config = contract.components.schemas['Config']!;
  expect(config.properties).toHaveProperty('platform_icons');
  expect(config.required).not.toContain('platform_icons');
  const example =
    contract.paths['/v1/config'].get.responses['200'].content['application/json'].example.data;
  expect(validateConfig(example)).toBe(true);
  const withoutIcons: Record<string, unknown> = { ...example };
  delete withoutIcons['platform_icons'];
  expect(validateConfig(withoutIcons)).toBe(true);
});

it('[CT-17f] lists only the BR-TEXT-24 mark keys, each optional, and may be empty', () => {
  expect(validateIcons({})).toBe(true);
  for (const key of MARK_KEYS) {
    expect(validateIcons({ [key]: icon }), key).toBe(true);
  }
  expect(validateIcons(Object.fromEntries(MARK_KEYS.map((key) => [key, icon])))).toBe(true);
  for (const key of ['douyin', 'unionpay', 'Alipay', 'wechat-pay']) {
    expect(validateIcons({ [key]: icon }), key).toBe(false);
  }
  expect(validateIcons({ alipay: null })).toBe(false);
});

it('[CT-17f] an image needs an https url, a lowercase hex SHA-256 and a version from 1', () => {
  for (const field of ['url', 'sha256', 'version'] as const) {
    const partial: Record<string, unknown> = { ...icon };
    delete partial[field];
    expect(validateIcons({ alipay: partial }), `missing ${field}`).toBe(false);
  }
  const bad: Record<string, unknown>[] = [
    { url: `http://media.example.test/${DIGEST}.svg` },
    { url: 'not a url' },
    { url: `https://media.example.test/${'a'.repeat(2048)}` },
    { sha256: DIGEST.toUpperCase() },
    { sha256: DIGEST.slice(1) },
    { sha256: `${DIGEST}0` },
    { version: 0 },
    { version: 1.5 },
    { version: '1' },
    { alt: '支付宝' },
  ];
  for (const change of bad) {
    expect(validateIcons({ alipay: { ...icon, ...change } }), JSON.stringify(change)).toBe(false);
  }
  expect(validateIcons({ alipay: { ...icon, version: 7 } })).toBe(true);
});

it('[CT-17f] the generated Config type keeps platform_icons optional', () => {
  expectTypeOf<Schema<'Config'>['platform_icons']>().toEqualTypeOf<
    Schema<'ConfigPlatformIcons'> | undefined
  >();
  expectTypeOf<Schema<'ConfigPlatformIcon'>>().toEqualTypeOf<{
    url: string;
    sha256: string;
    version: number;
  }>();
});
