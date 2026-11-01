import { describe, expect, it } from 'vitest';
import {
  asPlatform,
  formatAsOf,
  formatFen,
  isEmptyPeriod,
  parsePlatforms,
  type EarningsSummary,
} from './model.ts';

const NOW = Date.parse('2026-11-12T10:05:00+08:00');
const zero = { paid_count: 0, est_fen: 0, credited_fen: 0 };

function summary(overrides: Partial<EarningsSummary> = {}): EarningsSummary {
  return {
    as_of: '2026-11-12T10:00:00+08:00',
    self: { today: zero, yesterday: zero, this_month: zero, last_month: zero },
    share: { today: zero, yesterday: zero, this_month: zero, last_month: zero },
    referral: {
      this_month: { est_fen: 0, credited_fen: 0 },
      last_month: { est_fen: 0, credited_fen: 0 },
    },
    ...overrides,
  };
}

describe('parsePlatforms', () => {
  it('keeps launched platforms in pill order and drops not_launched, missing and malformed ones', () => {
    expect(
      parsePlatforms({
        features: { platform_status: { pdd: 'on', jd: 'maintenance', taobao: 'not_launched' } },
      }),
    ).toEqual(['jd', 'pdd']);
    expect(parsePlatforms({ features: { platform_status: { taobao: 1, jd: '' } } })).toEqual([]);
    expect(parsePlatforms(null)).toEqual([]);
    expect(parsePlatforms({ features: { platform_status: [] } })).toEqual([]);
  });
});

describe('asPlatform', () => {
  it('accepts only the pill platforms', () => {
    expect(asPlatform('taobao')).toBe('taobao');
    expect(asPlatform('meituan')).toBeNull();
    expect(asPlatform(null)).toBeNull();
  });
});

describe('formatFen', () => {
  it('formats integer fen per BR-TEXT-10 and keeps the minus sign', () => {
    expect(formatFen(0)).toBe('¥0');
    expect(formatFen(269)).toBe('¥2.69');
    expect(formatFen(-520)).toBe('-¥5.2');
    expect(formatFen(1.5)).toBe('--');
  });
});

describe('formatAsOf', () => {
  it('uses the Shanghai list format: today, yesterday, same year, other year', () => {
    expect(formatAsOf('2026-11-12T10:00:00+08:00', NOW)).toBe('今天 10:00');
    expect(formatAsOf('2026-11-11T15:59:00Z', NOW)).toBe('昨天 23:59');
    expect(formatAsOf('2026-11-09T08:30:00+08:00', NOW)).toBe('11-09');
    expect(formatAsOf('2025-12-31T08:30:00+08:00', NOW)).toBe('2025-12-31');
    expect(formatAsOf('not a date', NOW)).toBe('not a date');
  });
});

describe('isEmptyPeriod', () => {
  it('is true only when every figure of the period is zero', () => {
    expect(isEmptyPeriod(summary(), 'this_month')).toBe(true);
    expect(
      isEmptyPeriod(
        summary({ self: { ...summary().self, today: { ...zero, credited_fen: -1 } } }),
        'today',
      ),
    ).toBe(false);
    expect(
      isEmptyPeriod(
        summary({ share: { ...summary().share, yesterday: { ...zero, paid_count: 1 } } }),
        'yesterday',
      ),
    ).toBe(false);
  });

  it('counts the referral column only for this and last month', () => {
    const referral = {
      this_month: { est_fen: 54, credited_fen: 0 },
      last_month: { est_fen: 0, credited_fen: 0 },
    };
    expect(isEmptyPeriod(summary({ referral }), 'this_month')).toBe(false);
    expect(isEmptyPeriod(summary({ referral }), 'last_month')).toBe(true);
    expect(isEmptyPeriod(summary({ referral }), 'today')).toBe(true);
    expect(isEmptyPeriod(summary({ referral: null }), 'this_month')).toBe(true);
  });
});
