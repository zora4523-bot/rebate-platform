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
  // Keep the traversal data-driven, with witnesses for the newly completed families.
  expect(templates.map(([id]) => id)).toEqual(
    expect.arrayContaining([
      'WITHDRAW:FREEZE',
      'WITHDRAW:RETURN',
      'CREDIT:SELF',
      'CREDIT:PLATFORM',
      'ADJ:DEFERRED:RESTORE',
      'FORFEIT:DEFERRED',
      'UNION_RECEIPT:CASH_ALIPAY',
      'REASSIGN_REV:USER',
      'REASSIGN_REV:PLATFORM',
    ]),
  );
  for (const [id, rows] of templates) {
    for (const amountRef of new Set(rows.map((row) => row.amount_ref))) {
      for (const amount of [1n, 617n, 9007199254740993n, 9223372036854775807n]) {
        // Exercise every pair up to int64 max without overflowing a multi-pair voucher total.
        const params = { ...parameters(rows, 0n), [amountRef]: amount };
        expect(() => buildVouchers(id, params), id).not.toThrow();
        const vouchers = buildVouchers(id, params);
        expect(vouchers, id).toHaveLength(1);
        expect(voucherGroups(vouchers), id).toEqual(csvGroups(rows, params));
        expect(validVouchers(vouchers), id).toBe(true);
      }
    }
  }
});

it('[AC-B2-01j#2] [AC-B2-16a#11] invite 出平衡凭证，TBD 与新人签到奖励仍拒绝', () => {
  const templates = readTemplates();
  const pending = [...readTemplates()].filter(([, rows]) => isTbd(rows));
  for (const id of [
    'CREDIT:SELF',
    'WITHDRAW:SUCCESS:CASH_ALIPAY',
    'WITHDRAW:SUCCESS:CASH_BANK',
    'WITHDRAW:SUCCESS:CASH_WECHAT',
    'REWARD:INVITE',
  ]) {
    const rows = templates.get(id);
    expect(rows, id).toBeDefined();
    expect(isTbd(rows!), id).toBe(false);
    const params = parameters(rows!);
    expect(() => buildVouchers(id, params), id).not.toThrow();
    const vouchers = buildVouchers(id, params);
    expect(vouchers, id).toHaveLength(1);
    expect(voucherGroups(vouchers), id).toEqual(csvGroups(rows!, params));
    expect(validVouchers(vouchers), id).toBe(true);
    if (id.startsWith('WITHDRAW:SUCCESS:')) {
      expect(vouchers[0]?.uniq_key, id).toBe(`wd:${params['withdrawal_id']}:PAID`);
    }
  }
  for (const id of [
    'REWARD:newbie',
    'REWARD:checkin',
    'REWARD:invite',
    'REWARD:NEWBIE',
    'REWARD:CHECKIN',
  ]) {
    expect(templates.has(id), id).toBe(false);
    expect(() => buildVouchers(id, {}), id).toThrow(RangeError);
  }
  for (const [id, rows] of pending) {
    for (const amount of [617n, 0n]) {
      const params = Object.freeze(parameters(rows, amount));
      expect(() => buildVouchers(id, params), id).toThrow(RangeError);
    }
  }
});

it('[AC-B2-01j#3] 缺金额、键占位值或用户归属参数均拒绝', () => {
  const credit = readTemplates().get('CREDIT:SELF')!;
  expect(() => buildVouchers('CREDIT:SELF', parameters(credit))).not.toThrow();
  for (const [id, rows] of executableTemplates()) {
    const params = parameters(rows);
    const required = new Set(
      rows.flatMap((row) => [
        row.amount_ref,
        ...[row.uniq_key_pattern, row.subject].flatMap((cell) =>
          [...cell.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!),
        ),
        ...(row.account_owner === 'user' ? ['user_id'] : []),
      ]),
    );
    expect(Object.keys(params).sort(), id).toEqual([...required].sort());
    expect(() => buildVouchers(id, params), id).not.toThrow();
    for (const key of Object.keys(params)) {
      const missing = { ...params };
      delete missing[key];
      expect(() => buildVouchers(id, missing), `${id} missing ${key}`).toThrow(RangeError);
    }
  }
});

it('[AC-B2-01j#4] 多余金额、别名或无关上下文不能被默默忽略', () => {
  const templates = executableTemplates();
  expect(templates.map(([id]) => id)).toEqual(
    expect.arrayContaining(['CREDIT:SELF', 'CREDIT:PLATFORM', 'WITHDRAW:SUCCESS:CASH_WECHAT']),
  );
  for (const [id, rows] of templates) {
    const params = parameters(rows);
    for (const [key, value] of Object.entries({
      extra_fen: 1n,
      fee_fen: 1n,
      uid: 'user-42',
      platform: 'jd',
      role: 'self',
    })) {
      if (Object.hasOwn(params, key)) continue;
      expect(() => buildVouchers(id, { ...params, [key]: value }), `${id} extra ${key}`).toThrow(
        RangeError,
      );
    }
  }
});

