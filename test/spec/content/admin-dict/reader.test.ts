import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { AdminDictReader } from '../../../../apps/api/src/modules/content/application/admin-dict-reader.ts';
import type { DictStore } from '../../../../apps/api/src/modules/content/application/dict-reader.ts';
import {
  adminDefaultTexts,
  parseAdminDefaultTexts,
} from '../../../../apps/api/src/modules/content/infra/admin-texts-default.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

const ROOT = new URL('../../../../', import.meta.url);
const document = () =>
  JSON.parse(readFileSync(new URL('contracts/texts.admin.default.json', ROOT), 'utf8')) as {
    texts: Record<string, string>;
    fallbacks: object;
  };
const userDefaults = () =>
  (
    JSON.parse(readFileSync(new URL('contracts/texts.default.json', ROOT), 'utf8')) as {
      texts: Record<string, string>;
    }
  ).texts;

it('[AC-F1-02zd#12] 包内后台默认原文无重键、按字母序、非空无占位符、键形和资金分类齐全；loader 保真', () => {
  const raw = readFileSync(new URL('contracts/texts.admin.default.json', ROOT), 'utf8');
  const doc = document();
  // Parse every quoted property name from the raw text BEFORE JSON.parse can erase duplicates.
  // String-token matching respects escaped quotes and Unicode escapes in property names.
  const properties = [...raw.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map(
    (match) => JSON.parse(match[1]!) as string,
  );
  expect(new Set(properties).size).toBe(properties.length);
  const keys = Object.keys(doc.texts);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys).toEqual([...keys].sort());
  expect(doc.fallbacks).toEqual({});
  const spec = parseYamlLite(readFileSync(new URL('specs/fund-term-keys.yaml', ROOT), 'utf8')) as {
    fund_terms: { keys: string[]; prefixes: string[] };
    ordinary: { keys: string[]; prefixes: string[] };
  };
  for (const [key, text] of Object.entries(doc.texts)) {
    expect(key).toMatch(/^admin_dict\..+\.[^.]+$/);
    expect(typeof text).toBe('string');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[{}]/);
    const covers = (segment: typeof spec.ordinary) =>
      segment.keys.includes(key) || segment.prefixes.some((prefix) => key.startsWith(prefix));
    expect([spec.fund_terms, spec.ordinary].filter(covers), key).toHaveLength(1);
    expect(Object.hasOwn(userDefaults(), key)).toBe(false);
  }
  expect(parseAdminDefaultTexts(doc, userDefaults())).toEqual(doc.texts);
  expect(adminDefaultTexts()).toEqual(doc.texts);
});

it('[AC-F1-02zd#13] 默认文件拒绝错误前缀、非字符串、结构损坏及跨文件重键，不能默默丢弃或覆盖', () => {
  const key = 'admin_dict.example.OK';
  const valid = { texts: { [key]: '正常值' }, fallbacks: {} };
  expect(parseAdminDefaultTexts(valid, {})).toEqual(valid.texts);
  for (const broken of [
    null,
    [],
    {},
    { texts: [] },
    { texts: null },
    { texts: { 'public_enum.OK': '错误前缀' } },
    { texts: { 'admin_dictx.example.OK': '相似前缀' } },
    { texts: { [key]: null } },
    { texts: { [key]: 7 } },
  ]) {
    expect(() => parseAdminDefaultTexts(broken, {})).toThrow();
  }
  expect(() => parseAdminDefaultTexts(valid, { [key]: '用户侧重键' })).toThrow();
});

