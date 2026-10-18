import { buildVouchers, type BuildVoucherParams, type BuiltVoucher } from '@couli/domain';
import { expect, it } from 'vitest';
import { executableTemplates, parameters } from './fixtures.ts';

// Independent examples from SPEC_REF 8c91f67, task §2b and §9–11; no generated table imports.
const order = { order_key: 'taobao:1234567', platform: 'taobao' };
const beneficiary = { ...order, user_id: 'u42', role: 'self' };
const union = 'UNION_RECEIVABLE:taobao';
const roles = [
  ['SELF', 'self', 'REBATE_CREDIT', null],
  ['SHARE', 'share', 'SHARE_CREDIT', null],
  ['DIRECT', 'direct', 'REFERRAL_CREDIT', 'DIRECT'],
  ['INDIRECT', 'indirect', 'REFERRAL_CREDIT', 'INDIRECT'],
] as const;

function build(id: string, params: BuildVoucherParams): readonly BuiltVoucher[] {
  // An uncompleted template must fail an assertion, not escape as a runtime RangeError.
  let result: readonly BuiltVoucher[] = [];
  expect(() => {
    result = buildVouchers(id, params);
  }, id).not.toThrow();
  return result;
}

function entry(
  subject: string,
  amount: bigint,
  type: string,
  sub: string | null = null,
  userId = 'u42',
  subAccount: 'available' | 'frozen' = 'available',
) {
  return {
    account: {
      owner_type: subject === 'USER_BALANCE' ? 'user' : 'platform',
      owner_id: subject === 'USER_BALANCE' ? userId : 'platform',
      subject,
    },
    sub_account: subject === 'USER_BALANCE' ? subAccount : null,
    amount_fen: amount,
    ledger_type: type,
    sub_type: sub,
  };
}

function voucher(
  actual: readonly BuiltVoucher[],
  key: string,
  entries: ReturnType<typeof entry>[],
): void {
  expect(actual).toHaveLength(1);
  expect(actual[0]?.uniq_key).toBe(key);
  expect(actual[0]?.entries).toHaveLength(entries.length);
  expect(actual[0]?.entries).toEqual(expect.arrayContaining(entries));
  expect(actual[0]?.entries.reduce((sum, row) => sum + row.amount_fen, 0n)).toBe(0n);
}

it('[AC-B2-01l#1] 四角色入账及含预留的平台入账按独立期望出分录，平台输出子户为 null', () => {
  for (const [id, role, type, sub] of roles) {
    voucher(
      build(`CREDIT:${id}`, { ...beneficiary, role, share_fen: 617n }),
      `taobao:1234567:u42:${role}:CREDIT`,
      [entry(union, 617n, type, sub), entry('USER_BALANCE', -617n, type, sub)],
    );
  }
  // B_credit=0 may still leave 1 fen of reserve: platform amount must not disappear.
  voucher(
    build('CREDIT:PLATFORM', { ...order, platform_credit_fen: 1n }),
    'taobao:1234567:PLATFORM:CREDIT',
    [entry(union, 1n, 'REBATE_CREDIT'), entry('COMMISSION_REVENUE', -1n, 'REBATE_CREDIT')],
  );
  expect(build('CREDIT:PLATFORM', { ...order, platform_credit_fen: 0n })).toEqual([]);
});

it('[AC-B2-01l#2] 扣回与补差的平台差额共十四种沿用本次类型与子类型，两种方向均正确', () => {
  for (const [type, subtypes, amountName, event, key] of [
    [
      'CLAWBACK',
      ['FULL', 'PART_REFUND', 'RIGHTS', 'PUNISH'],
      'clawback_fen',
      { rights_event_id: 'R42' },
      'CLAWBACK:R42',
    ],
    [
      'SETTLE_ADJUST',
      ['SETTLE_DIFF', 'PRICE_PROTECT', 'PRICE_COMPARE'],
      'adjust_fen',
      { seq: '17' },
      'ADJ:17',
    ],
  ] as const) {
    for (const sub of subtypes) {
      for (const direction of ['INCREASE', 'DECREASE']) {
        const increase = direction === 'INCREASE';
        const id = `${type}:${sub}:PLATFORM:${direction}`;
        const params = { ...order, ...event, [amountName]: 309n };
        voucher(build(id, params), `taobao:1234567:PLATFORM:${key}`, [
          entry(union, increase ? 309n : -309n, type, sub),
          entry('COMMISSION_REVENUE', increase ? -309n : 309n, type, sub),
        ]);
        expect(build(id, { ...params, [amountName]: 0n })).toEqual([]);
      }
    }
  }
});

