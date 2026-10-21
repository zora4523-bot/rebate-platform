// B1-15f: the working-day deadline with the number of working days as a parameter, through risk's
// public surface (brief §9.2 #4 工作日; rule-test list item 12; BR-ID-27 15 个工作日含调休, BR-ID-36
// 「同 BR-ID-27」). Synthetic calendars (not a platform recording): 2026 National Day 10-01..10-07
// off, make-up Saturdays 09-20 and 10-10; 2027 01-01 and 01-04 off, make-up Saturday 01-09.
import { expect, it, vi } from 'vitest';
import { ROOT } from './kit.ts';

interface Calendar {
  holidays: readonly string[];
  makeupWorkdays: readonly string[];
}
interface ConfigReader {
  configValue(appId: string, key: string): Promise<{ value: unknown; version: number } | null>;
}
interface RiskPublic {
  workingDayDeadline(from: Date, calendars: Record<number, Calendar>, workingDays: number): Date;
  resolveWorkingDayDeadline(options: {
    appId: string;
    from: Date;
    workingDays: number;
    config: ConfigReader;
    logger: { warn(fields: object, msg: string): void };
  }): Promise<Date>;
}

async function risk(): Promise<RiskPublic> {
  return (await import(new URL('apps/api/src/modules/risk/index.ts', ROOT).href)) as RiskPublic;
}
async function appealDomain() {
  return (await import(
    new URL('apps/api/src/modules/risk/domain/appeal-deadline.ts', ROOT).href
  )) as { appealDeadline(at: Date, calendars: Record<number, Calendar>): Date };
}
async function appealCalendar() {
  return (await import(
    new URL('apps/api/src/modules/risk/application/appeal-calendar.ts', ROOT).href
  )) as {
    resolveAppealDeadline(options: {
      appId: string;
      clock: { now(): Date };
      config: ConfigReader;
      logger: { warn(fields: object, msg: string): void };
    }): Promise<Date>;
  };
}

const CALENDARS: Record<number, Calendar> = {
  2026: {
    holidays: [
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ],
    makeupWorkdays: ['2026-09-20', '2026-10-10'],
  },
  2027: { holidays: ['2027-01-01', '2027-01-04'], makeupWorkdays: ['2027-01-09'] },
};

function configured(years: readonly number[] = [2026, 2027]) {
  const values: Record<string, unknown> = {};
  for (const year of years) {
    values[`calendar.cn_holidays.${year}`] = CALENDARS[year]!.holidays;
    values[`calendar.cn_makeup_workdays.${year}`] = CALENDARS[year]!.makeupWorkdays;
  }
  return {
    configValue: vi.fn(async (_appId: string, key: string) =>
      key in values ? { value: values[key], version: 1 } : null,
    ),
  };
}

for (const [from, days, calendars, deadline] of [
  ['2026-09-28T02:00:00.000Z', 15, 'both', '2026-10-23T16:00:00.000Z'],
  ['2026-09-28T02:00:00.000Z', 15, 'none', '2026-10-19T16:00:00.000Z'],
  ['2026-12-24T01:00:00.000Z', 15, 'both', '2027-01-15T16:00:00.000Z'],
  ['2026-12-24T01:00:00.000Z', 15, '2026', '2027-01-14T16:00:00.000Z'],
  ['2026-09-27T15:59:59.999Z', 15, 'both', '2026-10-22T16:00:00.000Z'],
  ['2026-09-30T08:00:00.000Z', 3, 'both', '2026-10-10T16:00:00.000Z'],
] as const) {
  it(`[AC-B1-15f#32] workingDayDeadline 第 ${days} 个工作日 24:00（+08:00），提交当日不计，日历 ${calendars}：${from}`, async () => {
    const { workingDayDeadline } = await risk();
    const chosen: Record<number, Calendar> =
      calendars === 'both' ? CALENDARS : calendars === '2026' ? { 2026: CALENDARS[2026]! } : {};
    expect(workingDayDeadline(new Date(from), chosen, days).toISOString()).toBe(deadline);
  });
}

it('[AC-B1-15f#33] workingDayDeadline(…, 3) 与 appealDeadline 逐一相同（含调休与跨年）', async () => {
  const { workingDayDeadline } = await risk();
  const { appealDeadline } = await appealDomain();
  for (const from of [
    '2026-09-29T15:59:59.999Z',
    '2026-09-29T16:00:00.000Z',
    '2026-09-30T08:00:00.000Z',
    '2026-12-30T07:00:00.000Z',
    '2027-01-08T10:00:00.000Z',
  ]) {
    for (const calendars of [CALENDARS, {}]) {
      expect(workingDayDeadline(new Date(from), calendars, 3).toISOString()).toBe(
        appealDeadline(new Date(from), calendars).toISOString(),
      );
    }
  }
});

it('[AC-B1-15f#34] resolveWorkingDayDeadline 经 risk/index.ts 读各年日历：15 个工作日含调休与跨年', async () => {
  const { resolveWorkingDayDeadline } = await risk();
  const config = configured();
  const warn = vi.fn();
  const deadline = await resolveWorkingDayDeadline({
    appId: 'workday_app',
    from: new Date('2026-12-24T01:00:00.000Z'),
    workingDays: 15,
    config,
    logger: { warn },
  });
  expect(deadline.toISOString()).toBe('2027-01-15T16:00:00.000Z');
  expect(config.configValue).toHaveBeenCalledWith('workday_app', 'calendar.cn_holidays.2027');
  expect(config.configValue).toHaveBeenCalledWith(
    'workday_app',
    'calendar.cn_makeup_workdays.2027',
  );
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-15f#35] workingDays=3 时 resolveWorkingDayDeadline 与 resolveAppealDeadline 结果一致', async () => {
  const { resolveWorkingDayDeadline } = await risk();
  const { resolveAppealDeadline } = await appealCalendar();
  for (const from of [
    '2026-09-30T08:00:00.000Z',
    '2026-12-30T07:00:00.000Z',
    '2026-11-01T15:59:59.999Z',
  ]) {
    for (const years of [[2026, 2027], []] as const) {
      const viaNew = await resolveWorkingDayDeadline({
        appId: 'workday_app',
        from: new Date(from),
        workingDays: 3,
        config: configured(years),
        logger: { warn: vi.fn() },
      });
      const viaAppeal = await resolveAppealDeadline({
        appId: 'workday_app',
        clock: { now: () => new Date(from) },
        config: configured(years),
        logger: { warn: vi.fn() },
      });
      expect(viaNew.toISOString()).toBe(viaAppeal.toISOString());
    }
  }
});

it('[AC-B1-15f#36] 未配置年份按周末计算，warn 只带 app_id 与 year，日志键不是 appeal_calendar_unconfigured', async () => {
  const { resolveWorkingDayDeadline } = await risk();
  const warn = vi.fn();
  const deadline = await resolveWorkingDayDeadline({
    appId: 'workday_app',
    from: new Date('2026-09-28T02:00:00.000Z'),
    workingDays: 15,
    config: configured([]),
    logger: { warn },
  });
  expect(deadline.toISOString()).toBe('2026-10-19T16:00:00.000Z');
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]![0]).toEqual({ app_id: 'workday_app', year: 2026 });
  expect(warn.mock.calls[0]![1]).toEqual(expect.any(String));
  expect(warn.mock.calls[0]![1]).not.toBe('appeal_calendar_unconfigured');
});
