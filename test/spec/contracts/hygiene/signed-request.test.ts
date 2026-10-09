import { expect, it } from 'vitest';
import { at, object, read, testRequire, text } from './kit.ts';

it('[AC-CT-01e#7] signedRequest 路径拒绝空段、保留合法路径和查询串，生成物与源契约一致', async () => {
  const schema = object(JSON.parse(read('contracts/bridge.schema.json')) as unknown);
  const path = at(schema, 'methods', 'net.signedRequest', 'params', 'properties', 'path');
  const pattern = new RegExp(text(path['pattern']));
  for (const valid of ['/v1/a', '/v1/a/b-c_d', '/v1/a?x=1']) {
    expect(pattern.test(valid), `合法路径 ${valid}`).toBe(true);
  }

  // 类型生成器不保留 JSON Schema 正则；比较完整渲染结果，检查它实际生成的所有字段。
  // 这里只在内存渲染，不调用会写生成物的 codegen CLI。
  const { loadEnums, loadErrorCodes } = testRequire(
    '../../../../packages/contracts-ts/scripts/catalog.ts',
  ) as typeof import('../../../../packages/contracts-ts/scripts/catalog.ts');
  const { loadBridgeCatalog, renderBridge } =
    await import('../../../../packages/contracts-ts/scripts/bridge.ts');
  const catalog = loadBridgeCatalog(loadEnums(), loadErrorCodes().ranges);
  const rendered = await renderBridge(catalog);
  const generated = read('packages/contracts-ts/src/bridge.gen.ts');
  expect(generated.replace(/^(?:\/\/[^\n]*\n)*\n/u, '')).toBe(rendered);

  const invalid = ['/v1//x', '/v1/', '/v1/a/', '/v1/a//b'];
  expect(
    invalid.filter((value) => pattern.test(value)),
    '这些路径含空段，必须全部拒绝',
  ).toEqual([]);
}, 30_000);
