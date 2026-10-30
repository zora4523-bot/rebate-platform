// F1-02zzq §9.2 ② / §9.3 ③: ConfigNickname is the closed {min_len, max_len, monthly_limit}
// object of Config.nickname, and the 「Not returned until its implementation is merged.」 note is
// gone from the contract and from the generated TypeScript (pnpm codegen).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { NICKNAME } from './nickname-kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
const PENDING_NOTE = 'Not returned until its implementation is merged';
const MEMBERS = ['max_len', 'min_len', 'monthly_limit'];

interface ObjectSchema {
  description?: string;
  additionalProperties?: unknown;
  required?: string[];
  properties: Record<string, Record<string, unknown>>;
}

async function schemas() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ components: { schemas: Record<string, ObjectSchema> } }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  return doc.components.schemas;
}

function flat(text: string): string {
  return text.replace(/[\s*]+/g, ' ');
}

it('[AC-F1-02zzq#6] 契约 ConfigNickname 去掉待合并说明，仍是封闭的三整数对象并接受规则值', async () => {
  const all = await schemas();
  const nickname = all['ConfigNickname']!;
  expect(flat(nickname.description ?? '')).toContain('BR-ID-39');
  expect(flat(nickname.description ?? '')).not.toContain(PENDING_NOTE);
  expect(all['Config']!.properties['nickname']).toEqual(nickname);
  expect(nickname.additionalProperties).toBe(false);
  expect([...(nickname.required ?? [])].sort()).toEqual(MEMBERS);
  expect(Object.keys(nickname.properties).sort()).toEqual(MEMBERS);
  for (const member of MEMBERS) {
    expect(nickname.properties[member]).toMatchObject({
      type: 'integer',
      format: 'int32',
      minimum: 1,
    });
  }
  const check = createValidatorCompiler()({
    schema: nickname as unknown as JsonSchema,
    httpPart: 'body',
  });
  expect(check({ ...NICKNAME })).toBe(true);
  expect(check({ ...NICKNAME, extra: 1 })).toBe(false);
  expect(check({ min_len: 1, max_len: 16 })).toBe(false);
  expect(check({ ...NICKNAME, max_len: '16' })).toBe(false);
});

it('[AC-F1-02zzq#6] 生成的 openapi.gen.ts 中 ConfigNickname 注释已同步去掉待合并说明', () => {
  const generated = readFileSync(
    fileURLToPath(new URL('packages/contracts-ts/src/openapi.gen.ts', ROOT)),
    'utf8',
  );
  const at = generated.indexOf('ConfigNickname: {');
  expect(at).toBeGreaterThan(0);
  const doc = flat(generated.slice(generated.lastIndexOf('/**', at), at));
  expect(doc).toContain('BR-ID-39');
  expect(doc).not.toContain(PENDING_NOTE);
});
