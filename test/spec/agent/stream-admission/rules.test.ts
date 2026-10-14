// B3-03g replacement of the B3-03c rules (design §7.3): the pure functions keep their names and
// values; the default limits are also what the limits source falls back to (design §1.4), and the
// day of dayKeyOf / nextResetAt is the interval dayRange gives to the counting queries.
// rules:80 (data.next) moved into quota.int.test.ts next to the 30502 it shapes; rules:90 (refund
// list) into the ending × cards table there; rules:115 (store unavailable) into lock.int.test.ts.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  admissionDefaults,
  dayKeyOf,
  dayRange,
  nextResetAt,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import { createQuotaLimitsSource } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';

it('[AC-B3-03g#47][BR-AI-15] 默认值：会员 30 条/日，游客档 3 条/device_hash/日 + 30 条/IP/日，10 条/分，每会话 30 轮；上限来源缺键或值非法时逐项取默认并告警，读取失败则抛错', async () => {
  expect(admissionDefaults()).toEqual({
    memberDaily: 30,
    guestDaily: 3,
    guestIpDaily: 30,
    perMinute: 10,
    maxRounds: 30,
  });
  const warns: unknown[] = [];
  const config: Record<string, unknown> = {
    'agent.member_daily_quota': 50,
    'agent.guest_daily_quota': -1,
  };
  const source = createQuotaLimitsSource({
    reader: {
      configValue: (appId, key) => {
        expect(appId).toBe('couli');
        return Promise.resolve(key in config ? { value: config[key] as never, version: 1 } : null);
      },
    },
    logger: { warn: (...args: unknown[]) => void warns.push(args) },
  });
  expect(await source.current('couli')).toEqual({
    memberDaily: 50,
    guestDaily: 3,
    guestIpDaily: 30,
    perMinute: 10,
    maxRounds: 30,
  });
  expect(warns.length).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(warns)).toContain('agent.quota_config_invalid');
  const failing = createQuotaLimitsSource({
    reader: { configValue: () => Promise.reject(new Error('db down')) },
  });
  await expect(failing.current('couli')).rejects.toThrow();
});

it('[AC-B3-03g#83][BR-AI-15] 三个日上限各由自己的配置项决定：agent.member_daily_quota、agent.guest_daily_quota、agent.guest_ip_daily_quota 取不同的有效值（含游客 0）时逐项读到，互不串位、不告警', async () => {
  const cases: [number, number, number][] = [
    [45, 5, 12],
    [7, 0, 19],
    [0, 8, 1],
  ];
  for (const [member, guestDevice, guestIp] of cases) {
    const label = `${String(member)}/${String(guestDevice)}/${String(guestIp)}`;
    const config: Record<string, number> = {
      'agent.member_daily_quota': member,
      'agent.guest_daily_quota': guestDevice,
      'agent.guest_ip_daily_quota': guestIp,
    };
    const asked: string[] = [];
    const warns: unknown[] = [];
    const source = createQuotaLimitsSource({
      reader: {
        configValue: (appId, key) => {
          asked.push(`${appId}:${key}`);
          return Promise.resolve(
            key in config ? { value: config[key] as never, version: 3 } : null,
          );
        },
      },
      logger: { warn: (...args: unknown[]) => void warns.push(args) },
    });
    expect(await source.current('couli'), label).toEqual({
      memberDaily: member,
      guestDaily: guestDevice,
      guestIpDaily: guestIp,
      perMinute: 10,
      maxRounds: 30,
    });
    expect(asked, label).toEqual(
      expect.arrayContaining([
        'couli:agent.member_daily_quota',
        'couli:agent.guest_daily_quota',
        'couli:agent.guest_ip_daily_quota',
      ]),
    );
    expect(warns, label).toEqual([]);
  }
});

it('[AC-B3-03g#48][BR-AI-15] 自然日按 +08:00：日界两侧分属两天，reset_at 为次日 00:00+08:00，计数区间 [当日 00:00, 次日 00:00)', () => {
  const cases: [string, string, string][] = [
    ['2026-10-06T15:59:59.999Z', '2026-10-06', '2026-10-07T00:00:00+08:00'],
    ['2026-10-06T16:00:00.000Z', '2026-10-07', '2026-10-08T00:00:00+08:00'],
    ['2026-10-06T02:00:00.000Z', '2026-10-06', '2026-10-07T00:00:00+08:00'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01', '2027-01-02T00:00:00+08:00'],
    ['2026-12-31T15:59:59.999Z', '2026-12-31', '2027-01-01T00:00:00+08:00'],
    ['2028-02-28T16:30:00.000Z', '2028-02-29', '2028-03-01T00:00:00+08:00'],
  ];
  for (const [instant, day, reset] of cases) {
    expect(dayKeyOf(new Date(instant)), instant).toBe(day);
    expect(nextResetAt(new Date(instant)), instant).toBe(reset);
  }
  expect(dayRange('2026-10-06')).toEqual({
    start: new Date('2026-10-05T16:00:00.000Z'),
    end: new Date('2026-10-06T16:00:00.000Z'),
  });
  expect(dayRange('2028-02-29')).toEqual({
    start: new Date('2028-02-28T16:00:00.000Z'),
    end: new Date('2028-02-29T16:00:00.000Z'),
  });
});

it('[AC-B3-03g#49][BR-AI-15] 任意时刻：reset_at 在 (now, now+24h]，前一毫秒仍属当日，reset_at 起属次日；dayRange(当日) 含 now、止于 reset_at', () => {
  const DAY = 86_400_000;
  const EIGHT_HOURS = 28_800_000;
  const localDay = (ms: number) => new Date(ms + EIGHT_HOURS).toISOString().slice(0, 10);
  expect(dayRange(dayKeyOf(new Date(0))).start.getTime()).toBe(-EIGHT_HOURS);
  const holds = (ms: number): boolean => {
    try {
      const reset = nextResetAt(new Date(ms));
      const resetMs = Date.parse(reset);
      const range = dayRange(dayKeyOf(new Date(ms)));
      return (
        /^\d{4}-\d{2}-\d{2}T00:00:00\+08:00$/.test(reset) &&
        resetMs > ms &&
        resetMs - ms <= DAY &&
        dayKeyOf(new Date(ms)) === localDay(ms) &&
        dayKeyOf(new Date(resetMs - 1)) === localDay(ms) &&
        dayKeyOf(new Date(resetMs)) !== localDay(ms) &&
        range.start.getTime() <= ms &&
        range.end.getTime() === resetMs &&
        range.end.getTime() - range.start.getTime() === DAY
      );
    } catch {
      return false;
    }
  };
  const details = fc.check(
    fc.property(
      fc.oneof(
        fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) }),
        fc
          .integer({ min: 18_000, max: 26_000 })
          .chain((d) => fc.constantFrom(d * DAY - EIGHT_HOURS - 1, d * DAY - EIGHT_HOURS)),
      ),
      holds,
    ),
    propParams(),
  );
  expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
});
