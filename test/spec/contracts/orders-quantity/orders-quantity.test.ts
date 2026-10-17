import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { baselineWithoutQuantity } from './baseline.ts';

// AC-CT-04b#n 是 D10-43 验收点的本地分组，不新增业务 AC / BR。
// 只静态读取契约和生成类型；不调用接口、不执行生成代码、不读取数据库。
type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const { parse } = apiRequire('@readme/openapi-parser') as {
  parse(path: string): Promise<unknown>;
};

function object(value: unknown): Obj {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Obj;
}

function at(value: unknown, ...keys: string[]): Obj {
  let current = object(value);
  for (const key of keys) {
    expect(current, `缺少 ${keys.join('.')}`).toHaveProperty(key);
    current = object(current[key]);
  }
  return current;
}

function structure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structure);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, item]) => [key, structure(item)]),
  );
}

it.each([
  ['OrderSummary', '/v1/orders', 'listOrders'],
  ['OrderDetail', '/v1/orders/{order_id}', 'getOrder'],
] as const)(
  '[AC-CT-04b#1] %s 的必填 quantity 可空且保留整数约束，其他结构及 planned 状态不变',
  async (name, path, operationId) => {
    const doc = await parse(fileURLToPath(new URL('contracts/openapi.yaml', root)));
    const schema = at(doc, 'components', 'schemas', name);
    const properties = at(schema, 'properties');
    const quantity = at(properties, 'quantity');

    // 一个验收组同时验证放宽与保留项：现状因缺少 null 而断言失败。
    expect(Array.isArray(quantity['type']), `${name}.quantity 必须显式允许 null`).toBe(true);
    expect([...(quantity['type'] as unknown[])].sort()).toEqual(['integer', 'null']);
    expect(quantity['format']).toBe('int32');
    expect(quantity['minimum']).toBe(1);
    expect(schema['required']).toContain('quantity');
    // 不允许用 default / const / enum 填补件数，或额外限制合法的 null / 正整数。
    expect(structure({ ...quantity, type: ['integer', 'null'] })).toEqual({
      type: ['integer', 'null'],
      format: 'int32',
      minimum: 1,
    });

    const otherProperties = { ...properties };
    delete otherProperties['quantity'];
    expect(structure({ ...schema, properties: otherProperties })).toEqual(
      baselineWithoutQuantity(name),
    );
    const operation = at(doc, 'paths', path, 'get');
    expect(operation['operationId']).toBe(operationId);
    expect(operation['x-implementation']).toBe('planned');
  },
);

function namedProperty(node: ts.Node, name: string): ts.PropertySignature {
  const matches: ts.PropertySignature[] = [];
  function visit(child: ts.Node): void {
    if (
      ts.isPropertySignature(child) &&
      (ts.isIdentifier(child.name) || ts.isStringLiteral(child.name)) &&
      child.name.text === name
    ) {
      matches.push(child);
    }
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  expect(matches, `生成类型中的 ${name} 必须唯一存在`).toHaveLength(1);
  return matches[0]!;
}

it.each(['OrderSummary', 'OrderDetail'] as const)(
  '[AC-CT-04b#2] 生成的 %s.quantity 为必填 number | null',
  (name) => {
    const path = new URL('packages/contracts-ts/src/openapi.gen.ts', root);
    const source = ts.createSourceFile(
      fileURLToPath(path),
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const components = source.statements.filter(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === 'components',
    );
    expect(components).toHaveLength(1);
    const schemas = namedProperty(components[0]!, 'schemas');
    const order = namedProperty(schemas, name);
    const quantity = namedProperty(order, 'quantity');
    expect(quantity.questionToken, 'quantity 不能变为可选字段').toBeUndefined();
    expect(quantity.type).toBeDefined();
    const type = quantity.type!;
    // 用 AST 做运行时断言，先红不会造成 tsc 编译失败，也不会只检查注释中的 null。
    expect(ts.isUnionTypeNode(type), `${name}.quantity 缺少 number | null`).toBe(true);
    if (ts.isUnionTypeNode(type)) {
      expect(type.types.map((member) => member.getText(source)).sort()).toEqual(['null', 'number']);
    }
  },
);
