// B2-11d BR-WDR-30 保存时校验 (规划/08 BR-WDR-30 一览「保存配置时另校验」, 细则表「校验」行、③ 行与
// ⑫): autoPayoutSaveRefusals over the configuration as it would be after the save (an absent key
// takes its 08 default) refuses withdraw.auto_payout.max_amount_fen > withdraw.max_amount_fen,
// window_end not later than window_start, platform_daily_max_fen > payout.daily_cap_fen, and a
// risk_block_flags that is not a list of BR-WDR-29 label codes; refused keys come in the order
// ② ③ ⑨ ⑫. Boundaries are equalities (≤ passes) and same-hour windows (HH:00:00–HH:59:59).
import { expect, it } from 'vitest';
import { autoPayoutSaveRefusals } from '../../../../apps/api/src/modules/payout/domain/auto-config.ts';
import {
  BLOCK_FLAGS,
  DAILY_CAP,
  DEFAULT_BLOCK_FLAGS,
  LABEL_CODES,
  MAX,
  PLATFORM_MAX,
  WINDOW_END,
  WINDOW_START,
  WITHDRAW_MAX,
  savedDefaults,
  windowHours,
} from './kit.ts';

function refusals(entries: ReadonlyArray<readonly [string, unknown]>, base = savedDefaults()) {
  const values = new Map(base);
  for (const [key, value] of entries) values.set(key, value);
  return autoPayoutSaveRefusals(values);
}

it('[AC-B2-11d#1] 08 默认值互相满足：写全默认值或一个键都没有，都可以保存', () => {
  expect(refusals([])).toStrictEqual([]);
  expect(autoPayoutSaveRefusals(new Map())).toStrictEqual([]);
});

it.each([
  { max: 500000, withdrawMax: undefined, refused: false },
  { max: 500001, withdrawMax: undefined, refused: true },
  { max: 1000000, withdrawMax: undefined, refused: true },
  { max: 20000, withdrawMax: 20000, refused: false },
  { max: 20001, withdrawMax: 20000, refused: true },
  { max: 30000, withdrawMax: 29999, refused: true },
  { max: 0, withdrawMax: 100, refused: false },
])(
  '[AC-B2-11d#2] ② max_amount_fen=$max、withdraw.max_amount_fen=$withdrawMax（缺省 500000）→ 拒绝=$refused（等号可存）',
  ({ max, withdrawMax, refused }) => {
    const base = savedDefaults();
    if (withdrawMax === undefined) base.delete(WITHDRAW_MAX);
    const values: Array<[string, unknown]> = [[MAX, max]];
    if (withdrawMax !== undefined) values.push([WITHDRAW_MAX, withdrawMax]);
    expect(refusals(values, base)).toStrictEqual(refused ? [MAX] : []);
  },
);

it.each([
  { platform: 5000000, cap: undefined, refused: false },
  { platform: 5000001, cap: undefined, refused: true },
  { platform: 100000, cap: 100000, refused: false },
  { platform: 200000, cap: 199999, refused: true },
  { platform: 0, cap: 1, refused: false },
])(
  '[AC-B2-11d#3] ⑨ platform_daily_max_fen=$platform、payout.daily_cap_fen=$cap（缺省 5000000）→ 拒绝=$refused（等号可存）',
  ({ platform, cap, refused }) => {
    const base = savedDefaults();
    if (cap === undefined) base.delete(DAILY_CAP);
    const values: Array<[string, unknown]> = [[PLATFORM_MAX, platform]];
    if (cap !== undefined) values.push([DAILY_CAP, cap]);
    expect(refusals(values, base)).toStrictEqual(refused ? [PLATFORM_MAX] : []);
  },
);

it('[AC-B2-11d#4] ③ window_end > window_start：14 × 14 种取值中，结束时段早于开始时段的拒绝，同一小时与更晚的可存', () => {
  const starts = windowHours(':00:00');
  const ends = windowHours(':59:59');
  for (const [i, start] of starts.entries()) {
    for (const [j, end] of ends.entries()) {
      const expected = j < i ? [WINDOW_END] : [];
      expect(
        refusals([
          [WINDOW_START, start],
          [WINDOW_END, end],
        ]),
        `${start}–${end}`,
      ).toStrictEqual(expected);
    }
  }
});

