import { expect, it } from 'vitest';
import { getBannedWords, getFundTermKeys } from '../../specs/text-specs.ts';
import type { BannedWord, FundTermKeys } from '../text-guard/index.ts';
import {
  ADMIN_DICT,
  DICT_READ_PERMISSIONS,
  adminDictItems,
  checkDictRollback,
  checkDictSave,
  dictItems,
  dictPermissionOf,
  dictRequestClass,
  dictTextProblems,
  dictTextScope,
  joinDictKey,
  parseDictVersion,
  parseWritableDictVersion,
  splitAdminDictKey,
  splitDictKey,
  type DictTextRules,
} from './index.ts';

it('[AC-F1-02s#1] 键只按第一个点拆分，无点号 code 为空串', () => {
  expect(splitDictKey('order_status.CREDITED.summary')).toEqual({
    dict: 'order_status',
    code: 'CREDITED.summary',
  });
  expect(splitDictKey('ai_label')).toEqual({ dict: 'ai_label', code: '' });
});

it('[AC-F1-02s#2] 合法版本给出数值上限，int32 之外与非规范写法不读字典行', () => {
  expect(parseDictVersion('2147483647')).toEqual({ version: '2147483647', limit: 2_147_483_647 });
  expect(parseDictVersion('2147483648')).toEqual({ version: '2147483648', limit: null });
  expect(parseDictVersion('0')).toEqual({ version: '0', limit: null });
  expect(parseDictVersion('7\n')).toEqual({ version: '7\n', limit: null });
  expect(parseDictVersion(12)).toEqual({ version: '0', limit: null });
  expect(parseDictVersion(undefined)).toEqual({ version: '0', limit: null });
});

it('[AC-F1-02s#10] text 为 null 的键不出现，空串保留，__proto__ 作普通键', () => {
  const items = dictItems([
    { dict: 'ai_label', code: '', text: '助手' },
    { dict: 'ai_label', code: 'gone', text: null },
    { dict: 'ai_label', code: 'empty', text: '' },
    { dict: 'only_null', code: 'x', text: null },
    { dict: 'order_status', code: '__proto__', text: '原型' },
  ]);
  expect(JSON.parse(JSON.stringify(items))).toEqual({
    ai_label: { '': '助手', empty: '' },
    order_status: JSON.parse('{"__proto__":"原型"}') as object,
  });
  expect(Object.getPrototypeOf(items['order_status'])).toBe(Object.prototype);
  expect(Object.keys(items['order_status']!)).toEqual(['__proto__']);
});

const KEYS: FundTermKeys = {
  fund_terms: { prefixes: ['wallet.'], keys: ['tag.rebate'], notify_templates: [] },
  ordinary: { prefixes: ['about.', 'privacy.', 'perm.'], keys: ['plain'], notify_templates: [] },
  exempt: [],
};
const WORDS: readonly BannedWord[] = [
  { word: '全网最低', category: 'price_rebate', scopes: ['user_visible', 'admin_report'] },
  { word: '佣金', category: 'fund', scopes: ['user_visible'] },
  { word: '内部词', category: 'test', scopes: ['admin_report'] },
];
const DEFAULTS = {
  'about.a': '甲',
  'about.b': '乙{name}',
  'privacy.ok': '同意',
  'wallet.x': '余额',
};
const RULES: DictTextRules = { defaults: DEFAULTS, words: WORDS };

it('[AC-F1-02t#u1] 键类选点：一类一个权限点，读接受三者之一；空与混类为 null，未知键按资金术语', () => {
  expect(dictPermissionOf('general')).toBe('config.general');
  expect(dictPermissionOf('fund_terms')).toBe('content.fund_terms');
  expect(dictPermissionOf('agreement')).toBe('content.agreement');
  expect(DICT_READ_PERMISSIONS).toEqual([
    'config.general',
    'content.fund_terms',
    'content.agreement',
  ]);
  expect(dictRequestClass(['about.a', 'plain'], KEYS)).toBe('general');
  expect(dictRequestClass(['privacy.ok', 'perm.x'], KEYS)).toBe('agreement');
  expect(dictRequestClass(['wallet.x', 'unknown.key'], KEYS)).toBe('fund_terms');
  expect(dictRequestClass(['about.a', 'unknown.key'], KEYS)).toBeNull();
  expect(dictRequestClass(['about.a', 'privacy.ok'], KEYS)).toBeNull();
  expect(dictRequestClass([], KEYS)).toBeNull();
});

