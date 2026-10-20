import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { getFundTermKeys } from '../specs/text-specs.ts';
import {
  ADMIN_TEXTS_DEFAULT_FILE,
  adminDefaultTexts,
  dictDefaultTexts,
  parseAdminDefaultTexts,
} from './admin-texts-default.ts';
import { defaultTexts } from './texts-default.ts';

const raw = () => readFileSync(ADMIN_TEXTS_DEFAULT_FILE, 'utf8');

it('[AC-F1-02zd#u4] 后台默认文件自检：原文不重键、键按字母序、值非空无花括号、去前缀后有点、每键在资金术语清单里归类', () => {
  const text = raw();
  // Property names straight from the raw text, before JSON.parse can drop a repeated key.
  const names = [...text.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map(
    (match) => JSON.parse(match[1]!) as string,
  );
  expect(new Set(names).size).toBe(names.length);
  const document = JSON.parse(text) as { texts: Record<string, string>; fallbacks: object };
  expect(document.fallbacks).toEqual({});
  const keys = Object.keys(document.texts);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  const fund = getFundTermKeys();
  const covers = (segment: typeof fund.ordinary, key: string) =>
    segment.keys.includes(key) || segment.prefixes.some((prefix) => key.startsWith(prefix));
  for (const [key, value] of Object.entries(document.texts)) {
    expect(key).toMatch(/^admin_dict\.[^.]+(\.[^.]+)*\.[^.]+$/);
    expect(value.trim().length, key).toBeGreaterThan(0);
    expect(value, key).not.toMatch(/[{}]/);
    expect(
      [fund.fund_terms, fund.ordinary].filter((segment) => covers(segment, key)),
      key,
    ).toHaveLength(1);
  }
  expect(adminDefaultTexts()).toEqual(document.texts);
  expect(adminDefaultTexts()).toBe(adminDefaultTexts());
});

it('[AC-F1-02zd#u5] 解析拒绝结构损坏、错误前缀、缺枚举或编码、非字符串值与用户侧重键', () => {
  const ok = { texts: { 'admin_dict.e.OK': '好' }, fallbacks: {} };
  expect(parseAdminDefaultTexts(ok, {})).toEqual({ 'admin_dict.e.OK': '好' });
  expect(Object.isFrozen(parseAdminDefaultTexts(ok, {}))).toBe(true);
  for (const broken of [
    undefined,
    'texts',
    [],
    { texts: 'x' },
    { texts: [] },
    { texts: { 'about.a': '用户键' } },
    { texts: { 'admin_dict.OK': '缺编码' } },
    { texts: { 'admin_dict.e.': '空编码' } },
    { texts: { 'admin_dict.e.OK': false } },
  ]) {
    expect(() => parseAdminDefaultTexts(broken, {}), JSON.stringify(broken)).toThrow();
  }
  expect(() => parseAdminDefaultTexts(ok, { 'admin_dict.e.OK': '重键' })).toThrow(/texts\.default/);
  // A `__proto__` key stays an ordinary own entry.
  const proto = parseAdminDefaultTexts(JSON.parse('{"texts":{"admin_dict.__proto__.a":"甲"}}'), {});
  expect(Object.hasOwn(proto, 'admin_dict.__proto__.a')).toBe(true);
});

it('[AC-F1-02zd#u6] 字典编辑键集是两份默认的并集；每次调用都重新取两个 loader，任一失败原样抛出，重键抛错', () => {
  const union = dictDefaultTexts(defaultTexts, adminDefaultTexts);
  expect(Object.keys(union)).toHaveLength(
    Object.keys(defaultTexts()).length + Object.keys(adminDefaultTexts()).length,
  );
  expect(union).toEqual({ ...defaultTexts(), ...adminDefaultTexts() });
  let calls = 0;
  const admin = () => {
    calls += 1;
    return { 'admin_dict.e.OK': '好' };
  };
  dictDefaultTexts(() => ({ 'about.a': '甲' }), admin);
  dictDefaultTexts(() => ({ 'about.a': '甲' }), admin);
  expect(calls).toBe(2);
  const failure = new Error('fixture: broken admin defaults');
  expect(() =>
    dictDefaultTexts(
      () => ({}),
      () => {
        throw failure;
      },
    ),
  ).toThrow(failure);
  expect(() =>
    dictDefaultTexts(
      () => ({ 'admin_dict.e.OK': '甲' }),
      () => ({ 'admin_dict.e.OK': '乙' }),
    ),
  ).toThrow();
});