it('[AC-B2-11d#5] ③ 只改一端时与另一端的现值（或默认值 09:00:00 / 22:59:59）比较', () => {
  const noWindow = savedDefaults();
  noWindow.delete(WINDOW_START);
  noWindow.delete(WINDOW_END);
  expect(refusals([[WINDOW_START, '22:00:00']], noWindow)).toStrictEqual([]);
  expect(refusals([[WINDOW_END, '09:59:59']], noWindow)).toStrictEqual([]);
  const evening = new Map(savedDefaults()).set(WINDOW_START, '18:00:00');
  expect(refusals([[WINDOW_END, '17:59:59']], evening)).toStrictEqual([WINDOW_END]);
  expect(refusals([[WINDOW_END, '18:59:59']], evening)).toStrictEqual([]);
  const morning = new Map(savedDefaults()).set(WINDOW_END, '10:59:59');
  expect(refusals([[WINDOW_START, '11:00:00']], morning)).toStrictEqual([WINDOW_END]);
  expect(refusals([[WINDOW_START, '10:00:00']], morning)).toStrictEqual([]);
});

it.each([
  { flags: [...DEFAULT_BLOCK_FLAGS] },
  { flags: [] },
  { flags: [...LABEL_CODES] },
  ...LABEL_CODES.map((code) => ({ flags: [code] })),
])('[AC-B2-11d#6] ⑫ risk_block_flags=$flags 都是 BR-WDR-29 标签 code → 可存', ({ flags }) => {
  expect(refusals([[BLOCK_FLAGS, flags]])).toStrictEqual([]);
});

it.each([
  { flags: ['had_negative', 'blacklist'] },
  { flags: ['risk_flag:had_negative'] },
  { flags: ['HAD_NEGATIVE'] },
  { flags: [' had_negative'] },
  { flags: [''] },
  { flags: ['frozen_balance'] },
  { flags: ['had_negative', 1] },
  { flags: [null] },
  { flags: { had_negative: true } },
  { flags: 'had_negative' },
  { flags: null },
])('[AC-B2-11d#7] ⑫ risk_block_flags=$flags 含非标签 code 或不是 code 列表 → 拒绝', ({ flags }) => {
  expect(refusals([[BLOCK_FLAGS, flags]])).toStrictEqual([BLOCK_FLAGS]);
});

it('[AC-B2-11d#8] 多项同时不满足：全部列出，顺序 ② ③ ⑨ ⑫，与 Map 写入顺序无关', () => {
  const values = new Map<string, unknown>([
    [BLOCK_FLAGS, ['not_a_label']],
    [DAILY_CAP, 1000],
    [PLATFORM_MAX, 1001],
    [WINDOW_END, '09:59:59'],
    [WINDOW_START, '10:00:00'],
    [WITHDRAW_MAX, 100],
    [MAX, 101],
  ]);
  expect(autoPayoutSaveRefusals(values)).toStrictEqual([
    MAX,
    WINDOW_END,
    PLATFORM_MAX,
    BLOCK_FLAGS,
  ]);
});

it('[AC-B2-11d#9] 其余自动到账键与比较无关：改次数、预警阈值、开关不影响结果', () => {
  expect(
    refusals([
      ['withdraw.auto_payout.payee_daily_max_count', 0],
      ['withdraw.auto_payout.user_monthly_max_count', 99],
      ['withdraw.auto_payout.warn.withdraw_received_ratio_bp', 10000],
      ['withdraw.auto_payout.window_limit_enabled', true],
      ['withdraw.auto_payout.first_withdrawal_limit_enabled', true],
    ]),
  ).toStrictEqual([]);
  expect(
    refusals([
      [MAX, 500001],
      ['withdraw.auto_payout.payee_daily_max_count', 0],
    ]),
  ).toStrictEqual([MAX]);
});

it('[AC-B2-11d#10] 校验不改调用方传入的值', () => {
  const values = savedDefaults();
  const flags = ['had_negative'];
  values.set(BLOCK_FLAGS, flags);
  values.set(MAX, 500001);
  const before = [...values.entries()];
  autoPayoutSaveRefusals(values);
  expect([...values.entries()]).toStrictEqual(before);
  expect(flags).toStrictEqual(['had_negative']);
});