it('[AC-F1-02zd#14] reader 只覆盖已知后台键、null 回默认，最后点切键，原型名称作为普通自有属性', async () => {
  const texts = {
    'admin_dict.status.OK': '默认正常',
    'admin_dict.table.column.UPPER': '默认大写',
    'admin_dict.__proto__.constructor': '原型枚举',
    'admin_dict.constructor.__proto__': '原型编码',
    'admin_dict.status.toString': '普通编码',
  };
  const snapshot = vi.fn<DictStore['snapshot']>(async (appId, limitOf) => {
    expect(appId).toBe('f102zd_reader');
    expect(limitOf('2')).toBe(2);
    return {
      value: '2',
      rows: [
        { dict: 'admin_dict', code: 'status.OK', text: null },
        { dict: 'admin_dict', code: 'table.column.UPPER', text: '最新大写' },
        { dict: 'admin_dict', code: 'status.toString', text: '最新普通编码' },
        { dict: 'admin_dict', code: 'constructor.__proto__', text: '最新原型编码' },
        { dict: 'admin_dict', code: 'unknown.code', text: '未知行' },
        { dict: 'other', code: 'status.OK', text: '非后台行' },
      ],
    };
  });
  const reader = new AdminDictReader({ snapshot }, () => texts, { warn: vi.fn() });
  const actual = await reader.read('f102zd_reader');
  expect(actual).toEqual({
    version: '2',
    items: JSON.parse(
      '{"status":{"OK":"默认正常","toString":"最新普通编码"},"table.column":{"UPPER":"最新大写"},"__proto__":{"constructor":"原型枚举"},"constructor":{"__proto__":"最新原型编码"}}',
    ) as unknown,
  });
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(Object.getPrototypeOf(actual.items)).toBe(Object.prototype);
  expect(Object.hasOwn(actual.items, '__proto__')).toBe(true);
  expect(Object.hasOwn(actual.items.constructor!, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(actual.items.constructor)).toBe(Object.prototype);
});

it('[AC-F1-02zd#15] reader 保留非规范版本但只供默认，limit 不允许读覆盖并发告警', async () => {
  for (const value of [undefined, null, 7, '0', '01', 'dict-42', '2147483648']) {
    const warn = vi.fn();
    const reader = new AdminDictReader(
      {
        snapshot: async (appId, limitOf) => {
          expect(appId).toBe('f102zd_invalid');
          expect(limitOf(value)).toBeNull();
          return { value, rows: [] };
        },
      },
      () => ({ 'admin_dict.status.OK': '默认' }),
      { warn },
    );
    expect(await reader.read('f102zd_invalid')).toEqual({
      version: typeof value === 'string' ? value : '0',
      items: { status: { OK: '默认' } },
    });
    if (typeof value === 'string' && value !== '0') {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'content_dict_version_invalid',
          app_id: 'f102zd_invalid',
        }),
        expect.any(String),
      );
    }
  }
});

it('[AC-F1-02zd#16] reader 每次重新读快照、不缓存；app_id 原样传入并隔离，不在构造期加载默认文件', async () => {
  let value = '1';
  const defaults = vi.fn(() => ({ 'admin_dict.status.OK': '默认' }));
  const snapshot = vi.fn<DictStore['snapshot']>(async (appId, limitOf) => {
    expect(limitOf(value)).toBe(Number(value));
    return { value, rows: [{ dict: 'admin_dict', code: 'status.OK', text: `${appId}:${value}` }] };
  });
  const reader = new AdminDictReader({ snapshot }, defaults, { warn: vi.fn() });
  expect(defaults).not.toHaveBeenCalled();
  expect(await reader.read('first')).toEqual({
    version: '1',
    items: { status: { OK: 'first:1' } },
  });
  value = '2';
  expect(await reader.read('first')).toEqual({
    version: '2',
    items: { status: { OK: 'first:2' } },
  });
  expect(await reader.read('second')).toEqual({
    version: '2',
    items: { status: { OK: 'second:2' } },
  });
  expect(snapshot.mock.calls.map(([appId]) => appId)).toEqual(['first', 'first', 'second']);
});

it('[AC-F1-02zd#17] 无数据库或默认文件损坏必须失败，不伪装为默认成功响应', async () => {
  const noDb = new AdminDictReader(null, () => ({ 'admin_dict.status.OK': '默认' }), {
    warn: vi.fn(),
  });
  await expect(noDb.read('f102zd_nodb')).rejects.toThrow();
  const error = new Error('fixture: invalid admin default document');
  const broken = new AdminDictReader(
    { snapshot: async () => ({ value: '0', rows: [] }) },
    () => {
      throw error;
    },
    { warn: vi.fn() },
  );
  await expect(broken.read('f102zd_broken')).rejects.toBe(error);
});
