// B2-11a: createWithdrawRiskFlags over stub facts and a stub ③ on a real PG transaction (task 9.3
// #3 / #4 / #6). Labels: hits only, BR order, [] when none; thresholds from risk.withdraw.* with the
// defaults when missing, malformed or unreadable; each item isolated in a savepoint, a failure adds
// risk_calc_failed and leaves the transaction usable.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { WithdrawRiskFlag } from '../../../../apps/api/src/modules/payout/domain/risk-flags.ts';
import type {
  WithdrawRiskFlags,
  WithdrawRiskSubject,
} from '../../../../apps/api/src/modules/payout/application/withdraw-risk-flags.ts';
import { TIMEOUT, close, open, type Harness } from '../apply/kit.ts';
import {
  FACT_METHODS,
  failingCall,
  failingStatement,
  mapConfig,
  riskService,
  stubFacts,
  stubJudge,
  subject,
  txid,
  type FactCall,
  type FactMethod,
  type Failure,
  type JudgeCall,
} from './kit.ts';
import { KEYS, LOUD, LOUD_FLAGS, QUIET, flag, loudFailing, type ThresholdName } from './oracle.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const MARKER = 'b2_11a.marker';

function failOne(method: FactMethod, failure: Failure): Partial<Record<FactMethod, Failure>> {
  const fail: Partial<Record<FactMethod, Failure>> = {};
  fail[method] = failure;
  return fail;
}

/** compute() on a fresh transaction; afterwards the transaction must still be usable and intact. */
async function computeIn(
  service: WithdrawRiskFlags,
  who: WithdrawRiskSubject,
  inspect?: (trx: Transaction<DB>) => Promise<void>,
): Promise<readonly WithdrawRiskFlag[]> {
  return h.db.transaction().execute(async (trx) => {
    await sql`SELECT set_config(${MARKER}, 'kept', true)`.execute(trx);
    const flags = await service.compute(trx, who);
    const { rows } = await sql<{
      marker: string | null;
    }>`SELECT current_setting(${MARKER}, true) AS marker`.execute(trx);
    expect(rows[0]!.marker, 'W1 transaction still usable and not rolled back').toBe('kept');
    if (inspect !== undefined) await inspect(trx);
    return flags;
  });
}

it('[AC-B2-11a#11] 全部未命中写空数组 []，不是 null', async () => {
  const service = riskService({ facts: stubFacts(QUIET), sameDevice: stubJudge(false) });
  expect(await computeIn(service, subject())).toEqual([]);
});

it('[AC-B2-11a#12] 全部命中：按 ①②③④⑤⑥⑦⑧⑩ 顺序，每项 {code, value, threshold}，默认阈值', async () => {
  const service = riskService({ facts: stubFacts(LOUD), sameDevice: stubJudge(true) });
  expect(await computeIn(service, subject())).toEqual(LOUD_FLAGS);
});

it('[AC-B2-11a#13] 每项事实与 ③ 都在同一事务内按申请主体读取；③ 的 ref 是提现单 id', async () => {
  const facts: FactCall[] = [];
  const judged: JudgeCall[] = [];
  const service = riskService({
    facts: stubFacts(LOUD, { calls: facts }),
    sameDevice: stubJudge(true, { calls: judged }),
  });
  const who = subject();
  let outer = '';
  await computeIn(service, who, async (trx) => {
    outer = await txid(trx);
  });
  expect(judged).toHaveLength(1);
  expect(judged[0]!.input).toEqual({
    app_id: who.appId,
    user_id: who.userId,
    ref: { type: 'withdrawal', id: who.withdrawalId },
  });
  expect(judged[0]!.txid).toBe(outer);
  expect(new Set(facts.map((call) => call.method))).toEqual(new Set(FACT_METHODS));
  for (const call of facts) expect(call.subject, call.method).toEqual(who);
});

it.each([
  { name: 'invalid_ratio_bp', value: 3999, code: 'invalid_ratio_60d', want: [4000, 3999] },
  { name: 'invalid_ratio_bp', value: 4000, code: 'invalid_ratio_60d', want: null },
  { name: 'invalid_min_count', value: 4, code: 'invalid_ratio_60d', want: [4000, 3000] },
  { name: 'invalid_min_count', value: 5, code: 'invalid_ratio_60d', want: null },
  {
    name: 'high_commission_rate_bp',
    value: 6000,
    code: 'high_commission_ratio_60d',
    want: [6000, 5000],
  },
  { name: 'high_commission_rate_bp', value: 6001, code: 'high_commission_ratio_60d', want: null },
  {
    name: 'high_commission_ratio_bp',
    value: 5999,
    code: 'high_commission_ratio_60d',
    want: [6000, 5999],
  },
  { name: 'high_commission_ratio_bp', value: 6000, code: 'high_commission_ratio_60d', want: null },
  { name: 'min_orders', value: 10, code: 'high_commission_ratio_60d', want: [6000, 5000] },
  { name: 'min_orders', value: 11, code: 'high_commission_ratio_60d', want: null },
  {
    name: 'withdraw_received_ratio_bp',
    value: 15624,
    code: 'withdraw_vs_received',
    want: [15625, 15624],
  },
  { name: 'withdraw_received_ratio_bp', value: 15625, code: 'withdraw_vs_received', want: null },
] as const)(
  '[AC-B2-11a#14] 配置 $name = $value 生效（$code）',
  async ({ name, value, code, want }) => {
    const config = mapConfig(new Map([[KEYS[name as ThresholdName], value]]));
    const service = riskService({ config, facts: stubFacts(LOUD), sameDevice: stubJudge(true) });
    const expected = LOUD_FLAGS.flatMap((entry) =>
      entry.code !== code ? [entry] : want === null ? [] : [flag(code, want[0], want[1])],
    );
    expect(await computeIn(service, subject())).toEqual(expected);
    expect(config.reads).toContain(KEYS[name as ThresholdName]);
  },
);

