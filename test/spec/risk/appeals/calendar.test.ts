import { expect, it, vi } from 'vitest';

interface Calendar {
  holidays: readonly string[];
  makeupWorkdays: readonly string[];
}
async function calculate(at: string, calendars: Record<number, Calendar> = {}) {
  const { appealDeadline } = (await import(
    new URL('../../../../apps/api/src/modules/risk/domain/appeal-deadline.ts', import.meta.url).href
  )) as { appealDeadline(at: Date, calendars: Record<number, Calendar>): Date };
  return appealDeadline(new Date(at), calendars).toISOString();
}

for (const [at, deadline] of [
  ['2026-11-02T07:00:00.000Z', '2026-11-05T16:00:00.000Z'],
  ['2026-11-06T07:00:00.000Z', '2026-11-11T16:00:00.000Z'],
  ['2026-11-07T07:00:00.000Z', '2026-11-11T16:00:00.000Z'],
  ['2026-11-01T15:59:59.999Z', '2026-11-04T16:00:00.000Z'],
  ['2026-11-01T16:00:00.000Z', '2026-11-05T16:00:00.000Z'],
  ['2026-12-30T07:00:00.000Z', '2027-01-04T16:00:00.000Z'],
  ['2028-02-28T07:00:00.000Z', '2028-03-02T16:00:00.000Z'],
] as const) {
  it(`[AC-B1-03i#1] 第三个工作日 24:00，排除 +08:00 提交当日：${at}`, async () => {
    expect(await calculate(at)).toBe(deadline);
  });
}

it('[AC-B1-03i#2] 配置节假日和周末调休共同参与计数（合成日历，非平台录制）', async () => {
  expect(
    await calculate('2026-11-02T07:00:00.000Z', {
      2026: {
        holidays: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'],
        makeupWorkdays: ['2026-11-07'],
      },
    }),
  ).toBe('2026-11-10T16:00:00.000Z');
});

it('[AC-B1-03i#3] 跨年使用各年份的日历', async () => {
  expect(
    await calculate('2026-12-30T07:00:00.000Z', {
      2026: { holidays: ['2026-12-31'], makeupWorkdays: [] },
      2027: { holidays: ['2027-01-01'], makeupWorkdays: ['2027-01-02'] },
    }),
  ).toBe('2027-01-05T16:00:00.000Z');
});

async function resolve(at: string, values: Record<string, unknown>, fail = false) {
  const configValue = vi.fn(async (_app: string, key: string) => {
    if (fail) throw new Error('private-calendar-outage');
    return key in values ? { value: values[key], version: 1 } : null;
  });
  const warn = vi.fn();
  const options = {
    appId: 'calendar_app',
    clock: { now: () => new Date(at) },
    config: { configValue },
    logger: { warn },
  };
  type Options = typeof options;
  const { resolveAppealDeadline } = (await import(
    new URL('../../../../apps/api/src/modules/risk/application/appeal-calendar.ts', import.meta.url)
      .href
  )) as { resolveAppealDeadline(options: Options): Promise<Date> };
  const deadline = await resolveAppealDeadline(options);
  return { deadline, warn, configValue };
}

it('[AC-B1-03i#4] 配置端口按 app_id 与跨年键读取；有效日历无降级告警', async () => {
  const f = await resolve('2026-12-30T07:00:00.000Z', {
    'calendar.cn_holidays.2026': ['2026-12-31'],
    'calendar.cn_makeup_workdays.2026': [],
    'calendar.cn_holidays.2027': ['2027-01-01'],
    'calendar.cn_makeup_workdays.2027': ['2027-01-02'],
  });
  expect(f.deadline.toISOString()).toBe('2027-01-05T16:00:00.000Z');
  for (const year of [2026, 2027]) {
    for (const key of ['cn_holidays', 'cn_makeup_workdays']) {
      expect(f.configValue).toHaveBeenCalledWith('calendar_app', `calendar.${key}.${year}`);
    }
  }
  expect(f.warn).not.toHaveBeenCalled();
});

for (const scenario of [
  { label: '均未配置', values: {}, fail: false },
  { label: '读取失败', values: {}, fail: true },
  ...['private-invalid-value', ['2026-02-30'], [7], ['2026-1-2']].map((value) => ({
    label: `非法节假日 ${JSON.stringify(value)}`,
    values: { 'calendar.cn_holidays.2026': value, 'calendar.cn_makeup_workdays.2026': [] },
    fail: false,
  })),
  {
    label: '非法调休日',
    values: { 'calendar.cn_holidays.2026': ['2026-11-03'], 'calendar.cn_makeup_workdays.2026': 7 },
    fail: false,
  },
]) {
  it(`[AC-B1-03i#5] ${scenario.label} 按周末降级、每年一条脱敏 warn`, async () => {
    const f = await resolve('2026-11-02T07:00:00.000Z', scenario.values, scenario.fail);
    expect(f.deadline.toISOString()).toBe('2026-11-05T16:00:00.000Z');
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn.mock.calls[0]![0]).toMatchObject({ app_id: 'calendar_app', year: 2026 });
    const warning = JSON.stringify(f.warn.mock.calls);
    expect(warning).toContain('appeal_calendar_unconfigured');
    expect(warning).not.toContain('private-');
    expect(warning).not.toContain('2026-02-30');
    expect(warning).not.toContain('2026-11-03');
    expect(warning).not.toContain('2026-1-2');
  });
}

it('[AC-B1-03i#6] 跨年只有缺失年份降级，不丢弃另一年的有效配置', async () => {
  const f = await resolve('2026-12-30T07:00:00.000Z', {
    'calendar.cn_holidays.2026': ['2026-12-31'],
    'calendar.cn_makeup_workdays.2026': [],
  });
  expect(f.deadline.toISOString()).toBe('2027-01-05T16:00:00.000Z');
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(f.warn.mock.calls[0]![0]).toMatchObject({ app_id: 'calendar_app', year: 2027 });
});