it('[AC-F1-02t#u2] 键按第一个点拆分并可还原；版本只认规范十进制整数串', () => {
  expect(splitDictKey('order_status.SETTLED.label')).toEqual({
    dict: 'order_status',
    code: 'SETTLED.label',
  });
  expect(splitDictKey('claim_required')).toEqual({ dict: 'claim_required', code: '' });
  expect(joinDictKey('order_status', 'SETTLED.label')).toBe('order_status.SETTLED.label');
  expect(joinDictKey('claim_required', '')).toBe('claim_required');
  expect(parseWritableDictVersion('0')).toBe(0);
  expect(parseWritableDictVersion('42')).toBe(42);
  expect(parseWritableDictVersion(String(2 ** 31 - 2))).toBe(2 ** 31 - 2);
  for (const bad of ['dict-42', '00', '01', '', '-1', '1.0', ' 1', String(2 ** 31 - 1), 3, null]) {
    expect(parseWritableDictVersion(bad)).toBeNull();
  }
});

it('[AC-F1-02t#u3] 禁用词按范围选词：user_visible 与 admin_report 各自只查本范围的词', () => {
  expect(dictTextScope('about.a')).toBe('user_visible');
  const user = (text: string) => dictTextProblems('about.a', text, RULES);
  const admin = (text: string) =>
    dictTextProblems('about.a', text, { ...RULES, scopeOf: () => 'admin_report' });
  expect(user('佣金说明')).toEqual(['佣金']);
  expect(admin('佣金说明')).toBeNull();
  expect(admin('内部词')).toEqual(['内部词']);
  expect(user('内部词')).toBeNull();
  // Both scopes check this word; normalisation drops the zero-width space.
  expect(user('全\u200b网最低')).toEqual(['全网最低']);
  expect(admin('全\u200b网最低')).toEqual(['全网最低']);
  // The real snapshot: 佣金 is user_visible only, 全网最低 is in both lists.
  const real = getBannedWords();
  expect(real.find((w) => w.word === '佣金')?.scopes).toEqual(['user_visible']);
  expect(real.find((w) => w.word === '全网最低')?.scopes).toEqual(['user_visible', 'admin_report']);
});

it('[AC-F1-02t#u4] 保存逐项全报：未知、重复、同值（含 null）报 key，变量与禁用词报 text 加词，协议类缺确认人', () => {
  const current = (key: string) => (key === 'about.a' ? '甲改' : null);
  expect(
    checkDictSave({
      changes: [
        { key: 'about.a', text: '甲新' },
        { key: 'missing.key', text: '新' },
        { key: 'about.a', text: '甲再' },
        { key: 'about.b', text: null },
        { key: 'about.b', text: '乙' },
      ],
      keyClass: 'general',
      legalConfirmedBy: null,
      current,
      rules: RULES,
    }),
  ).toEqual(['changes[1].key', 'changes[2].key', 'changes[3].key', 'changes[4].key']);
  expect(
    checkDictSave({
      changes: [
        { key: 'about.a', text: '甲改' },
        { key: 'about.b', text: '全网最低{wrong}' },
        { key: 'privacy.ok', text: '佣金' },
      ],
      keyClass: 'general',
      legalConfirmedBy: null,
      current,
      rules: RULES,
    }),
  ).toEqual(['changes[0].key', 'changes[1].text', '全网最低', 'changes[2].text', '佣金']);
  expect(
    checkDictSave({
      changes: [{ key: 'about.b', text: '乙{name}改' }],
      keyClass: 'general',
      legalConfirmedBy: null,
      current,
      rules: RULES,
    }),
  ).toEqual([]);
  // Back to the bundled default from an override is a change.
  expect(
    checkDictSave({
      changes: [{ key: 'about.a', text: null }],
      keyClass: 'general',
      legalConfirmedBy: null,
      current,
      rules: RULES,
    }),
  ).toEqual([]);
  const agreement = { changes: [{ key: 'privacy.ok', text: '好' }], current, rules: RULES };
  expect(checkDictSave({ ...agreement, keyClass: 'agreement', legalConfirmedBy: null })).toEqual([
    'legal_confirmed_by',
  ]);
  expect(
    checkDictSave({ ...agreement, keyClass: 'agreement', legalConfirmedBy: '法务甲' }),
  ).toEqual([]);
});

