// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  acSummary,
  ALL,
  copy,
  earningsServer,
  period,
  platformNames,
  reply,
  summary,
  zeroSummary,
  type EarningsSummary,
  type PeriodKey,
} from './earnings-fixtures.ts';
import {
  columnValues,
  containsName,
  control,
  controls,
  exactName,
  hasSection,
  isSelected,
  money,
  mount,
  numbers,
  pageText,
  ready,
  section,
  squash,
} from './earnings-helpers.ts';

// 期望值按 BR-TEXT-10 手算（不调用实现所用的格式化函数）：0 → ¥0，负数「-」在「¥」前。
const expected: Record<PeriodKey, Record<'self' | 'share', [string, string, string]>> = {
  today: { self: ['1', '¥2.69', '¥0'], share: ['2', '¥1', '¥0'] },
  yesterday: { self: ['3', '¥1.35', '¥0.12'], share: ['4', '¥1.5', '¥0'] },
  this_month: { self: ['5', '¥8.12', '-¥5.2'], share: ['6', '¥10.01', '¥0.61'] },
  last_month: { self: ['7', '¥19.9', '¥3'], share: ['8', '¥20', '¥9.9'] },
};

function expectColumns(key: PeriodKey): void {
  for (const column of ['self', 'share'] as const) {
    const values = columnValues(column === 'self' ? copy.self : copy.share);
    const [count, est, credited] = expected[key][column];
    expect(values, `${copy.period[key]} ${column}`).toEqual({
      count: [count],
      est: [est],
      credited: [credited],
    });
  }
}

/** Referral column text must carry no count, date or other digits besides its amounts. */
function expectReferralAmountsOnly(card: HTMLElement): void {
  expect(numbers(card), '邀请栏除金额外没有数字（笔数、日期）').toEqual([]);
  const text = squash(card.textContent);
  expect(text).not.toContain(squash(copy.paidCount));
  expect(text).not.toContain(squash(copy.period.today));
  expect(text).not.toContain(squash(copy.period.yesterday));
}

it('[AC-F1-12a-VIEW#1] 进页默认本月：自购、分享两栏的付款笔数、预估、已结算取 this_month，已结算为负带负号', async () => {
  mount(earningsServer().api);
  await ready();
  expect(isSelected(control(copy.period.this_month))).toBe(true);
  for (const key of ['today', 'yesterday', 'last_month'] as const)
    expect(isSelected(control(copy.period[key]))).toBe(false);
  expectColumns('this_month');
  const titled = document.title === copy.title || pageText(document.body).includes(copy.title);
  expect(titled, `标题「${copy.title}」`).toBe(true);
});

it('[AC-F1-12a-VIEW#2] 切到今日、昨日、上月再回本月，两栏各取对应期间的三项', async () => {
  mount(earningsServer().api);
  await ready();
  const user = userEvent.setup();
  for (const key of ['today', 'yesterday', 'last_month', 'this_month'] as const) {
    await user.click(control(copy.period[key]));
    await waitFor(() => expect(isSelected(control(copy.period[key]))).toBe(true));
    expectColumns(key);
  }
});

it('[AC-F1-12a-VIEW#3] 邀请栏本月、上月只显示金额合计（上月已结算为负带负号），没有笔数与日期', async () => {
  mount(earningsServer().api);
  await ready();
  let card = section(copy.referral);
  expect(money(card)).toEqual(expect.arrayContaining(['¥0.54', '¥0.3']));
  expect(squash(card.textContent)).toContain(squash(copy.estPromo));
  expect(squash(card.textContent)).toContain(squash(copy.credited));
  expect(squash(card.textContent)).toContain(squash(copy.referralNote));
  expect(squash(card.textContent)).not.toContain(squash(copy.platformNote));
  expectReferralAmountsOnly(card);
  await userEvent.setup().click(control(copy.period.last_month));
  await waitFor(() => expect(isSelected(control(copy.period.last_month))).toBe(true));
  card = section(copy.referral);
  expect(money(card)).toEqual(expect.arrayContaining(['¥0.77', '-¥0.15']));
  expectReferralAmountsOnly(card);
});

