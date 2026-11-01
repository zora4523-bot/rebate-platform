// B2-15k: implementer's unit tests of the Alipay answer scanner, ported from task/PAY-01; r3 建议改 ②:
// the scanner itself refuses anything but one complete valid JSON object.
import { describe, expect, it } from 'vitest';
import { onlyMember, stringMember, topLevelMembers } from './envelope.ts';

describe('topLevelMembers', () => {
  it('[AC-B2-15k-U#10] keeps every value as its exact text, whitespace and escapes included', () => {
    const node = '{ "a" : "http:\\/\\/\\u4e2d", "b":[1, {"c":"}"}] }';
    const text = ` { "node" : ${node} , "n":1.50, "t":true , "s":"x\\"y" } `;
    expect(topLevelMembers(text)).toEqual([
      { key: 'node', raw: node },
      { key: 'n', raw: '1.50' },
      { key: 't', raw: 'true' },
      { key: 's', raw: '"x\\"y"' },
    ]);
  });

  it('[AC-B2-15k-U#11] nested keys never show, duplicates all show, escaped keys are decoded', () => {
    const members = topLevelMembers('{"wrap":{"sign":"inner"},"sign":"a","\\u0073ign":"b"}');
    expect(members?.map((member) => member.key)).toEqual(['wrap', 'sign', 'sign']);
    expect(onlyMember(members ?? [], 'sign')).toBeUndefined();
    expect(onlyMember(members ?? [], 'wrap')).toBe('{"sign":"inner"}');
    expect(onlyMember(members ?? [], 'absent')).toBeUndefined();
  });

  it('[AC-B2-15k-U#12] an empty object has no members', () => {
    expect(topLevelMembers(' { } ')).toEqual([]);
  });

  it.each([
    ['r3 建议改 ② 的非法字面量', '{"junk":truefalse}'],
    ['尾随内容', '{"a":1}x'],
    ['数组', '[1]'],
    ['null', 'null'],
    ['字符串', '"text"'],
    ['截断', '{"a":'],
    ['空串', ''],
  ])('[AC-B2-15k-U#13] %s：undefined', (_name, text) => {
    expect(topLevelMembers(text)).toBeUndefined();
  });

  it('[AC-B2-15k-U#14] an answer over the size limit is not scanned', () => {
    expect(topLevelMembers(`{"a":"${'x'.repeat(1_000_001)}"}`)).toBeUndefined();
  });

  it('[AC-B2-15k-U#15] stringMember reads a JSON string and nothing else', () => {
    expect(stringMember('"a\\u0062"')).toBe('ab');
    expect(stringMember('42')).toBeUndefined();
    expect(stringMember(undefined)).toBeUndefined();
  });
});
