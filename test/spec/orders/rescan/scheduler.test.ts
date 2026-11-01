// B1-04zm: scheduling rounds of a rescan stream, with injected platforms and caps: jd has no
// syncWindowCapMs and is not in scheduledPlatforms() until B1-04zr. The fixture's increment has
// caught up with the clock unless a test says otherwise, so a round's end is now by default.
import { expect, it } from 'vitest';
import { scheduleOrderRescan } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import type { OrderRescanWindow } from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { scheduledPlatforms } from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { handleOrderRescanWindow } from '../../../../apps/api/src/modules/orders/jobs/order-rescan.ts';
import {
  ACCOUNT,
  DAY_MS,
  HOUR_MS,
  JD_CAP_MS,
  JD_ENABLED,
  NOW,
  NOW_MS,
  OTHER_ACCOUNT,
  PDD_ACCOUNT,
  PDD_ENABLED,
  account,
  daysAgo,
  fixture,
  incrementOf,
  iso,
  job,
  pddAccount,
  rescanWindow,
  roundStart,
  stream,
} from './kit.ts';

const INSIDE = iso(NOW_MS - 5 * DAY_MS);
const TICK_MS = 120_000;
// Far enough behind now that a window past it would still fit before now.
const BEHIND_MS = NOW_MS - 3 * HOUR_MS;
// Spelled out: a table is built at collection, where iso() of the skeleton's margin would throw.
const ROUND_START_MS = NOW_MS - 30 * DAY_MS + HOUR_MS;

function expectReadBothCursors(f: ReturnType<typeof fixture>) {
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.read).toHaveBeenCalledWith(stream);
  expect(f.read).toHaveBeenCalledWith(incrementOf(stream));
}

it('[AC-B1-04zm#17] 游标空：流是 (app, 平台, 账号, rescan, -)，从 now − days + 1 小时发整窗', async () => {
  const f = fixture();
  await scheduleOrderRescan(f.scheduler, ['jd']);
  const win = rescanWindow(roundStart(30));
  expectReadBothCursors(f);
  expect(f.send).toHaveBeenCalledExactlyOnceWith('order-sync', 'rescan-window', win, {
    trx: null,
    singletonKey: `jd:${ACCOUNT}:rescan:-:${win.window_start}`,
  });
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.rewind).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#18] 游标在范围内：从游标起发一窗，不移动游标', async () => {
  const f = fixture({ cursor: INSIDE });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.sent()).toEqual([rescanWindow(INSIDE)]);
  expect(f.rewind).not.toHaveBeenCalled();
  expect(f.cursor()).toBe(INSIDE);
});

it('[AC-B1-04zm#19] 正好还剩一整窗：发到 now 为止，本轮未结束', async () => {
  const start = iso(NOW_MS - JD_CAP_MS);
  const f = fixture({ cursor: start });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.sent()).toEqual([{ ...rescanWindow(start), window_end: NOW }]);
  expect(f.rewind).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#20] 游标早于一轮起点：先把游标移到窗口起点再发，窗口完成后 CAS 能命中', async () => {
  const stale = daysAgo(45);
  const f = fixture({ cursor: stale });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  const win = rescanWindow(roundStart(30));
  expect(f.sent()).toEqual([win]);
  expect(f.rewind).toHaveBeenCalledExactlyOnceWith(stream, stale, win.window_start);
  expect(f.rewind.mock.invocationCallOrder[0]).toBeLessThan(f.send.mock.invocationCallOrder[0]!);
  await handleOrderRescanWindow(job(win), f.handler);
  expect(f.cursor()).toBe(win.window_end);
});

it.each([
  { label: '差 1 毫秒不足一窗', cursor: iso(NOW_MS - JD_CAP_MS + 1) },
  { label: '游标等于 now', cursor: NOW },
  { label: '游标晚于 now', cursor: iso(NOW_MS + 1) },
])('[AC-B1-04zm#21] $label：本轮结束，游标回到 now − days + 1 小时', async ({ cursor }) => {
  const f = fixture({ cursor });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.rewind).toHaveBeenCalledExactlyOnceWith(stream, cursor, roundStart(30));
  expect(f.cursor()).toBe(roundStart(30));
  // Whether the new round's first window goes out now or next round, it starts at the rewind.
  expect(f.sent().length).toBeLessThanOrEqual(1);
  expect(f.sent().every((win) => win['window_start'] === roundStart(30))).toBe(true);
});

it('[AC-B1-04zm#22] 每个流每轮只发一窗，流之间互不影响', async () => {
  const f = fixture({ accounts: [account, pddAccount], config: { [PDD_ENABLED]: true } });
  await scheduleOrderRescan({ ...f.scheduler, capsMs: { jd: JD_CAP_MS, pdd: 1_800_000 } }, [
    'jd',
    'pdd',
  ]);
  expect(f.sent().map((win) => [win['platform'], win['union_account_id']])).toEqual([
    ['jd', ACCOUNT],
    ['pdd', PDD_ACCOUNT],
  ]);
});

