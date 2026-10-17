import { applyEntries, type LedgerBalance, type LedgerEntry } from '@couli/domain';
import { expect, it } from 'vitest';
import { platformEntry, userEntry } from './fixtures.ts';

const initial: LedgerBalance = { account_id: 'user-42', available_fen: 1000n, frozen_fen: 0n };

it('[AC-B2-01h#10] BR-FUND-16：贷记617使1000变1617，不缓存平台或其他用户分录', () => {
  const entries = [platformEntry(700n), userEntry(-617n), userEntry(-83n, 'available', 'user-43')];
  const before = structuredClone(entries);
  entries.forEach(Object.freeze);
  expect(applyEntries(Object.freeze(initial), Object.freeze(entries))).toEqual({
    ...initial,
    available_fen: 1617n,
  });
  expect(entries).toEqual(before);
  expect(initial).toEqual({ account_id: 'user-42', available_fen: 1000n, frozen_fen: 0n });
});

it.each([1n, 617n, 2147483649n, 9007199254740993n])(
  '[AC-B2-01h#11] 冻结/解冻 %s 分分别推导两个子户并可全额解冻',
  (amount) => {
    const balance = { ...initial, available_fen: amount };
    const frozen = applyEntries(balance, [userEntry(amount), userEntry(-amount, 'frozen')]);
    expect(frozen).toEqual({ ...initial, available_fen: 0n, frozen_fen: amount });
    expect(applyEntries(frozen, [userEntry(amount, 'frozen'), userEntry(-amount)])).toEqual(
      balance,
    );
  },
);

it('[AC-B2-01h#12] 部分解冻只扣对应冻结额，已有冻结余额不丢失', () => {
  expect(
    applyEntries({ ...initial, frozen_fen: 700n }, [userEntry(123n, 'frozen'), userEntry(-123n)]),
  ).toEqual({ ...initial, available_fen: 1123n, frozen_fen: 577n });
});

it('[AC-B2-01h#13] BR-FUND-10：扣回可推导负可用且不动冻结，后续入账直接抵扣', () => {
  const balance = { ...initial, available_fen: 0n, frozen_fen: 400n };
  const clawed = applyEntries(balance, [userEntry(400n)]);
  expect(clawed).toEqual({ ...balance, available_fen: -400n });
  expect(applyEntries(clawed, [userEntry(-600n)])).toEqual({ ...balance, available_fen: 200n });
});

it('[AC-B2-01h#14] frozen 结果差一分即拒绝且输入不变', () => {
  const balance = Object.freeze({ ...initial, frozen_fen: 617n });
  expect(() => applyEntries(balance, [userEntry(618n, 'frozen')])).toThrow(RangeError);
  expect(balance.frozen_fen).toBe(617n);
});

it('[AC-B2-01h#15] 同一批子户净额为准，不因分录排列产生虚假负冻结', () => {
  const entries = [userEntry(617n, 'frozen'), userEntry(-617n, 'frozen')];
  expect(applyEntries(initial, entries)).toEqual(initial);
  expect(applyEntries(initial, [...entries].reverse())).toEqual(initial);
});

it('[AC-B2-01h#16] 空分录切片返回等值新余额', () => {
  const result = applyEntries(initial, []);
  expect(result).toEqual(initial);
  expect(result).not.toBe(initial);
});

it.each([{ available_fen: 1000 }, { frozen_fen: '0' }, { frozen_fen: -1n }, { account_id: '' }])(
  '[AC-B2-01h#17] 非法初始余额拒绝：%#',
  (overrides) => {
    const balance = { ...initial, ...overrides };
    expect(() => applyEntries(balance as LedgerBalance, [])).toThrow(RangeError);
  },
);

it.each([{ amount_fen: 1 }, { amount_fen: 0n }, { sub_account: null }, { sub_account: 'other' }])(
  '[AC-B2-01h#18] 非法目标账户分录不静默跳过：%#',
  (overrides) => {
    const entry = { ...userEntry(1n), ...overrides };
    expect(() => applyEntries(initial, [entry as LedgerEntry])).toThrow(RangeError);
  },
);
