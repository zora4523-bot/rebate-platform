import { expect, it } from 'vitest';
import {
  at,
  claimSchema,
  compile,
  check,
  contract,
  enumValues,
  itemSchema,
  list,
  resolve,
  yaml,
  type Obj,
} from './kit.ts';
import { bindings } from './source-kit.ts';

it('[CT-04f#10] 三个找回枚举均登记 ENUM_BINDINGS，绑定 schema 与枚举源及独立预期一致', () => {
  const registered = bindings();
  const doc = contract();
  const catalog = at(yaml('contracts/enums/order.yaml'), 'enums');
  for (const [name, expected] of Object.entries(enumValues)) {
    const pointers = Object.entries(registered)
      .filter(([, value]) => value === name)
      .map(([pointer]) => pointer);
    expect(pointers.length, `ENUM_BINDINGS 缺少 ${name}`).toBeGreaterThan(0);
    expect(Object.keys(at(catalog, name, 'values')).toSorted()).toEqual(expected.toSorted());
    for (const pointer of pointers) {
      const schema = at(doc, 'components', 'schemas', ...pointer.split('/'));
      expect(schema['type']).toBe('string');
      expect(list(schema['enum']).toSorted()).toEqual(expected.toSorted());
    }
  }
});

// 允许 anyOf / oneOf 表达可空引用，不把新增组件名或书写方式写死。
function enumReference(doc: Obj, value: Obj): string {
  if (value['$ref'] !== undefined) {
    const resolved = resolve(doc, value);
    if (resolved['enum'] !== undefined) return String(value['$ref']);
    return enumReference(doc, resolved);
  }
  const branches = list(value['anyOf'] ?? value['oneOf']);
  const candidates = branches.filter((branch) => resolve(doc, branch)['type'] !== 'null');
  expect(candidates).toHaveLength(1);
  return enumReference(doc, at({ candidate: candidates[0] }, 'candidate'));
}

it('[CT-04f#11] 响应状态和子项 decision / reject_reason 引用已绑定枚举，子项允许 null', () => {
  const doc = contract();
  const registered = bindings();
  for (const method of ['post', 'get']) {
    const schemas = [
      ['status', 'claim_status', claimSchema(doc, method), false],
      ['decision', 'claim_item_decision', itemSchema(doc, method), true],
      ['reject_reason', 'claim_reject_reason', itemSchema(doc, method), true],
    ] as const;
    for (const [field, name, schema, nullable] of schemas) {
      const property = at(schema, 'properties', field);
      const ref = enumReference(doc, property);
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      expect(registered[ref.slice('#/components/schemas/'.length)]).toBe(name);
      const validate = compile(doc, property);
      for (const value of enumValues[name]) check(validate, value, true);
      check(validate, null, nullable);
      for (const value of ['', 'unknown', 1, {}, []]) check(validate, value, false);
    }
  }
});