it('[AC-F1-12a-VIEW#4] referral 为 null 时整个邀请栏不显示，不渲染成 0', async () => {
  const http = earningsServer({ summary: () => reply({ ...summary, referral: null }) });
  const view = mount(http.api);
  await ready();
  expect(hasSection(copy.referral)).toBe(false);
  const text = pageText(view.container);
  expect(text).not.toContain(squash(copy.referralNote));
  expect(text).not.toContain(squash(copy.platformNote));
  expectColumns('this_month');
  await userEvent.setup().click(control(copy.period.last_month));
  await waitFor(() => expect(isSelected(control(copy.period.last_month))).toBe(true));
  expect(hasSection(copy.referral)).toBe(false);
  expectColumns('last_month');
});

it('[AC-F1-12a-VIEW#5] 选中平台后自购与分享换成该平台的数，邀请栏照常并注「不分平台」', async () => {
  const http = earningsServer();
  mount(http.api);
  await ready();
  await userEvent.setup().click(control(platformNames.taobao));
  await waitFor(() => expect(columnValues(copy.self).count).toEqual(['2']));
  expect(columnValues(copy.self)).toEqual({ count: ['2'], est: ['¥2.22'], credited: ['¥3.33'] });
  expect(columnValues(copy.share)).toEqual({ count: ['1'], est: ['¥5.55'], credited: ['¥0'] });
  const card = section(copy.referral);
  expect(squash(card.textContent)).toContain(squash(copy.platformNote));
  expect(money(card)).toEqual(expect.arrayContaining(['¥0.54', '¥0.3']));
  expectReferralAmountsOnly(card);
});

it('[AC-F1-12a-VIEW#6] AC-S2-61 ①：本月、昨日、上月、今日的取值与邀请栏合计', async () => {
  mount(earningsServer({ summary: () => reply(acSummary) }).api);
  await ready();
  expect(columnValues(copy.self)).toEqual({ count: ['2'], est: ['¥4.04'], credited: ['¥0'] });
  expect(money(section(copy.referral))).toEqual(expect.arrayContaining(['¥0.54', '¥0']));
  const user = userEvent.setup();
  await user.click(control(copy.period.yesterday));
  await waitFor(() => expect(columnValues(copy.self).count).toEqual(['0']));
  await user.click(control(copy.period.last_month));
  await waitFor(() =>
    expect(columnValues(copy.self)).toEqual({ count: ['2'], est: ['¥5.2'], credited: ['¥0'] }),
  );
  await user.click(control(copy.period.today));
  await waitFor(() =>
    expect(columnValues(copy.share)).toEqual({ count: ['1'], est: ['¥1'], credited: ['¥0'] }),
  );
});

it('[AC-F1-12a-VIEW#7] AC-S2-61 ⑦：本月只有红冲时已结算显示带负号的金额', async () => {
  const reversal: EarningsSummary = {
    ...acSummary,
    self: { ...acSummary.self, this_month: period(0, 0, -300), last_month: period(1, 0, 300) },
  };
  mount(earningsServer({ summary: () => reply(reversal) }).api);
  await ready();
  expect(columnValues(copy.self).credited).toEqual(['-¥3']);
  await userEvent.setup().click(control(copy.period.last_month));
  await waitFor(() => expect(columnValues(copy.self).credited).toEqual(['¥3']));
});

it('[AC-F1-12a-VIEW#8] 统计截至行用 earnings.as_of，时间按 BR-TEXT-11 列表写法', async () => {
  const cases = [
    { as_of: '2026-11-12T10:00:00+08:00', time: '今天 10:00' },
    { as_of: '2026-11-11T15:59:00Z', time: '昨天 23:59' },
    { as_of: '2026-11-09T08:30:00+08:00', time: '11-09' },
  ];
  for (const item of cases) {
    const http = earningsServer({ summary: () => reply({ ...summary, as_of: item.as_of }) });
    const view = mount(http.api);
    await ready();
    const text = pageText(view.container);
    expect(text, item.as_of).toContain(squash(copy.asOf.replace('{time}', item.time)));
    expect(text).not.toMatch(/\{time\}|T\d{2}:\d{2}|\+08:00|Z\b/);
    cleanup();
  }
});

