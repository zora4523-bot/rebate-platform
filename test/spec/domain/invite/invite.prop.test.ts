import {
  inviteFailWindow,
  isInviteCodeFormat,
  normalizeInviteCode,
  withinBackfill,
} from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

// 与 calendar 的四位年份输入域一致，两端留余量，覆盖纪元前与闰世纪。
const instant = fc.integer({
  min: Date.parse('0002-01-01T00:00:00Z'),
  max: Date.parse('9998-12-31T23:59:59.999Z'),
});
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

it('[AC-B1-11c#18] 属性：频控键对应北京时间，秒数在 [1,86400] 且到次日零点起一秒内', () => {
  const params = propParams();
  const stats = createPropStats('invite:fail-window');
  fc.assert(
    fc.property(instant, (time) => {
      stats.hit(time < 0 ? 'before-epoch' : 'since-epoch');
      const result = inviteFailWindow(new Date(time));
      // 独立测试 oracle 使用固定偏移的 UTC 格式和整数纪元日，不读被测 calendar。
      const expectedDay = new Date(time + 28_800_000).toISOString().slice(0, 10);
      const nextMidnight =
        (Math.floor((time + 28_800_000) / 86_400_000) + 1) * 86_400_000 - 28_800_000;
      const landing = time + result.retry_after_seconds * 1000;
      return (
        result.day === expectedDay &&
        Number.isInteger(result.retry_after_seconds) &&
        result.retry_after_seconds >= 1 &&
        result.retry_after_seconds <= 86400 &&
        landing >= nextMidnight &&
        landing < nextMidnight + 1000
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-11c#19] 属性：withinBackfill 等价于严格时刻比较（包含相等及相邻毫秒）', () => {
  const params = propParams();
  const stats = createPropStats('invite:within-backfill');
  const pair = fc.oneof(
    fc.tuple(instant, instant),
    fc
      .tuple(instant, fc.constantFrom(-1, 0, 1))
      .map(([deadline, delta]) => [deadline + delta, deadline] as const),
  );
  fc.assert(
    fc.property(pair, ([time, deadline]) => {
      stats.hit(time === deadline ? 'equal' : time < deadline ? 'before' : 'after');
      return withinBackfill(new Date(time), new Date(deadline)) === time < deadline;
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-11c#20] 属性：邀请码字符及空白输入域内规范化幂等', () => {
  const params = propParams();
  const stats = createPropStats('invite:normalization');
  // 不声称任意 Unicode 串均幂等：删除零宽字符可能使组合字符在第二次 NFKC 时合成。
  const raw = fc.oneof(
    fc.string(),
    fc
      .array(
        fc.constantFrom(
          ...'ｋ７ｍ２ｑｘＫＭＱＸabcXYZ0129 \t\n\u0085\u3000\u200b\u200c\u200d\ufeff',
        ),
        {
          maxLength: 100,
        },
      )
      .map((chars) => chars.join('')),
  );
  fc.assert(
    fc.property(raw, (input) => {
      stats.hit(input.length === 0 ? 'empty' : 'nonempty');
      const normalized = normalizeInviteCode(input);
      return normalizeInviteCode(normalized) === normalized;
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-11c#21] 属性：字符集内任意六位串都通过格式校验', () => {
  const params = propParams();
  const stats = createPropStats('invite:valid-code');
  const code = fc
    .array(fc.constantFrom(...alphabet), { minLength: 6, maxLength: 6 })
    .map((chars) => chars.join(''));
  fc.assert(
    fc.property(code, (value) => {
      stats.hit(value.charAt(0));
      return isInviteCodeFormat(value) === true;
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});