it('[AC-B2-01l#3] 三类没收均用平台占位类型，延后没收只用待补记额与义务键', () => {
  for (const [id, suffix, extra] of [
    ['FORFEIT', '', { share_fen: 123n }],
    ['FORFEIT:REASSIGN', ':REASSIGN:a2', { share_fen: 123n, reassign_id: 'a2' }],
    ['FORFEIT:DEFERRED', ':DEFERRED:b7', { pending_credit_fen: 123n, beneficiary_credit_id: 'b7' }],
  ] as const) {
    voucher(
      build(id, { ...order, uid: 'u42', role: 'direct', ...extra }),
      `taobao:1234567:PLATFORM:FORFEIT:u42:direct${suffix}`,
      [entry(union, 123n, 'REBATE_CREDIT'), entry('COMMISSION_REVENUE', -123n, 'REBATE_CREDIT')],
    );
  }
});

it('[AC-B2-01l#4] 延后补记四模板保留开立类型，义务 id 隔离且零金额不写', () => {
  for (const sub of ['SETTLE_DIFF', 'PRICE_PROTECT', 'PRICE_COMPARE', 'RESTORE']) {
    const type = sub === 'RESTORE' ? 'ADMIN_ADJUST' : 'SETTLE_ADJUST';
    for (const obligation of ['b7', 'b8']) {
      const params = { ...beneficiary, beneficiary_credit_id: obligation, pending_credit_fen: 37n };
      voucher(
        build(`ADJ:DEFERRED:${sub}`, params),
        `taobao:1234567:u42:self:ADJ:DEFERRED:${obligation}`,
        [entry(union, 37n, type, sub), entry('USER_BALANCE', -37n, type, sub)],
      );
      expect(build(`ADJ:DEFERRED:${sub}`, { ...params, pending_credit_fen: 0n })).toEqual([]);
    }
  }
});

it('[AC-B2-01l#5] 提现成功三通道只写一张 PAID 凭证，净额手续费税逐分录匹配且零金额省略', () => {
  for (const cash of ['CASH_ALIPAY', 'CASH_BANK', 'CASH_WECHAT']) {
    const id = `WITHDRAW:SUCCESS:${cash}`;
    for (const [net, fee, tax] of [
      [9700n, 100n, 200n],
      [10000n, 0n, 0n],
      [0n, 100n, 200n],
      [9700n, 0n, 200n],
      [9700n, 100n, 0n],
      [0n, 100n, 0n],
      [0n, 0n, 200n],
      [0n, 0n, 0n],
    ] as const) {
      const params = {
        withdrawal_id: 'w7',
        user_id: 'u42',
        net_fen: net,
        fee_fen: fee,
        tax_fen: tax,
      };
      const expected = [
        [net, 'WITHDRAW_PAID', cash],
        [fee, 'WITHDRAW_FEE', 'FEE_INCOME'],
        [tax, 'TAX_WITHHOLD', 'TAX_PAYABLE'],
      ] as const;
      const entries = expected.flatMap(([amount, type, subject]) =>
        amount === 0n
          ? []
          : [
              entry('USER_BALANCE', amount, type, null, 'u42', 'frozen'),
              entry(subject, -amount, type),
            ],
      );
      const actual = build(id, params);
      if (entries.length === 0) expect(actual, id).toEqual([]);
      else voucher(actual, 'wd:w7:PAID', entries);
    }
  }
});

it('[AC-B2-01l#11] 订单平台与应收科目平台必须一致，不得把京东订单记入淘宝应收', () => {
  const templates = executableTemplates().filter(([, rows]) => {
    const params = parameters(rows);
    return Object.hasOwn(params, 'order_key') && Object.hasOwn(params, 'platform');
  });
  expect(templates.map(([id]) => id)).toEqual(
    expect.arrayContaining([
      'CREDIT:SELF',
      'CREDIT:PLATFORM',
      'FORFEIT',
      'ADJ:DEFERRED:SETTLE_DIFF',
    ]),
  );
  for (const [id, rows] of templates) {
    const params = parameters(rows);
    // First prove the template is executable; rejection must not just be a TBD rejection.
    expect(build(id, params)).toHaveLength(1);
    expect(() => buildVouchers(id, { ...params, order_key: 'jd:1234567' }), id).toThrow(RangeError);
  }
});

it('[AC-B2-01l#6] 联盟回款用实际到账额与平台加回款 id 的键，不能混用佣金金额参数', () => {
  for (const cash of ['CASH_ALIPAY', 'CASH_BANK']) {
    for (const platform of ['taobao', 'jd']) {
      const id = `UNION_RECEIPT:${cash}`;
      const params = { platform, receipt_id: 'r7', receipt_fen: 9007199254740993n };
      voucher(build(id, params), `RECEIPT:${platform}:r7`, [
        entry(cash, 9007199254740993n, 'REBATE_CREDIT'),
        entry(`UNION_RECEIVABLE:${platform}`, -9007199254740993n, 'REBATE_CREDIT'),
      ]);
      expect(build(id, { ...params, receipt_fen: 0n })).toEqual([]);
      expect(() => buildVouchers(id, { platform, receipt_id: 'r7', n_fen: 617n })).toThrow(
        RangeError,
      );
    }
  }
});

