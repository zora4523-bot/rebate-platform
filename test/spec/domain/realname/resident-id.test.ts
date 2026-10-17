import { ageAt, isAtLeastAge, parseResidentIdNo } from '@couli/domain';
import { expect, it } from 'vitest';

// 固定样例的校验位已按任务 §9.3 的权重离线计算；无效日期也配正确校验位，
// 避免仅做校验位检查的实现掩盖日期漏验。所有号码均为测试数据。
it.each([
  '11010519491231002X',
  '11010519491231002x',
  ' \t11010519491231002x\r\n',
  '\u3000\u00a011010519491231002X\u00a0\u3000',
])('[AC-B1-13c#1] 身份证仅规范化首尾空白与末位 x：%j', (input) => {
  expect(parseResidentIdNo(input)).toEqual({
    ok: true,
    id_no: '11010519491231002X',
    birth_date: '1949-12-31',
  });
});

it.each([
  '110105194912310003',
  '110105194912310011',
  '11010519491231002X',
  '110105194912310038',
  '110105194912310046',
  '110105194912310054',
  '110105194912310062',
  '110105194912310070',
  '110105194912310089',
  '110105194912310097',
  '110105194912310185',
])('[AC-B1-13c#2] GB 11643 的全部十一种校验位映射：%s', (id_no) => {
  expect(parseResidentIdNo(id_no)).toEqual({ ok: true, id_no, birth_date: '1949-12-31' });
});

it.each(Array.from({ length: 18 }, (_, index) => index))(
  '[AC-B1-13c#3] 标准样例第 %i 位单字符替换必须失败',
  (index) => {
    const original = '11010519491231002X';
    const replacement = index === 17 ? '0' : String((Number(original[index]) + 1) % 10);
    const changed = original.slice(0, index) + replacement + original.slice(index + 1);
    expect(parseResidentIdNo(changed)).toEqual({ ok: false });
  },
);

it.each([
  '',
  '11010519491231002',
  '11010519491231002X0',
  '110105491231002',
  'A1010519491231002X',
  '11010519491231002A',
  '11010519491231002×',
  '１1010519491231002X',
  '11010519491231002Ｘ',
  '1101051949 1231002X',
  '1101051949\t1231002X',
  '1101051949\n1231002X',
  '1101051949\u30001231002X',
  '11010519491231002X\u200b',
])('[AC-B1-13c#4] 身份证格式错误只返回 ok:false：%j', (input) => {
  expect(parseResidentIdNo(input)).toEqual({ ok: false });
});

it.each([
  '110105199902300023',
  '110105200102290029',
  '110105190002290025',
  '110105210002290020',
  '110105202604310025',
  '110105202600010025',
  '110105202613010024',
  '110105202601000021',
  '110105202601320025',
  '110105202602290024',
  '110105202602300026',
])('[AC-B1-13c#5] 校验位正确但公历日期不存在仍失败：%s', (input) => {
  expect(parseResidentIdNo(input)).toEqual({ ok: false });
});

it.each([
  ['110105200002290021', '2000-02-29'],
  ['110105240002290028', '2400-02-29'],
  ['000000200002290002', '2000-02-29'],
  ['999999209912310008', '2099-12-31'],
  ['110105999912310028', '9999-12-31'],
])('[AC-B1-13c#6] 有效日期可提取，不校验地区码、顺序码和是否未来：%s', (id_no, birth_date) => {
  expect(parseResidentIdNo(id_no)).toEqual({ ok: true, id_no, birth_date });
});

it('[AC-B1-13c#7] 未来出生日期格式通过，但年龄未满 14', () => {
  const parsed = parseResidentIdNo('999999209912310008');
  expect(parsed).toEqual({ ok: true, id_no: '999999209912310008', birth_date: '2099-12-31' });
  if (!parsed.ok) throw new Error('fixture should parse');
  const at = new Date('2026-09-29T16:00:00Z');
  expect(ageAt(parsed.birth_date, at)).toBe(0);
  expect(isAtLeastAge(parsed.birth_date, 14, at)).toBe(false);
});
