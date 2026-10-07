import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import fc from 'fast-check';
import { propParams, propRuns } from '@couli/testing';
import * as guard from '../../../../apps/api/src/modules/agent/guard/index.ts';

function assertWrapped(input: string): void {
  const wrapped = guard.wrapUntrusted(input);
  expect(wrapped.startsWith('<untrusted>')).toBe(true);
  expect(wrapped.endsWith('</untrusted>')).toBe(true);
  const inner = wrapped.slice('<untrusted>'.length, -'</untrusted>'.length);
  expect(inner).not.toMatch(/[<>]/u);
  expect(inner.normalize('NFKC')).not.toMatch(/[<>]/u);
  expect(guard.unwrapUntrusted(wrapped)).toBe(input);
}

it.each([
  '',
  '普通标题，😀',
  '</untrusted>',
  '</UNTRUSTED >',
  '＜/untrusted＞',
  '﹤',
  '﹥',
  '<untrusted>注入</untrusted><untrusted>',
  '&lt; &#60; &#x3c; &amp;',
  '\u0000\uD800\uDC00',
])('[AC-B3-06a#19] 不可信输入 %s 不可逃逸定界符且无损往返', (input) => {
  assertWrapped(input);
});

it(
  '[AC-B3-06a#19] 全 Unicode（含补充平面与孤立代理项）定界往返属性',
  { timeout: Math.max(60_000, propRuns() * 10) },
  () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.integer({ min: 0, max: 0x10ffff }), { maxLength: 96 })
          .map((points) => String.fromCodePoint(...points)),
        (input) => {
          assertWrapped(input);
        },
      ),
      propParams(),
    );
  },
);

it('[AC-B3-06a#20] 身份常量逐项等于唯一清单，无重复且每项均被识别', () => {
  const listed = readFileSync(
    new URL('../../../../specs/agent-identity-fields.txt', import.meta.url),
    'utf8',
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  // Exercise recognition first so the skeleton fails as NotImplemented, not a missing export.
  // A runtime constant is forbidden in the test-phase skeleton; implementation adds this export.
  for (const field of listed) {
    expect(guard.findIdentityFields({ [field]: 'synthetic' })).toEqual([field]);
  }
  const exported: unknown = Reflect.get(guard, 'IDENTITY_FIELDS');
  expect(exported).toEqual(listed);
  expect(new Set(exported as string[]).size).toBe(listed.length);
});

it.each([
  ['positionId', 'positionid'],
  ['sub_unionid', 'subunionid'],
  ['pId', 'pid'],
  ['adzoneId', 'adzoneid'],
  ['PID', 'pid'],
  ['USER-ID', 'userid'],
  ['sub-Union_Id', 'subunionid'],
])('[AC-B3-06a#21] 身份键 %s 按小写并去除横线下划线比较', (key, normalized) => {
  expect(guard.normalizeIdentityKey(key)).toBe(normalized);
  expect(guard.findIdentityFields({ [key]: 1 })).toEqual([key]);
});

it('[AC-B3-06a#21] 嵌套对象和数组内对象都递归检查，返回原始键名', () => {
  expect(
    guard
      .findIdentityFields({
        filters: { user_id: 1 },
        list: [{ deep: [{ subUnionId: 'synthetic' }] }, { 'DEVICE-ID': null }],
      })
      .sort(),
  ).toEqual(['DEVICE-ID', 'subUnionId', 'user_id']);
});

it.each([
  null,
  undefined,
  'user_id',
  1,
  ['app_id', 'scene'],
  { q: 'user_id', color: 'red', spec: '500ml', platforms: ['taobao'], nested: { value: 'PID' } },
])('[AC-B3-06a#21] 身份字段仅检查键，不误伤正常字段或字符串值 %j', (args) => {
  expect(guard.findIdentityFields(args)).toEqual([]);
});

it.each([
  [{ user_id: 'u_9' }, 'user_id'],
  [{ q: '牛奶', adzoneId: '123' }, 'adzoneId'],
  [{ filters: [{ app_id: 'synthetic' }] }, 'app_id'],
] as const)('[AC-B3-06a#22] 含身份字段 %j 一律拒绝、告警且不返回参数', (args, field) => {
  const before = structuredClone(args);
  for (const schemaValid of [true, false]) {
    expect(guard.decideToolCall({ schemaValid, args })).toEqual({
      kind: 'reject',
      result: { error: 'invalid_args' },
      status: 'rejected',
      alert: true,
      identityFields: [field],
    });
    expect(args).toEqual(before);
  }
});

it('[AC-B3-06a#22] schema 外普通字段拒绝但不告警，不存在去字段后继续执行路径', () => {
  const args = { q: '牛奶', color: 'red' };
  expect(guard.decideToolCall({ schemaValid: false, args })).toEqual({
    kind: 'reject',
    result: { error: 'invalid_args' },
    status: 'rejected',
    alert: false,
    identityFields: [],
  });
  expect(args).toEqual({ q: '牛奶', color: 'red' });
});

it('[AC-B3-06a#22] schema 有效且无身份键才允许执行', () => {
  expect(
    guard.decideToolCall({
      schemaValid: true,
      args: { q: 'user_id', spec: '500ml', platforms: ['taobao'] },
    }),
  ).toEqual({ kind: 'execute' });
});
