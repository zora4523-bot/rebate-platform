// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DAY,
  FILTER_PARAMS,
  LIST_PARAMS,
  VIEW_GRANTS,
  createServer,
  dailySnapshots,
  dayBefore,
} from './fixtures.ts';
import {
  COLUMN,
  FLOW_TIMEOUT,
  NOT_A_VALUE,
  NOT_COMPARABLE,
  RECEIVABLE_TOTAL,
  amountsIn,
  assertPaging,
  cellText,
  columnTitles,
  dataRows,
  dayRow,
  dayRows,
  extraParams,
  listed,
  main,
  mount,
  nextPageNear,
  receivableText,
  rowHint,
  settled,
  showsEitherSign,
  showsYuan,
  textOf,
} from './helpers.ts';

interface Expected {
  readonly day: string;
  readonly available: string;
  /** total_negative_fen is a magnitude: shown with or without a minus sign. */
  readonly negative: string;
  readonly frozen: string;
  readonly waiting: string;
  readonly estimated: string;
  /** Each platform's union_receivable_fen as yuan. */
  readonly receivables: Readonly<Record<string, string>>;
  /** The sum of the receivables (only checked if the page shows a total). */
  readonly receivableSum: string;
  readonly comparable: boolean;
}

/**
 * Expected cells of the four samples, computed by hand from the fen in fixtures.ts (two decimals);
 * within a row every value differs, so a value under another column or platform fails.
 */
const EXPECTED: readonly Expected[] = [
  {
    day: '2026-10-29',
    // 1250034 fen
    available: '12500.34',
    // 3217 fen
    negative: '32.17',
    // 48006 fen
    frozen: '480.06',
    // 860071 fen
    waiting: '8600.71',
    // 2310089 fen
    estimated: '23100.89',
    // jd 151005, pdd −2300, taobao 864012 fen
    receivables: { jd: '1510.05', pdd: '-23.00', taobao: '8640.12' },
    // 151005 − 2300 + 864012 = 1012717 fen
    receivableSum: '10127.17',
    comparable: true,
  },
  {
    day: '2026-10-28',
    // 1198012 fen
    available: '11980.12',
    // 4105 fen
    negative: '41.05',
    // 52040 fen
    frozen: '520.40',
    // 845003 fen
    waiting: '8450.03',
    // 2287019 fen
    estimated: '22870.19',
    // taobao 850550 fen
    receivables: { taobao: '8505.50' },
    receivableSum: '8505.50',
    comparable: false,
  },
  {
    day: '2026-10-26',
    // 1100450 fen
    available: '11004.50',
    // 0 fen
    negative: '0.00',
    // 61 fen
    frozen: '0.61',
    // 830120 fen
    waiting: '8301.20',
    // 2200300 fen
    estimated: '22003.00',
    // jd 98765, taobao 701234 fen
    receivables: { jd: '987.65', taobao: '7012.34' },
    // 98765 + 701234 = 799999 fen
    receivableSum: '7999.99',
    comparable: true,
  },
  {
    day: '2026-10-25',
    // 900000 fen
    available: '9000.00',
    // 1500 fen
    negative: '15.00',
    // 2500 fen
    frozen: '25.00',
    // 0 fen
    waiting: '0.00',
    // 300000 fen
    estimated: '3000.00',
    receivables: {},
    receivableSum: '0.00',
    comparable: true,
  },
];

const BALANCE_COLUMNS = ['available', 'negative', 'frozen', 'waiting', 'estimated'] as const;

/**
 * Columns of the board that are not in this operation (the contract leaves out W, P and the
 * water-level state, the union collection entry and the company Alipay balance): none may be a
 * column title. Matched against each squashed title; W and P only as standalone capitals.
 */
const BOARD_ONLY_TITLES: readonly (readonly [string, RegExp])[] = [
  ['企业支付宝余额', /企业支付宝|支付宝余额/],
  ['W', /(?<![A-Za-z])W(?![A-Za-z])/],
  ['预计提现', /预计提现/],
  ['P', /(?<![A-Za-z])P(?![A-Za-z])/],
  ['水位', /水位/],
  ['状态', /^状态$|^正常$|超告警线/],
  ['当日联盟回款', /当日.{0,4}回款|^(?:联盟)?回款(?:金额|额)?$/],
];
/** Board-only words that must not show inside a row either. */
const BOARD_ONLY_WORDS = /企业支付宝|预计提现|水位|超告警线|当日.{0,4}回款/;

