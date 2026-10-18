import { buildVouchers, type BuildVoucherParams } from '@couli/domain';
import { expect, it } from 'vitest';
import {
  csvGroups,
  executableTemplates,
  isTbd,
  parameters,
  readTemplates,
  reversedGroups,
  validVouchers,
  voucherGroups,
} from './fixtures.ts';

it('[AC-B2-01j#1] 每个完整模板逐业务组匹配 CSV，分录无序但不得丢失或重复', () => {
  const templates = executableTemplates();
  // Explicit witness: the oracle must not silently reduce to an empty traversal.
  expect(templates.map(([id]) => id)).toEqual(['WITHDRAW:FREEZE', 'WITHDRAW:RETURN']);
  for (const [id, rows] of templates) {
    for (const amount of [1n, 617n, 9007199254740993n, 9223372036854775807n]) {
      const params = parameters(rows, amount);
      const vouchers = buildVouchers(id, params);
      expect(vouchers, id).toHaveLength(1);
      expect(voucherGroups(vouchers), id).toEqual(csvGroups(rows, params));
      expect(validVouchers(vouchers), id).toBe(true);
    }
  }
});

it('[AC-B2-01j#2] 任一格 TBD 拒绝整张模板，不能只记已知行或把 TBD 当 null', () => {
  const pending = [...readTemplates()].filter(([, rows]) => isTbd(rows));
  expect(pending.length).toBeGreaterThan(0);
  expect(pending.some(([id]) => id === 'CREDIT:SELF')).toBe(true);
  expect(pending.some(([id]) => id === 'WITHDRAW:SUCCESS:CASH_WECHAT')).toBe(true);
  for (const [id, rows] of pending) {
    for (const amount of [617n, 0n]) {
      const params = Object.freeze(parameters(rows, amount));
      expect(() => buildVouchers(id, params), id).toThrow(RangeError);
    }
  }
});

it('[AC-B2-01j#3] 缺金额、键占位值或用户归属参数均拒绝', () => {
  for (const [id, rows] of executableTemplates()) {
    const params = parameters(rows);
    expect(Object.keys(params).sort()).toEqual(['user_id', 'withdraw_fen', 'withdrawal_id']);
    for (const key of Object.keys(params)) {
      const missing = { ...params };
      delete missing[key];
      expect(() => buildVouchers(id, missing), `${id} missing ${key}`).toThrow(RangeError);
    }
  }
});

it('[AC-B2-01j#4] 多余金额、别名或无关上下文不能被默默忽略', () => {
  for (const [id, rows] of executableTemplates()) {
    for (const [key, value] of Object.entries({
      extra_fen: 1n,
      fee_fen: 1n,
      uid: 'user-42',
      platform: 'jd',
      role: 'self',
    })) {
      expect(() => buildVouchers(id, { ...parameters(rows), [key]: value }), key).toThrow(
        RangeError,
      );
    }
  }
});

it('[AC-B2-01j#5] 金额只接受非负 int64 bigint，拒绝负数、溢出与隐式转换', () => {
  for (const [id, rows] of executableTemplates()) {
    for (const invalid of [
      -1n,
      -9223372036854775808n,
      9223372036854775808n,
      '617',
      617,
      0.5,
      NaN,
      Infinity,
      null,
      undefined,
    ]) {
      const params = { ...parameters(rows), withdraw_fen: invalid };
      expect(() => buildVouchers(id, params as unknown as BuildVoucherParams)).toThrow(RangeError);
    }
  }
});

it('[AC-B2-01j#6] 零金额不产生零分录或空凭证，参数校验仍执行', () => {
  for (const [id, rows] of executableTemplates()) {
    const params = parameters(rows, 0n);
    expect(buildVouchers(id, params), id).toEqual([]);
    expect(() => buildVouchers(id, { ...params, unknown: 'x' })).toThrow(RangeError);
    const missing = { ...params };
    delete missing['withdrawal_id'];
    expect(() => buildVouchers(id, missing)).toThrow(RangeError);
  }
});