it('[AC-B2-01j#5] 金额只接受非负 int64 bigint，拒绝负数、溢出与隐式转换', () => {
  const templates = executableTemplates();
  expect(templates.map(([id]) => id)).toEqual(
    expect.arrayContaining(['CREDIT:SELF', 'CREDIT:PLATFORM', 'WITHDRAW:SUCCESS:CASH_WECHAT']),
  );
  for (const [id, rows] of templates) {
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
      for (const amountRef of new Set(rows.map((row) => row.amount_ref))) {
        const params = { ...parameters(rows), [amountRef]: invalid };
        expect(
          () => buildVouchers(id, params as unknown as BuildVoucherParams),
          `${id} invalid ${amountRef}`,
        ).toThrow(RangeError);
      }
    }
  }
});

it('[AC-B2-01j#6] 零金额不产生零分录或空凭证，参数校验仍执行', () => {
  expect(readTemplates().has('REWARD:INVITE')).toBe(true);
  const templates = executableTemplates();
  expect(templates.map(([id]) => id)).toEqual(
    expect.arrayContaining(['CREDIT:SELF', 'CREDIT:PLATFORM', 'WITHDRAW:SUCCESS:CASH_WECHAT']),
  );
  for (const [id, rows] of templates) {
    const params = parameters(rows, 0n);
    // BR-INV-24 / B2-16a: a payout requires a strictly positive locked reward.
    if (id === 'REWARD:INVITE') {
      expect(buildVouchers(id, params), id).toEqual([]);
    } else {
      expect(buildVouchers(id, params), id).toEqual([]);
    }
    expect(() => buildVouchers(id, { ...params, unknown: 'x' })).toThrow(RangeError);
    for (const key of Object.keys(params)) {
      const missing = { ...params };
      delete missing[key];
      expect(() => buildVouchers(id, missing), `${id} missing ${key} at zero`).toThrow(RangeError);
    }
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
  expect(readTemplates().has('REWARD:INVITE')).toBe(true);
  const templates = executableTemplates();
  expect(templates.map(([id]) => id)).toEqual(
    expect.arrayContaining(['CREDIT:SELF', 'CREDIT:PLATFORM', 'WITHDRAW:SUCCESS:CASH_WECHAT']),
  );
  for (const [id, rows] of templates) {
    const params = Object.freeze(parameters(rows, 9007199254740993n));
    const before = structuredClone(params);
    const first = buildVouchers(id, params);
    const saved = structuredClone(first);
    expect(buildVouchers(id, params)).toEqual(saved);
    const changed = { ...parameters(rows, 1n) };
    for (const key of Object.keys(changed)) {
      if (typeof changed[key] !== 'string') continue;
      if (key === 'order_key') changed[key] = 'jd:another-order';
      else if (key === 'platform') changed[key] = 'jd';
      else if (key === 'side') changed[key] = 'invitee';
      else if (key !== 'role') changed[key] = 'another-value';
    }
    expect(() => buildVouchers(id, changed), id).not.toThrow();
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

it('[AC-B2-01j#10] 已定的每对红冲实际执行，保持原类型与子类型、原键加 REVERSE、原金额反号', () => {
  const templates = readTemplates();
  const reversals = [...templates].filter(([id]) => id.endsWith(':REVERSE'));
  expect(reversals.length).toBeGreaterThan(0);
  for (const [reverseId, reverseRows] of reversals) {
    const originalId = reverseId.slice(0, -':REVERSE'.length);
    const originalRows = templates.get(originalId);
    expect(originalRows, reverseId).toBeDefined();
    if (originalRows === undefined) throw new Error(`Missing original: ${originalId}`);
    const params = parameters(originalRows, 9007199254740993n);
    expect(isTbd(originalRows), originalId).toBe(false);
    expect(isTbd(reverseRows), reverseId).toBe(false);
    expect(() => buildVouchers(originalId, params), originalId).not.toThrow();
    expect(() => buildVouchers(reverseId, params), reverseId).not.toThrow();
    const original = buildVouchers(originalId, params);
    const reverse = buildVouchers(reverseId, params);
    expect(original).toHaveLength(1);
    expect(reverse).toHaveLength(1);
    expect(voucherGroups(reverse)).toEqual(csvGroups(reverseRows, params));
    expect(voucherGroups(reverse)).toEqual(reversedGroups(original));
    expect(validVouchers(reverse)).toBe(true);
  }
});

it('[AC-B2-01j#11] 键组件拒绝空值、冒号和非字符串，不接受能碰撞的插值', () => {
  const credit = readTemplates().get('CREDIT:SELF')!;
  expect(() => buildVouchers('CREDIT:SELF', parameters(credit))).not.toThrow();
  for (const [id, rows] of executableTemplates()) {
    const params = parameters(rows);
    expect(() => buildVouchers(id, params), id).not.toThrow();
    for (const name of Object.keys(params).filter((key) => typeof params[key] === 'string')) {
      for (const value of [
        '',
        name === 'order_key' ? 'taobao:123:collision' : 'left:right',
        ':',
        42n,
        null,
        undefined,
      ]) {
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