it('[AC-B1-04zm#23] 同窗口重复调度 singletonKey 不变，去重后游标不动', async () => {
  const f = fixture({ cursor: INSIDE });
  f.send.mockResolvedValue(null);
  await scheduleOrderRescan(f.scheduler, ['jd']);
  f.clock.advanceMs(TICK_MS);
  await scheduleOrderRescan(f.scheduler, ['jd']);
  const key = `jd:${ACCOUNT}:rescan:-:${INSIDE}`;
  expect(f.send.mock.calls.map(([, , , options]) => options.singletonKey)).toEqual([key, key]);
  expect(f.cursor()).toBe(INSIDE);
});

it('[AC-B1-04zm#24] 只调度传入的平台', async () => {
  const f = fixture({ accounts: [account, pddAccount], config: { [PDD_ENABLED]: true } });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.sent().map((win) => win['platform'])).toEqual(['jd']);
});

it('[AC-B1-04zm#25] 只写 rescan 流：increment 游标只读不动，调度也不推进任何游标', async () => {
  const f = fixture({ cursor: INSIDE });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expectReadBothCursors(f);
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.rewind).not.toHaveBeenCalled();
});

it.each([
  {
    label: '账号不是可查询账号',
    shut: (f: ReturnType<typeof fixture>) => f.queryableAccount.mockResolvedValue(OTHER_ACCOUNT),
    open: (f: ReturnType<typeof fixture>) => f.queryableAccount.mockResolvedValue(ACCOUNT),
  },
  {
    label: '平台没有可查询账号',
    shut: (f: ReturnType<typeof fixture>) => f.queryableAccount.mockResolvedValue(null),
    open: (f: ReturnType<typeof fixture>) => f.queryableAccount.mockResolvedValue(ACCOUNT),
  },
  {
    label: '离线熔断打开',
    shut: (f: ReturnType<typeof fixture>) => f.offlineCircuitOpen.mockResolvedValue(true),
    open: (f: ReturnType<typeof fixture>) => f.offlineCircuitOpen.mockResolvedValue(false),
  },
  {
    label: '站长授权不可用',
    shut: (f: ReturnType<typeof fixture>) => f.siteAuthAvailable.mockResolvedValue(false),
    open: (f: ReturnType<typeof fixture>) => f.siteAuthAvailable.mockResolvedValue(true),
  },
])('[AC-B1-04zm#26] $label：跳过且不动游标，恢复后接着发', async ({ shut, open }) => {
  const stale = daysAgo(45);
  const f = fixture({ cursor: stale });
  shut(f);
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.rewind).not.toHaveBeenCalled();
  expect(f.cursor()).toBe(stale);
  open(f);
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.sent()).toEqual([rescanWindow(roundStart(30))]);
});

it('[AC-B1-04zm#27] 时钟前进时一轮窗口仍首尾相接，走到尾段才结束，下一轮从当时的 now − days + 1 小时起', async () => {
  const f = fixture();
  const handled: OrderRescanWindow[] = [];
  const handle = async (win: OrderRescanWindow) => {
    handled.push(win);
    await handleOrderRescanWindow(job(win), f.handler);
  };
  for (let round = 0; round < 800 && f.rewind.mock.calls.length === 0; round += 1) {
    const before = f.send.mock.calls.length;
    await scheduleOrderRescan(f.scheduler, ['jd']);
    if (f.rewind.mock.calls.length > 0 || f.send.mock.calls.length === before) break;
    await handle(f.send.mock.calls.at(-1)?.[2] as OrderRescanWindow);
    f.clock.advanceMs(TICK_MS);
  }
  const ending = f.clock.now().getTime();
  expect(handled.length).toBeGreaterThanOrEqual(720);
  expect(handled[0]?.window_start).toBe(roundStart(30));
  expect(
    handled.every(
      (win, index) =>
        Date.parse(win.window_end) - Date.parse(win.window_start) === JD_CAP_MS &&
        (index === 0 || win.window_start === handled[index - 1]?.window_end),
    ),
  ).toBe(true);
  expect(ending - Date.parse(handled.at(-1)!.window_end)).toBeLessThan(JD_CAP_MS);
  expect(f.rewind).toHaveBeenCalledExactlyOnceWith(
    stream,
    handled.at(-1)!.window_end,
    roundStart(30, ending),
  );
  f.clock.advanceMs(TICK_MS);
  await scheduleOrderRescan(f.scheduler, ['jd']);
  const next = f.send.mock.calls.at(-1)?.[2] as OrderRescanWindow;
  expect(Date.parse(next.window_start)).toBeGreaterThanOrEqual(ending - 30 * DAY_MS);
  expect(Date.parse(next.window_start)).toBeLessThanOrEqual(
    Date.parse(roundStart(30, ending + TICK_MS)),
  );
});