it.each([
  { label: '字符串', value: '4000' },
  { label: '负数', value: -1 },
  { label: '小数', value: 1.5 },
  { label: '非数字字符串', value: 'abc' },
  { label: 'null', value: null },
  { label: '布尔', value: true },
  { label: '对象', value: { bp: 4000 } },
])('[AC-B2-11a#15] 六个阈值都是$label时按默认值计算', async ({ value }) => {
  const values = new Map<string, unknown>(
    (Object.keys(KEYS) as ThresholdName[]).map((name): [string, unknown] => [KEYS[name], value]),
  );
  const service = riskService({
    config: mapConfig(values),
    facts: stubFacts(LOUD),
    sameDevice: stubJudge(true),
  });
  expect(await computeIn(service, subject())).toEqual(LOUD_FLAGS);
});

it('[AC-B2-11a#16] 阈值读取失败（语句报错）按默认值计算，申请事务不受影响', async () => {
  const config = mapConfig(new Map([[KEYS.invalid_ratio_bp, 3999]]), failingStatement);
  const service = riskService({ config, facts: stubFacts(LOUD), sameDevice: stubJudge(true) });
  expect(await computeIn(service, subject())).toEqual(LOUD_FLAGS);
});

const FAILS: readonly { method: FactMethod; codes: Parameters<typeof loudFailing> }[] = [
  { method: 'hasPaidWithdrawal', codes: ['first_withdrawal'] },
  { method: 'creditedToday', codes: ['credited_today'] },
  { method: 'selfOrders60d', codes: ['invalid_ratio_60d', 'high_commission_ratio_60d'] },
  { method: 'withdrawn30dFen', codes: ['withdraw_vs_received'] },
  { method: 'received60dFen', codes: ['withdraw_vs_received'] },
  { method: 'hadNegative', codes: ['had_negative'] },
  { method: 'reconDiff', codes: ['recon_diff'] },
  { method: 'payeePrevOtherUser', codes: ['payee_prev_other_user'] },
];

it.each(FAILS)(
  '[AC-B2-11a#17] $method 查询报错：该项不出标签、末尾 risk_calc_failed 列出 $codes，其余照算，事务可继续',
  async ({ method, codes }) => {
    const service = riskService({
      facts: stubFacts(LOUD, { fail: failOne(method, failingStatement) }),
      sameDevice: stubJudge(true),
    });
    expect(await computeIn(service, subject())).toEqual(loudFailing(...codes));
  },
);

it.each(FAILS)(
  '[AC-B2-11a#18] $method 超时（无语句的失败）同样只写 risk_calc_failed',
  async ({ method, codes }) => {
    const service = riskService({
      facts: stubFacts(LOUD, { fail: failOne(method, failingCall) }),
      sameDevice: stubJudge(true),
    });
    expect(await computeIn(service, subject())).toEqual(loudFailing(...codes));
  },
);

it.each([
  { label: '语句报错', failure: failingStatement },
  { label: '超时', failure: failingCall },
])(
  '[AC-B2-11a#19] ③ 端口调用失败（$label）：不出 same_device_multi_account，写 risk_calc_failed',
  async ({ failure }) => {
    const service = riskService({
      facts: stubFacts(LOUD),
      sameDevice: stubJudge(true, { fail: failure }),
    });
    expect(await computeIn(service, subject())).toEqual(loudFailing('same_device_multi_account'));
  },
);

it('[AC-B2-11a#20] 多项失败时 risk_calc_failed 按 BR 顺序列出全部失败项，只出现一次', async () => {
  const service = riskService({
    facts: stubFacts(LOUD, {
      fail: {
        payeePrevOtherUser: failingStatement,
        hadNegative: failingCall,
        creditedToday: failingStatement,
      },
    }),
    sameDevice: stubJudge(true, { fail: failingStatement }),
  });
  expect(await computeIn(service, subject())).toEqual(
    loudFailing(
      'credited_today',
      'same_device_multi_account',
      'had_negative',
      'payee_prev_other_user',
    ),
  );
});

it.each([
  { amount: 10001n, want: [flag('withdraw_vs_received', 10001, 10000)] },
  { amount: 10000n, want: [] },
])(
  '[AC-B2-11a#21] ⑥ 分子含本单金额：近 30 天 0 + 本单 $amount 分 / 收货返利 10000 分',
  async ({ amount, want }) => {
    const service = riskService({
      facts: stubFacts({ ...QUIET, withdrawn: 0n, received: 10000n }),
      sameDevice: stubJudge(false),
    });
    expect(await computeIn(service, subject({ amountFen: amount }))).toEqual(want);
  },
);

it('[AC-B2-11a#22] ④⑤ 只用同一批自购子订单；分母为 0 时都不命中', async () => {
  const service = riskService({
    facts: stubFacts({ ...LOUD, orders: [] }),
    sameDevice: stubJudge(true),
  });
  expect(await computeIn(service, subject())).toEqual(
    LOUD_FLAGS.filter(
      (entry) => entry.code !== 'invalid_ratio_60d' && entry.code !== 'high_commission_ratio_60d',
    ),
  );
});

it('[AC-B2-11a#23] ⑥ 分母为 0 命中，value 为 null、threshold 为配置值', async () => {
  const service = riskService({
    config: mapConfig(new Map([[KEYS.withdraw_received_ratio_bp, 20000]])),
    facts: stubFacts({ ...QUIET, received: 0n }),
    sameDevice: stubJudge(false),
  });
  expect(await computeIn(service, subject())).toEqual([flag('withdraw_vs_received', null, 20000)]);
});
