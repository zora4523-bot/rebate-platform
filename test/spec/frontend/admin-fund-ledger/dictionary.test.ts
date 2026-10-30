// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import {
  DAY,
  UNNAMED_PLATFORM,
  createServer,
  dictNames,
  platformPattern,
  receivableOf,
  snapshots,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  NOT_A_VALUE,
  dayRow,
  listed,
  mount,
  receivableText,
  showsEitherSign,
  showsYuan,
  textOf,
} from './helpers.ts';

// The console dictionary without any key: platform names fall back to the names the console
// pages use, or to the code itself for a platform the console has no name for.
vi.mock('../../../../contracts/texts.admin.default.json', () => ({ default: { texts: {} } }));

it(
  '[AC-F1-08ga-DICT#1] 后台字典清空时各平台未回款仍与平台绑定（平台名或编码），没有名字的平台显示原编码（xianyu 43.21），不显示 undefined、空白或键路径',
  async () => {
    const rows = snapshots();
    const latest = rows[0]!;
    // 4321 fen for a platform code without any name (a platform added later; codes sort after taobao).
    latest.receivables = [...latest.receivables, receivableOf(UNNAMED_PLATFORM, 4321)];
    const server = createServer(rows);
    await mount(server);
    await listed(DAY.bare);
    expect(dictNames('taobao'), 'the dictionary is empty').toEqual([]);

    const row = dayRow(DAY.latest);
    const expected: Readonly<Record<string, string>> = {
      jd: '1510.05',
      pdd: '-23.00',
      taobao: '8640.12',
      [UNNAMED_PLATFORM]: '43.21',
    };
    const platforms = Object.keys(expected);
    for (const platform of platforms) {
      const others = platforms.filter((one) => one !== platform);
      const shown = receivableText(row, platform, others);
      expect(showsYuan(shown, expected[platform]!), `${platform} in「${shown}」`).toBe(true);
      for (const other of others)
        expect(showsEitherSign(shown, expected[other]!), `${platform} ≠ ${other}`).toBe(false);
    }
    // The unnamed platform shows its code as a whole word.
    expect(textOf(row)).toMatch(platformPattern(UNNAMED_PLATFORM));
    for (const day of [DAY.latest, DAY.late, DAY.older, DAY.bare])
      expect(textOf(dayRow(day)), `${day} no raw value`).not.toMatch(NOT_A_VALUE);
  },
  FLOW_TIMEOUT,
);
