import {
  ageAt,
  isAtLeastAge,
  isValidBankCardNo,
  normalizePersonName,
  parseResidentIdNo,
  reachedAgeAt,
} from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

// 属性的造数器独立于被测实现；固定样例另在普通规则测试中锚定算法。
const birthDate = fc.oneof(
  fc
    .date({
      min: new Date('1600-01-01T00:00:00Z'),
      max: new Date('2400-12-31T23:59:59.999Z'),
      noInvalidDate: true,
    })
    .map((date) => date.toISOString().slice(0, 10)),
  fc.constantFrom('1896-02-29', '1996-02-29', '2000-02-29', '2096-02-29', '2012-12-31'),
);

it('[AC-B1-13c#22] 属性：11–18 位前缀补 Luhn 位有效，任意位置单数字改变无效', () => {
  const params = propParams();
  const stats = createPropStats('realname:luhn-single-digit');
  const prefix = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 11, maxLength: 18 });
  fc.assert(
    fc.property(prefix, fc.integer({ min: 1, max: 9 }), (digits, delta) => {
      stats.hit(`length-${digits.length + 1}`);
      // 以完整卡号最右为第 1 位；查表独立计算偶数位贡献。
      const doubled = [0, 2, 4, 6, 8, 1, 3, 5, 7, 9];
      const sum = digits.reduce(
        (total, digit, index) =>
          total + ((digits.length - index) % 2 === 1 ? (doubled[digit] ?? 0) : digit),
        0,
      );
      const card = [...digits, (10 - (sum % 10)) % 10].join('');
      return (
        isValidBankCardNo(card) &&
        Array.from(card).every((digit, index) => {
          const changed =
            card.slice(0, index) + String((Number(digit) + delta) % 10) + card.slice(index + 1);
          return !isValidBankCardNo(changed);
        })
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-13c#23] 属性：任意地区码、有效出生日期、顺序码补校验位可解析，错校验位失败', () => {
  const params = propParams();
  const stats = createPropStats('realname:gb11643');
  fc.assert(
    fc.property(
      birthDate,
      fc.integer({ min: 0, max: 999999 }),
      fc.integer({ min: 0, max: 999 }),
      (birth, region, sequence) => {
        const prefix =
          String(region).padStart(6, '0') +
          birth.replaceAll('-', '') +
          String(sequence).padStart(3, '0');
        const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
        const sum = Array.from(prefix).reduce(
          (total, digit, index) => total + Number(digit) * (weights[index] ?? 0),
          0,
        );
        const check = '10X98765432'.charAt(sum % 11);
        const id = prefix + check;
        stats.hit(`check-${check}`);
        stats.hit(birth.endsWith('02-29') ? 'leap-birthday' : 'other-birthday');
        const parsed = parseResidentIdNo(id);
        const wrongCheck = check === 'X' ? '0' : String((Number(check) + 1) % 10);
        const rejected = parseResidentIdNo(prefix + wrongCheck);
        return (
          parsed.ok &&
          parsed.id_no === id &&
          parsed.birth_date === birth &&
          !rejected.ok &&
          Object.keys(rejected).length === 1
        );
      },
    ),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns * 2,
  );
});

it('[AC-B1-13c#24] 属性：满周岁时刻随 N 严格递增，并符合独立 UTC 公历生日次日计算', () => {
  const params = propParams();
  const stats = createPropStats('realname:age-thresholds');
  fc.assert(
    fc.property(birthDate, fc.integer({ min: 0, max: 150 }), (birth, years) => {
      stats.hit(birth.endsWith('02-29') ? 'leap-birthday' : 'other-birthday');
      const year = Number(birth.slice(0, 4)) + years;
      const month = Number(birth.slice(5, 7));
      const day = Number(birth.slice(8, 10));
      // Date.UTC 将非闰年的 2/29 归一化成 3/1，随后加一天并减 +08:00 偏移。
      // 日期仅用于测试 oracle；被测包不能取系统时钟或系统时区。
      const expected = Date.UTC(year, month - 1, day) + 86_400_000 - 28_800_000;
      const current = reachedAgeAt(birth, years).getTime();
      const next = reachedAgeAt(birth, years + 1).getTime();
      return (
        current === expected &&
        next > current &&
        (next - current === 365 * 86_400_000 || next - current === 366 * 86_400_000)
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-13c#25] 属性：任意 at 的年龄落在相邻满周岁时刻之间，出生前只返回 0', () => {
  const params = propParams();
  const stats = createPropStats('realname:age-interval');
  const instant = fc.date({
    min: new Date('1500-01-01T00:00:00Z'),
    max: new Date('2600-12-31T23:59:59.999Z'),
    noInvalidDate: true,
  });
  fc.assert(
    fc.property(birthDate, instant, (birth, at) => {
      const original = at.getTime();
      const zero = reachedAgeAt(birth, 0).getTime();
      stats.hit(original < zero ? 'before-zero' : 'at-or-after-zero');
      const age = ageAt(birth, at);
      if (!Number.isInteger(age) || age < 0 || at.getTime() !== original) return false;
      if (original < zero) return age === 0 && !isAtLeastAge(birth, 0, at);
      return (
        reachedAgeAt(birth, age).getTime() <= original &&
        original < reachedAgeAt(birth, age + 1).getTime() &&
        isAtLeastAge(birth, age, at) &&
        !isAtLeastAge(birth, age + 1, at) &&
        at.getTime() === original
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-13c#26] 属性：任意 N 周岁边界前一毫秒未满，到点即满', () => {
  const params = propParams();
  const stats = createPropStats('realname:age-millisecond');
  fc.assert(
    fc.property(birthDate, fc.integer({ min: 1, max: 150 }), (birth, years) => {
      stats.hit(birth.endsWith('02-29') ? 'leap-birthday' : 'other-birthday');
      const reached = reachedAgeAt(birth, years);
      const before = new Date(reached.getTime() - 1);
      return (
        ageAt(birth, before) === years - 1 &&
        ageAt(birth, reached) === years &&
        !isAtLeastAge(birth, years, before) &&
        isAtLeastAge(birth, years, reached)
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-13c#27] 属性：姓名规范化幂等，覆盖 Unicode 与指定空白、间隔符', () => {
  const params = propParams();
  const stats = createPropStats('realname:name-idempotence');
  const input = fc.oneof(
    fc.string({ unit: 'grapheme', maxLength: 80 }),
    fc
      .array(
        fc.constantFrom(
          '王',
          '明',
          'Ａ',
          'é',
          'e\u0301',
          ' ',
          '\u00a0',
          '\u3000',
          '\t',
          '\n',
          '•',
          '.',
          '．',
          '・',
          '·',
          '\u200b',
        ),
        { maxLength: 80 },
      )
      .map((chars) => chars.join('')),
  );
  fc.assert(
    fc.property(input, (name) => {
      stats.hit(name.length === 0 ? 'empty' : 'nonempty');
      const once = normalizePersonName(name);
      return normalizePersonName(once) === once;
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});