it('[AC-F1-02t#u5] 回滚：目标版本不低于当前只报 to_version；键未知重复报 keys[i]；恢复值重过校验', () => {
  const base = {
    keyClass: 'general' as const,
    legalConfirmedBy: null,
    rules: RULES,
    restored: (key: string) => ({ 'about.a': '全网最低', 'about.b': '乙缺变量' })[key] ?? null,
  };
  expect(
    checkDictRollback({ ...base, keys: ['about.a'], toVersion: 3, currentVersion: 3 }),
  ).toEqual(['to_version']);
  expect(
    checkDictRollback({ ...base, keys: ['nope', 'about.a'], toVersion: 0, currentVersion: 0 }),
  ).toEqual(['to_version', 'keys[0]']);
  expect(
    checkDictRollback({
      ...base,
      keys: ['privacy.ok', 'about.a', 'about.b', 'about.a'],
      toVersion: 1,
      currentVersion: 2,
    }),
  ).toEqual(['keys[1]', '全网最低', 'keys[2]', 'keys[3]']);
  expect(
    checkDictRollback({
      ...base,
      keyClass: 'agreement',
      keys: ['privacy.ok'],
      toVersion: 0,
      currentVersion: 2,
    }),
  ).toEqual(['legal_confirmed_by']);
});

it('[AC-F1-02t#u6] 运行时快照：资金术语清单可分类真实键', () => {
  const spec = getFundTermKeys();
  expect(dictRequestClass(['order_status_group.credited'], spec)).toBe('fund_terms');
  expect(dictRequestClass(['about.copy_diagnostics'], spec)).toBe('general');
  expect(dictRequestClass(['privacy.btn.agree', 'perm.btn.continue'], spec)).toBe('agreement');
  expect(dictRequestClass(['unclassified.test_key'], spec)).toBe('fund_terms');
});

it('[AC-F1-02zd#u1] 后台键去前缀后按最后一个点切；缺枚举或编码、非 admin_dict 前缀为 null', () => {
  expect(splitAdminDictKey('admin_dict.status.OK')).toEqual({ enumName: 'status', code: 'OK' });
  expect(splitAdminDictKey('admin_dict.a.b.c.UP')).toEqual({ enumName: 'a.b.c', code: 'UP' });
  for (const bad of [
    'admin_dict.only',
    'admin_dict..OK',
    'admin_dict.status.',
    'admin_dictx.status.OK',
    'about.a.b',
    'admin_dict',
  ]) {
    expect(splitAdminDictKey(bad), bad).toBeNull();
  }
});

it('[AC-F1-02zd#u2] 后台字典：每个默认键都返回，覆盖非 null 才替换，别的字典与未知行忽略', () => {
  const defaults = {
    'admin_dict.status.OK': '默认正常',
    'admin_dict.status.BAD': '默认异常',
    'admin_dict.t.c.true': '默认真',
  };
  const items = adminDictItems(defaults, [
    { dict: ADMIN_DICT, code: 'status.OK', text: '覆盖正常' },
    { dict: ADMIN_DICT, code: 'status.BAD', text: null },
    { dict: ADMIN_DICT, code: 'unknown.X', text: '未知' },
    { dict: 'status', code: 'BAD', text: '别的字典' },
  ]);
  expect(items).toEqual({
    status: { OK: '覆盖正常', BAD: '默认异常' },
    't.c': { true: '默认真' },
  });
  expect(adminDictItems({}, [])).toEqual({});
  expect(() => adminDictItems({ 'about.a': '用户键' }, [])).toThrow();
});

it('[AC-F1-02zd#u3] admin_dict 键按 admin_report 校词：佣金、高佣放行，全网最低仍拒；用户键仍按 user_visible', () => {
  expect(dictTextScope('admin_dict.risk_action.void_commission')).toBe('admin_report');
  expect(dictTextScope('admin_dictx.a.b')).toBe('user_visible');
  expect(dictTextScope('about.copy_diagnostics')).toBe('user_visible');
  const rules: DictTextRules = {
    defaults: { 'admin_dict.risk_action.void_commission': '作废佣金', 'about.a': '复制' },
    words: getBannedWords(),
  };
  expect(
    dictTextProblems('admin_dict.risk_action.void_commission', '作废佣金（人工）', rules),
  ).toBeNull();
  expect(dictTextProblems('admin_dict.risk_action.void_commission', '高佣预警', rules)).toBeNull();
  expect(dictTextProblems('admin_dict.risk_action.void_commission', '全网最低', rules)).toEqual([
    '全网最低',
  ]);
  expect(dictTextProblems('about.a', '佣金', rules)).toEqual(['佣金']);
});