it('[AC-B2-01j#7] BR-WDR-09 冻结/退回方向及 wd 键固定，用户所有者不得串户', () => {
  for (const userId of ['42', '7']) {
    for (const withdrawalId of ['000123', 'wd-order-9']) {
      const params = { user_id: userId, withdrawal_id: withdrawalId, withdraw_fen: 3000n };
      const account = { owner_type: 'user', owner_id: userId, subject: 'USER_BALANCE' };
      const frozen = buildVouchers('WITHDRAW:FREEZE', params);
      const returned = buildVouchers('WITHDRAW:RETURN', params);
      for (const [vouchers, suffix, type, debitSub, creditSub] of [
        [frozen, 'FREEZE', 'WITHDRAW_FREEZE', 'available', 'frozen'],
        [returned, 'RETURN', 'WITHDRAW_RETURN', 'frozen', 'available'],
      ] as const) {
        expect(vouchers).toHaveLength(1);
        expect(vouchers[0]?.uniq_key).toBe(`wd:${withdrawalId}:${suffix}`);
        expect(vouchers[0]?.entries).toHaveLength(2);
        expect(vouchers[0]?.entries).toEqual(
          expect.arrayContaining([
            {
              account,
              sub_account: debitSub,
              amount_fen: 3000n,
              ledger_type: type,
              sub_type: null,
            },
            {
              account,
              sub_account: creditSub,
              amount_fen: -3000n,
              ledger_type: type,
              sub_type: null,
            },
          ]),
        );
      }
    }
  }
});

it('[AC-B2-01j#8] 相同输入结果相同且不修改冻结的参数或先前结果', () => {
  for (const [id, rows] of executableTemplates()) {
    const params = Object.freeze(parameters(rows, 9007199254740993n));
    const before = structuredClone(params);
    const first = buildVouchers(id, params);
    const saved = structuredClone(first);
    expect(buildVouchers(id, params)).toEqual(saved);
    buildVouchers(id, { ...params, user_id: 'another-user', withdraw_fen: 1n });
    expect(params).toEqual(before);
    expect(first).toEqual(saved);
  }
});

it('[AC-B2-01j#9] 未登记的模板与无分录的提现时点不得回落为默认模板', () => {
  for (const id of ['', 'unknown', 'WITHDRAW:EXECUTE', 'WITHDRAW:FREEZE:REVERSE', '__proto__']) {
    expect(
      () =>
        buildVouchers(id, {
          withdrawal_id: 'w1',
          user_id: 'u1',
          withdraw_fen: 100n,
        }),
      id,
    ).toThrow(RangeError);
  }
});

it('[AC-B2-01j#10] CSV 的每对红冲保持原类型与子类型、原键加 REVERSE、原金额反号；TBD 不执行', () => {
  const templates = readTemplates();
  const reversals = [...templates].filter(([id]) => id.endsWith(':REVERSE'));
  expect(reversals.length).toBeGreaterThan(0);
  for (const [reverseId, reverseRows] of reversals) {
    const originalId = reverseId.slice(0, -':REVERSE'.length);
    const originalRows = templates.get(originalId);
    expect(originalRows, reverseId).toBeDefined();
    if (originalRows === undefined) throw new Error(`Missing original: ${originalId}`);
    const params = parameters(originalRows, 9007199254740993n);
    // All REVERSE templates in this SPEC_REF have TBD platform subaccounts.
    // Do not invent executable templates just to manufacture a positive reversal case.
    if (isTbd(originalRows) || isTbd(reverseRows)) {
      expect(() => buildVouchers(originalId, params), originalId).toThrow(RangeError);
      expect(() => buildVouchers(reverseId, params), reverseId).toThrow(RangeError);
    } else {
      const original = buildVouchers(originalId, params);
      const reverse = buildVouchers(reverseId, params);
      expect(original).toHaveLength(1);
      expect(reverse).toHaveLength(1);
      expect(voucherGroups(reverse)).toEqual(csvGroups(reverseRows, params));
      expect(voucherGroups(reverse)).toEqual(reversedGroups(original));
      expect(validVouchers(reverse)).toBe(true);
    }
  }
});

it('[AC-B2-01j#11] 键组件拒绝空值、冒号和非字符串，不接受能碰撞的插值', () => {
  for (const [id, rows] of executableTemplates()) {
    for (const name of ['user_id', 'withdrawal_id']) {
      for (const value of ['', 'left:right', ':', 42n, null, undefined]) {
        expect(() =>
          buildVouchers(id, {
            ...parameters(rows),
            [name]: value,
          } as unknown as BuildVoucherParams),
        ).toThrow(RangeError);
      }
    }
  }
});