it('[AC-B2-01l#7] RECON_FIX 与 OTHER 共三十二种白名单调账及红冲只影响 available', () => {
  for (const sub of ['RECON_FIX', 'OTHER']) {
    for (const subject of ['COMMISSION_REVENUE', 'UNION_RECEIVABLE', 'BAD_DEBT', 'MKT_EXPENSE']) {
      for (const direction of ['INCREASE', 'DECREASE']) {
        const id = `ADMIN_ADJUST:${sub}:${subject}:${direction}`;
        const params = {
          adjust_id: 'a7',
          user_id: 'u42',
          admin_adjust_fen: 617n,
          ...(subject === 'UNION_RECEIVABLE' ? { platform: 'taobao' } : {}),
        };
        const account = subject === 'UNION_RECEIVABLE' ? union : subject;
        for (const reverse of [false, true]) {
          const amount = (direction === 'INCREASE') !== reverse ? 617n : -617n;
          voucher(
            build(`${id}${reverse ? ':REVERSE' : ''}`, params),
            `ADJ:a7${reverse ? ':REVERSE' : ''}`,
            [
              entry(account, amount, 'ADMIN_ADJUST', sub),
              entry('USER_BALANCE', -amount, 'ADMIN_ADJUST', sub),
            ],
          );
        }
      }
    }
  }
});

it('[AC-B2-01l#8] 改派重记按四角色加平台拆分，带改派 id 且平台金额含预留', () => {
  for (const [id, role, type, sub] of roles) {
    voucher(
      build(`REASSIGN_CREDIT:${id}`, {
        ...beneficiary,
        role,
        reassign_id: 'a2',
        reassign_fen: 400n,
      }),
      `taobao:1234567:u42:${role}:REASSIGN_CREDIT:a2`,
      [entry(union, 400n, type, sub), entry('USER_BALANCE', -400n, type, sub)],
    );
  }
  voucher(
    build('REASSIGN_CREDIT:PLATFORM', { ...order, reassign_id: 'a2', platform_credit_fen: 600n }),
    'taobao:1234567:PLATFORM:REASSIGN_CREDIT:a2',
    [entry(union, 600n, 'REBATE_CREDIT'), entry('COMMISSION_REVENUE', -600n, 'REBATE_CREDIT')],
  );
});

it('[AC-B2-01l#9] 改派红冲按原类型分组，净额零仍写非零组，全部组零才不写且无注销坏账模板', () => {
  const adjustments = [
    ...['FULL', 'PART_REFUND', 'RIGHTS', 'PUNISH'].map((sub) => ['CLAWBACK', sub]),
    ...['SETTLE_DIFF', 'PRICE_PROTECT', 'PRICE_COMPARE'].map((sub) => ['SETTLE_ADJUST', sub]),
    ['ADMIN_ADJUST', 'RESTORE'],
  ];
  for (const target of ['USER', 'PLATFORM']) {
    const groups =
      target === 'USER'
        ? roles.map(([, , type, sub]) => [type, sub ?? '']).concat(adjustments)
        : [['REBATE_CREDIT', ''], ...adjustments];
    const params: Record<string, string | bigint> = {
      ...(target === 'USER' ? beneficiary : order),
      reassign_id: 'a2',
    };
    for (const [type, sub] of groups) {
      for (const sign of ['debit', 'credit']) {
        params[`reassign_${type!.toLowerCase()}${sub ? `_${sub.toLowerCase()}` : ''}_${sign}_fen`] =
          0n;
      }
    }
    const id = `REASSIGN_REV:${target}`;
    const subject = target === 'USER' ? 'USER_BALANCE' : 'COMMISSION_REVENUE';
    const key = `taobao:1234567:${target === 'USER' ? 'u42:self' : 'PLATFORM'}:REASSIGN_REV:a2`;
    // Original credit 500, later clawback 100: reverse both types, never credit-type net 400.
    voucher(
      build(id, {
        ...params,
        reassign_rebate_credit_credit_fen: 500n,
        reassign_clawback_part_refund_debit_fen: 100n,
      }),
      key,
      [
        entry(subject, 500n, 'REBATE_CREDIT'),
        entry(union, -500n, 'REBATE_CREDIT'),
        entry(subject, -100n, 'CLAWBACK', 'PART_REFUND'),
        entry(union, 100n, 'CLAWBACK', 'PART_REFUND'),
      ],
    );
    // Overall net zero still has two nonzero type groups; both must survive.
    voucher(
      build(id, {
        ...params,
        reassign_rebate_credit_credit_fen: 100n,
        reassign_settle_adjust_settle_diff_debit_fen: 100n,
      }),
      key,
      [
        entry(subject, 100n, 'REBATE_CREDIT'),
        entry(union, -100n, 'REBATE_CREDIT'),
        entry(subject, -100n, 'SETTLE_ADJUST', 'SETTLE_DIFF'),
        entry(union, 100n, 'SETTLE_ADJUST', 'SETTLE_DIFF'),
      ],
    );
    expect(build(id, params)).toEqual([]);
    // No default BAD_DEBT alternative for the unresolved closed-beneficiary case.
    expect(() => buildVouchers('REASSIGN_REV:BAD_DEBT', params)).toThrow(RangeError);
  }
});