/**
 * Every amount the row of `expected` may show: its own contract fields (the negative total with
 * or without a minus sign) and, for a receivable total, the sum of its receivables.
 */
function allowedAmounts(expected: Expected): string[] {
  const magnitude = expected.negative.replace(/^-/, '');
  return [
    expected.available,
    magnitude,
    `-${magnitude}`,
    expected.frozen,
    expected.waiting,
    expected.estimated,
    ...Object.values(expected.receivables),
    expected.receivableSum,
  ];
}

/** Every amount of the row except `except`. */
function otherValues(expected: Expected, except: string): string[] {
  return [
    ...BALANCE_COLUMNS.map((name) => expected[name]),
    ...Object.values(expected.receivables),
  ].filter((value) => value !== except);
}

it(
  '[AC-F1-08ga-LIST#1] 进入后读第 1 页（只带契约参数、page_size ≤ 200、不带日期筛选），按返回顺序（快照日降序）列出四个快照日',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(DAY.bare);
    await settled(server);
    assertPaging(server.reads(), LIST_PARAMS);
    const first = server.tableReads()[0];
    expect(first, 'an unfiltered table read').toBeDefined();
    expect(first!.query['page'] ?? '1').toBe('1');
    for (const name of FILTER_PARAMS) expect(first!.query[name], `no ${name}`).toBeUndefined();
    const order = [DAY.latest, DAY.late, DAY.older, DAY.bare];
    const nodes = order.map((day) => dayRow(day));
    // Node.DOCUMENT_POSITION_FOLLOWING, spelled out so no environment global is needed.
    const following = 0x4;
    for (let index = 1; index < nodes.length; index += 1) {
      const relation = nodes[index - 1]!.compareDocumentPosition(nodes[index]!);
      expect(relation & following, `${order[index]} after ${order[index - 1]}`).not.toBe(0);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-LIST#2] 每行在各自的列下显示快照日期、可用余额合计、负余额合计、冻结合计、已收货待结算合计、预估合计（元，两位小数，按分手算，照快照原样不重算）',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    await listed(DAY.bare);
    for (const expected of EXPECTED) {
      const row = dayRow(expected.day);
      const label = expected.day;
      expect(cellText(row, COLUMN.date), `${label} date`).toContain(expected.day);

      const available = cellText(row, COLUMN.available);
      expect(showsYuan(available, expected.available), `${label} available`).toBe(true);
      const negative = cellText(row, COLUMN.negative);
      expect(showsEitherSign(negative, expected.negative), `${label} negative`).toBe(true);
      const frozen = cellText(row, COLUMN.frozen);
      expect(showsYuan(frozen, expected.frozen), `${label} frozen`).toBe(true);
      const waiting = cellText(row, COLUMN.waiting);
      expect(showsYuan(waiting, expected.waiting), `${label} waiting`).toBe(true);
      const estimated = cellText(row, COLUMN.estimated);
      expect(showsYuan(estimated, expected.estimated), `${label} estimated`).toBe(true);

      const cells = { available, negative, frozen, waiting, estimated };
      for (const name of BALANCE_COLUMNS) {
        for (const other of otherValues(expected, expected[name]))
          expect(showsEitherSign(cells[name], other), `${label} ${name} ≠ ${other}`).toBe(false);
      }
      expect(textOf(row), `${label} no raw value`).not.toMatch(NOT_A_VALUE);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-LIST#3] 各平台已入账未回款与其平台绑定（按分手算、负值保留负号、对调必红）；若显示未回款合计，等于各平台值之和',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    await listed(DAY.bare);
    for (const expected of EXPECTED) {
      const row = dayRow(expected.day);
      const platforms = Object.keys(expected.receivables);
      for (const platform of platforms) {
        const others = platforms.filter((one) => one !== platform);
        const shown = receivableText(row, platform, others);
        const yuan = expected.receivables[platform]!;
        expect(showsYuan(shown, yuan), `${expected.day} ${platform} ${yuan} in「${shown}」`).toBe(
          true,
        );
        for (const other of others) {
          const foreign = expected.receivables[other]!;
          expect(
            showsEitherSign(shown, foreign),
            `${expected.day} ${platform} does not show ${other}'s ${foreign}`,
          ).toBe(false);
        }
      }
      const totals = columnTitles(row).filter((title) => RECEIVABLE_TOTAL.test(title));
      expect(totals.length, 'at most one receivable total column').toBeLessThanOrEqual(1);
      if (totals.length === 1 && platforms.length > 0) {
        const total = cellText(row, RECEIVABLE_TOTAL);
        expect(showsYuan(total, expected.receivableSum), `${expected.day} total`).toBe(true);
      }
    }
    // The negative receivable keeps its sign (pdd −2300 fen = -23.00, never 23.00).
    const pdd = receivableText(dayRow(DAY.latest), 'pdd', ['jd', 'taobao']);
    expect(showsYuan(pdd, '-23.00'), `pdd -23.00 in「${pdd}」`).toBe(true);
    expect(showsYuan(pdd, '23.00'), 'pdd not shown as positive').toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-LIST#4] waiting_comparable=false 的快照日（2026-10-28）行内有「不可比」类提示；可比的行没有',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(DAY.bare);
    for (const expected of EXPECTED) {
      const hint = rowHint(dayRow(expected.day));
      if (expected.comparable)
        expect(hint, `${expected.day} is comparable: no hint`).not.toMatch(NOT_COMPARABLE);
      else expect(hint, `${expected.day} is not comparable: a hint`).toMatch(NOT_COMPARABLE);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-LIST#5] 没写快照的日子（2026-10-27）没有行，不补零：表格只有四行，没有全为 0.00 的补行',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(DAY.bare);
    await settled(server);
    expect(dayRows(DAY.missing), 'no row for the day without a snapshot').toEqual([]);
    const rows = dataRows();
    expect(rows, 'one row per written snapshot').toHaveLength(EXPECTED.length);
    for (const row of rows) {
      const amounts = amountsIn(textOf(row));
      const allZero = amounts.length > 0 && amounts.every((yuan) => /^-?0\.00$/.test(yuan));
      expect(allZero, `no zero-filled row: ${textOf(row)}`).toBe(false);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-LIST#6] 页码分页：切到第 2 页请求 page=2（同一 page_size），显示该页的快照日、不再显示第 1 页的',
  async () => {
    const server = createServer(dailySnapshots(205));
    await mount(server);
    await listed(DAY.latest);
    await settled(server);
    const reads = server.tableReads().length;
    const firstSize = Number(server.tableReads().at(-1)!.query['page_size'] ?? '20');
    await nextPageNear(dayRow(DAY.latest));
    const paged = () =>
      server
        .tableReads()
        .slice(reads)
        .filter((read) => read.query['page'] === '2');
    await waitFor(() => expect(paged().length).toBeGreaterThan(0));
    await settled(server);
    const second = paged().at(-1)!;
    expect(extraParams(second.query, LIST_PARAMS)).toEqual([]);
    const size = Number(second.query['page_size'] ?? '20');
    expect(size, 'page 2 keeps the page_size of page 1').toBe(firstSize);
    // One snapshot a day, descending from 2026-10-29: row index `size` opens page 2.
    const firstOfPage = dayBefore(DAY.latest, size);
    await waitFor(() => expect(dayRows(firstOfPage), firstOfPage).toHaveLength(1));
    expect(dayRows(DAY.latest)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-LIST#7] 只显示契约字段：表头没有企业支付宝余额、W、预计提现、P、水位 / 状态、当日联盟回款等画板列；每行出现的金额都能在该日快照的契约字段里找到，主区不出现夹具之外的金额',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(DAY.bare);
    await settled(server);
    const titles = columnTitles(dayRow(DAY.latest));
    for (const [name, pattern] of BOARD_ONLY_TITLES) {
      expect(
        titles.filter((title) => pattern.test(title)),
        `no column 「${name}」 among ${titles.join(' | ')}`,
      ).toEqual([]);
    }
    const everyAllowed = new Set(EXPECTED.flatMap((expected) => allowedAmounts(expected)));
    for (const expected of EXPECTED) {
      const row = dayRow(expected.day);
      const hint = rowHint(row);
      expect(hint, `${expected.day} shows no board-only value`).not.toMatch(BOARD_ONLY_WORDS);
      const allowed = new Set(allowedAmounts(expected));
      const foreign = amountsIn(textOf(row)).filter((yuan) => !allowed.has(yuan));
      expect(foreign, `${expected.day} amounts not in its snapshot`).toEqual([]);
    }
    // Nothing outside the rows (a summary row, a card) shows an amount the snapshots do not hold.
    const outside = amountsIn(textOf(main())).filter((yuan) => !everyAllowed.has(yuan));
    expect(outside, 'amounts on the page not in the snapshots').toEqual([]);
  },
  FLOW_TIMEOUT,
);