it('[AC-B1-04zm#69] 平台未进调度、开关开：账号和窗口上限都在，也不读游标、不发窗口', async () => {
  const f = fixture({ config: { [JD_ENABLED]: true } });
  await scheduleOrderRescan(
    f.scheduler,
    scheduledPlatforms().filter((platform) => platform !== 'jd'),
  );
  expect(f.read).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#74] increment 游标落后于 now：一轮的终点是 increment 游标，最后一窗正好到它', async () => {
  const start = iso(BEHIND_MS - JD_CAP_MS);
  const f = fixture({ cursor: start, increment: iso(BEHIND_MS) });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.sent()).toEqual([rescanWindow(start)]);
  expect(f.rewind).not.toHaveBeenCalled();
});

it.each([
  { label: '差 1 毫秒不足一窗', cursorMs: BEHIND_MS - JD_CAP_MS + 1 },
  { label: '游标等于 increment 游标', cursorMs: BEHIND_MS },
  { label: '游标晚于 increment 游标', cursorMs: BEHIND_MS + 1 },
])(
  '[AC-B1-04zm#75] $label：离 now 还够一窗也结束本轮，不发增量没拉到的尾段',
  async ({ cursorMs }) => {
    const cursor = iso(cursorMs);
    const f = fixture({ cursor, increment: iso(BEHIND_MS) });
    await scheduleOrderRescan(f.scheduler, ['jd']);
    expect(f.rewind).toHaveBeenCalledExactlyOnceWith(stream, cursor, roundStart(30));
    expect(f.sent().length).toBeLessThanOrEqual(1);
    expect(f.sent().every((win) => win['window_start'] === roundStart(30))).toBe(true);
  },
);

it.each([
  { label: '游标为空', cursor: null },
  { label: '游标在范围内', cursor: INSIDE },
  { label: '游标早于一轮起点', cursor: daysAgo(45) },
])(
  '[AC-B1-04zm#76] increment 游标为空、$label：本轮不发、不动游标，有了增量游标后接着发',
  async ({ cursor }) => {
    const f = fixture({ cursor, increment: null });
    await scheduleOrderRescan(f.scheduler, ['jd']);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.rewind).not.toHaveBeenCalled();
    expect(f.cursor()).toBe(cursor);
    f.setIncrement(NOW);
    await scheduleOrderRescan(f.scheduler, ['jd']);
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04zm#77] increment 游标晚于 now：终点仍是 now', async () => {
  const increment = iso(NOW_MS + 5 * JD_CAP_MS);
  const full = iso(NOW_MS - JD_CAP_MS);
  const f = fixture({ cursor: full, increment });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.sent()).toEqual([rescanWindow(full)]);
  const short = iso(NOW_MS - JD_CAP_MS + 1);
  const g = fixture({ cursor: short, increment });
  await scheduleOrderRescan(g.scheduler, ['jd']);
  expect(g.rewind).toHaveBeenCalledExactlyOnceWith(stream, short, roundStart(30));
});

it.each([
  { label: '早于一轮起点', increment: daysAgo(45) },
  { label: '差 1 毫秒放不下首窗', increment: iso(ROUND_START_MS + JD_CAP_MS - 1) },
])('[AC-B1-04zm#78] increment 游标$label：本轮一窗都不发', async ({ increment }) => {
  const f = fixture({ increment });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.cursor()).toBeNull();
});

it('[AC-B1-04zm#79] 每个流看自己的 increment 游标', async () => {
  const f = fixture({ accounts: [account, pddAccount], config: { [PDD_ENABLED]: true } });
  f.read.mockImplementation(async (asked) =>
    asked.query_kind === 'increment' && asked.platform === 'pdd' ? NOW : null,
  );
  await scheduleOrderRescan({ ...f.scheduler, capsMs: { jd: JD_CAP_MS, pdd: 1_800_000 } }, [
    'jd',
    'pdd',
  ]);
  expect(f.sent().map((win) => win['platform'])).toEqual(['pdd']);
});

it('[AC-B1-04zm#80] sync_start_at 为空的账号不回扫：不读不动游标、不发窗口，别的账号照常', async () => {
  const stale = daysAgo(45);
  const noStart = { ...account, sync_start_at: null };
  const f = fixture({ cursor: stale, accounts: [noStart] });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.rewind).not.toHaveBeenCalled();
  expect(f.cursor()).toBe(stale);
  f.listEnabledAccounts.mockResolvedValue([noStart, { ...account, app_id: 'other-app' }]);
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.sent().map((win) => win['app_id'])).toEqual(['other-app']);
});