it('[AC-F1-12a-VIEW#9] 各项全为 0：不出整页空态，三栏照常显示 0 与 ¥0，统计截至行后接 empty_hint 且随期间变化', async () => {
  const view = mount(earningsServer({ summary: () => reply(zeroSummary) }).api);
  await ready();
  for (const title of [copy.self, copy.share])
    expect(columnValues(title)).toEqual({ count: ['0'], est: ['¥0'], credited: ['¥0'] });
  expect(money(section(copy.referral))).toEqual(expect.arrayContaining(['¥0']));
  // 平台筛选与期间切换照常显示（BR-FUND-25 细则「没有收益时」）。
  expect(controls(exactName(ALL))).toHaveLength(1);
  for (const key of ['today', 'yesterday', 'this_month', 'last_month'] as const)
    expect(controls(exactName(copy.period[key]))).toHaveLength(1);
  const hint = (key: PeriodKey) => squash(copy.emptyHint.replace('{period}', copy.period[key]));
  const asOf = squash(copy.asOf.replace('{time}', '今天 10:00'));
  let text = pageText(view.container);
  expect(text).toContain(hint('this_month'));
  // empty_hint 接在统计时点那一行后面（BR-TEXT-01）。
  expect(text.indexOf(asOf)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(hint('this_month'))).toBeGreaterThan(text.indexOf(asOf));
  expect(screen.queryByRole('alert')).toBeNull();
  const user = userEvent.setup();
  for (const key of ['today', 'yesterday', 'last_month'] as const) {
    await user.click(control(copy.period[key]));
    await waitFor(() => expect(pageText(view.container)).toContain(hint(key)));
    text = pageText(view.container);
    expect(text).not.toContain(hint('this_month'));
    expect(columnValues(copy.self)).toEqual({ count: ['0'], est: ['¥0'], credited: ['¥0'] });
  }
});

it('[AC-F1-12a-VIEW#10] 有收益的期间不显示 empty_hint；只在所选期间各栏全为 0 时才显示', async () => {
  const quietToday: EarningsSummary = {
    ...summary,
    self: { ...summary.self, today: period(0, 0, 0) },
    share: { ...summary.share, today: period(0, 0, 0) },
    referral: null,
  };
  const view = mount(earningsServer({ summary: () => reply(quietToday) }).api);
  await ready();
  const lead = squash(copy.emptyHint.replace('{period}', ''));
  expect(pageText(view.container)).not.toContain(lead);
  await userEvent.setup().click(control(copy.period.today));
  await waitFor(() =>
    expect(pageText(view.container)).toContain(
      squash(copy.emptyHint.replace('{period}', copy.period.today)),
    ),
  );
  await userEvent.setup().click(control(copy.period.yesterday));
  await waitFor(() => expect(isSelected(control(copy.period.yesterday))).toBe(true));
  expect(pageText(view.container)).not.toContain(lead);
});

it('[AC-F1-12a-VIEW#11] 页面文案取字典，不出现「团队」「下线」「佣金」等禁用词与占位符', async () => {
  const view = mount(earningsServer().api);
  await ready();
  const user = userEvent.setup();
  for (const key of ['today', 'yesterday', 'last_month', 'this_month'] as const) {
    await user.click(control(copy.period[key]));
    expect(pageText(view.container)).not.toMatch(
      /团队|下线|二级|间推|佣金|返现|null|undefined|NaN|\{[a-z_]+\}/,
    );
  }
  for (const title of [copy.self, copy.share, copy.referral])
    expect(pageText(view.container)).toContain(squash(title));
});

it('[AC-F1-12a-NOTE#1] 指标旁问号打开说明弹层，读出指标名与字典说明；Esc 关闭后焦点回到问号，不发请求', async () => {
  const http = earningsServer();
  mount(http.api);
  await ready();
  const user = userEvent.setup();
  const cases = [
    { title: copy.self, name: copy.paidCount, hint: copy.paidCountHint },
    { title: copy.self, name: copy.estSelf, hint: copy.estHint },
    { title: copy.self, name: copy.credited, hint: copy.creditedHint },
    { title: copy.share, name: copy.estPromo, hint: copy.estHint },
  ];
  for (const item of cases) {
    const buttons = within(section(item.title)).getAllByRole('button', {
      name: containsName(item.name),
    });
    expect(buttons, `「${item.title}」栏「${item.name}」的说明入口`).toHaveLength(1);
    const button = buttons[0]!;
    await user.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(squash(dialog.textContent)).toContain(squash(item.name));
    expect(squash(dialog.textContent)).toContain(squash(item.hint));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  }
  await act(async () => {});
  expect(http.summaryRequests()).toHaveLength(1);
});
