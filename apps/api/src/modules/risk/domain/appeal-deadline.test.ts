import { describe, expect, it } from 'vitest';
import { appealDeadline, appealLocalYear } from './appeal-deadline.ts';

const at = (iso: string) => new Date(iso);

describe('appealDeadline', () => {
  it('[AC-B1-03i] BR-ID-36 例：周一 15:00（+08:00）提交，截止周四 24:00', () => {
    expect(appealDeadline(at('2026-11-02T07:00:00.000Z'), {}).toISOString()).toBe(
      '2026-11-05T16:00:00.000Z',
    );
  });

  it('[AC-B1-03i] 提交日按 +08:00 自然日计：UTC 周日 16:00 已是 +08:00 周一', () => {
    expect(appealDeadline(at('2026-11-01T16:00:00.000Z'), {}).toISOString()).toBe(
      '2026-11-05T16:00:00.000Z',
    );
    expect(appealDeadline(at('2026-11-01T15:59:59.999Z'), {}).toISOString()).toBe(
      '2026-11-04T16:00:00.000Z',
    );
  });

  it('[AC-B1-03i] 节假日在工作日也不计，调休日在周末也计', () => {
    const calendars = {
      2026: { holidays: ['2026-11-03'], makeupWorkdays: ['2026-11-07'] },
    };
    // Fri 11-06 submission: Sat 11-07 (make-up) 1, Mon 11-09 2, Tue 11-10 3.
    expect(appealDeadline(at('2026-11-06T07:00:00.000Z'), calendars).toISOString()).toBe(
      '2026-11-10T16:00:00.000Z',
    );
    // Mon 11-02 submission: Tue 11-03 holiday, Wed 1, Thu 2, Fri 3.
    expect(appealDeadline(at('2026-11-02T07:00:00.000Z'), calendars).toISOString()).toBe(
      '2026-11-06T16:00:00.000Z',
    );
  });

  it('[AC-B1-03i] 没有日历的年份只按周末计', () => {
    expect(
      appealDeadline(at('2026-12-30T07:00:00.000Z'), {
        2026: { holidays: ['2026-12-31'], makeupWorkdays: [] },
      }).toISOString(),
    ).toBe('2027-01-05T16:00:00.000Z');
  });

  it('[AC-B1-03i] 非法提交时间直接报错', () => {
    expect(() => appealDeadline(new Date(Number.NaN), {})).toThrow(RangeError);
  });

  it('[AC-B1-03i] appealLocalYear 取 +08:00 年份', () => {
    expect(appealLocalYear(at('2026-12-31T15:59:59.999Z'))).toBe(2026);
    expect(appealLocalYear(at('2026-12-31T16:00:00.000Z'))).toBe(2027);
  });
});
