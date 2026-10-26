// B2-11a: W1 writes the BR-WDR-29 snapshot (BR-WDR-03 ⑭; task 9.3 #1–#4). After the first pass
// and before the users row lock, in the W1 transaction, at t; risk_flags + risk_flags_at = t go in
// with the withdrawal row and are never recomputed; a refused first pass computes nothing; a failed
// item only adds risk_calc_failed. Real ledger, payout_accounts, withdrawals and config_items (the
// B2-05d kit); ③ through a stub port, and once through risk's real BR-ID-37 check.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSameDeviceLoginReader } from '../../../../apps/api/src/modules/identity/ports/same-device-logins.ts';
import type { WithdrawRiskFlags } from '../../../../apps/api/src/modules/payout/application/withdraw-risk-flags.ts';
import type { WithdrawRiskFlag } from '../../../../apps/api/src/modules/payout/domain/risk-flags.ts';
import { createWithdrawRiskFactsReader } from '../../../../apps/api/src/modules/payout/infra/withdraw-risk-facts.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { createSameDeviceAccountsCheck } from '../../../../apps/api/src/modules/risk/application/same-device-accounts.ts';
import {
  TIMEOUT,
  close,
  fixture,
  invariant,
  open,
  rows,
  seedUser,
  state,
  success,
  type Fixture,
  type Harness,
} from '../apply/kit.ts';
import {
  DAY,
  FACT_METHODS,
  HOUR,
  T,
  ago,
  applyWith,
  book,
  breakFact,
  failingStatement,
  riskService,
  seedHold,
  seedLogin,
  seedPastBinding,
  seedSelfOrders,
  seedWithdrawal,
  snapshots,
  stubFacts,
  stubJudge,
  txid,
  usersRowProbe,
  type FactCall,
  type JudgeCall,
  type RiskServiceInput,
} from './kit.ts';
import { KEYS, LOUD, LOUD_FLAGS, QUIET, failed, flag } from './oracle.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** The fixture's member at t: never paid out, credited 10000 fen at t, no received order. */
const BASE: readonly WithdrawRiskFlag[] = [
  flag('first_withdrawal'),
  flag('credited_today'),
  flag('withdraw_vs_received', null, 10000),
];

/** The service over the fixture's real configuration rows; ③ unmarked unless given. */
function riskFor(f: Fixture, input: RiskServiceInput = {}): WithdrawRiskFlags {
  return riskService({ config: f.options.rules.config, ...input });
}

async function applyIn(
  f: Fixture,
  riskFlags: WithdrawRiskFlags,
  options: { amountFen?: bigint; before?: (trx: Transaction<DB>) => Promise<void> } = {},
) {
  const useCase = applyWith(f, riskFlags);
  return h.db.transaction().execute(async (trx) => {
    if (options.before !== undefined) await options.before(trx);
    const amountFen = options.amountFen ?? 1000n;
    return useCase.apply(trx, { ...f.actor, amountFen, stepUpValid: true });
  });
}

async function snapshotOf(f: Fixture, id: string) {
  const found = (await snapshots(f)).find((row) => row.id === id);
  expect(found, `withdrawal ${id}`).toBeDefined();
  return found!;
}

it('[AC-B2-11a#36] 建单同事务写入快照：命中项 {code, value, threshold}，risk_flags_at = t', async () => {
  const f = await fixture(h);
  const data = success(await applyIn(f, riskFor(f)));
  const row = await snapshotOf(f, data.withdrawal_id);
  expect(row.risk_flags).toEqual(BASE);
  expect(row.risk_flags_at).toEqual(T);
  expect((await rows(f))[0]).toMatchObject({ id: data.withdrawal_id, created_at: T });
  await invariant(f);
});

it('[AC-B2-11a#37] 一项都没命中时写 []（不是 NULL），risk_flags_at 仍为 t', async () => {
  const f = await fixture(h);
  const data = success(await applyIn(f, riskFor(f, { facts: stubFacts(QUIET) })));
  const row = await snapshotOf(f, data.withdrawal_id);
  expect(row.risk_flags).toEqual([]);
  expect(row.risk_flags_at).toEqual(T);
});

it('[AC-B2-11a#38] 第一遍校验通过后、users 行锁之前、同一事务内计算；③ 的 ref 即所建提现单 id', async () => {
  const f = await fixture(h);
  const facts: FactCall[] = [];
  const judged: JudgeCall[] = [];
  const probe = usersRowProbe(f);
  const service = riskFor(f, {
    facts: stubFacts(LOUD, { calls: facts, probe }),
    sameDevice: stubJudge(true, { calls: judged, probe }),
  });
  let outer = '';
  const data = success(
    await applyIn(f, service, {
      before: async (trx) => {
        outer = await txid(trx);
      },
    }),
  );
  expect(judged).toHaveLength(1);
  expect(judged[0]).toEqual({
    input: {
      app_id: f.actor.appId,
      user_id: f.actor.userId,
      ref: { type: 'withdrawal', id: data.withdrawal_id },
    },
    txid: outer,
    usersRowFree: true,
  });
  expect(new Set(facts.map((call) => call.method))).toEqual(new Set(FACT_METHODS));
  for (const call of facts) {
    expect(call.subject, call.method).toMatchObject({
      appId: f.actor.appId,
      userId: f.actor.userId,
      withdrawalId: data.withdrawal_id,
      amountFen: 1000n,
      payeeHmac: f.hmac,
      now: T,
    });
    expect(call.usersRowFree, `${call.method} 时 users 行尚未加锁`).toBe(true);
  }
  expect((await snapshotOf(f, data.withdrawal_id)).risk_flags).toEqual(LOUD_FLAGS);
});

it('[AC-B2-11a#39] ③ 经 risk 的 BR-ID-37 判定：同设备第 3 个账号申请时打标，判定结论以提现单 id 落库', async () => {
  const f = await fixture(h);
  const device = 'c'.repeat(64);
  const first = await seedUser(h.db, f.actor.appId);
  const second = await seedUser(h.db, f.actor.appId);
  await seedLogin(f, first, device, ago(3 * DAY));
  await seedLogin(f, second, device, ago(2 * DAY));
  await seedLogin(f, f.actor.userId, device, ago(DAY));
  const lines: string[] = [];
  const sameDevice = createSameDeviceAccountsCheck({
    clock: f.clock,
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    ),
    logins: createSameDeviceLoginReader(),
    config: () => ({ configValue: async () => null }),
  });
  const data = success(await applyIn(f, riskFor(f, { sameDevice })));
  expect((await snapshotOf(f, data.withdrawal_id)).risk_flags).toEqual([
    flag('first_withdrawal'),
    flag('credited_today'),
    flag('same_device_multi_account'),
    flag('withdraw_vs_received', null, 10000),
  ]);
  const judgements = await sql<{
    ref_type: string;
    ref_id: string;
    user_id: string;
    marked: boolean;
  }>`SELECT ref_type, ref_id, user_id, marked FROM app.risk_judgements
    WHERE app_id = ${f.actor.appId}`.execute(h.db);
  expect(judgements.rows).toEqual([
    { ref_type: 'withdrawal', ref_id: data.withdrawal_id, user_id: f.actor.userId, marked: true },
  ]);
});

it('[AC-B2-11a#40] 第一遍校验拒绝的申请不计算、不判定 ③、不写任何东西', async () => {
  const f = await fixture(h);
  const facts: FactCall[] = [];
  const judged: JudgeCall[] = [];
  const service = riskFor(f, {
    facts: stubFacts(LOUD, { calls: facts }),
    sameDevice: stubJudge(true, { calls: judged }),
  });
  const before = await state(f);
  const result = await applyIn(f, service, { amountFen: 20000n });
  expect(result.code).not.toBe(0);
  expect(facts).toEqual([]);
  expect(judged).toEqual([]);
  expect(await state(f)).toEqual(before);
  expect(await snapshots(f)).toEqual([]);
});

it('[AC-B2-11a#41] ③ 端口调用报错不阻断申请：照常建单冻结，写 risk_calc_failed', async () => {
  const f = await fixture(h);
  const service = riskFor(f, { sameDevice: stubJudge(true, { fail: failingStatement }) });
  const data = success(await applyIn(f, service));
  expect((await snapshotOf(f, data.withdrawal_id)).risk_flags).toEqual([
    ...BASE,
    failed('same_device_multi_account'),
  ]);
  const s = await state(f);
  expect(s.withdrawals).toHaveLength(1);
  expect(s.vouchers).toHaveLength(1);
  expect(s.balances[0]).toMatchObject({ available_fen: 9000n, frozen_fen: 1000n });
  await invariant(f);
});

it('[AC-B2-11a#42] 某项事实查询报错不阻断申请：该项写入 risk_calc_failed，其余照算', async () => {
  const f = await fixture(h);
  await seedHold(f, { reason: 'recon_diff', createdAt: ago(20 * DAY), releasedAt: ago(10 * DAY) });
  const facts = breakFact(createWithdrawRiskFactsReader(), 'reconDiff', failingStatement);
  const data = success(await applyIn(f, riskFor(f, { facts })));
  expect((await snapshotOf(f, data.withdrawal_id)).risk_flags).toEqual([
    ...BASE,
    failed('recon_diff'),
  ]);
  expect((await state(f)).balances[0]).toMatchObject({ available_fen: 9000n, frozen_fen: 1000n });
  await invariant(f);
});

it('[AC-B2-11a#43] 计算读 W1 事务自己的未提交数据（同一事务）', async () => {
  const f = await fixture(h);
  const data = success(
    await applyIn(f, riskFor(f), {
      before: (trx) =>
        seedHold(
          f,
          { reason: 'recon_diff', createdAt: ago(20 * DAY), releasedAt: ago(10 * DAY) },
          trx,
        ),
    }),
  );
  expect((await snapshotOf(f, data.withdrawal_id)).risk_flags).toEqual([
    ...BASE,
    flag('recon_diff'),
  ]);
});

it.each([
  {
    label: '① 已有 PAID_API 提现单 → 不打 first_withdrawal',
    seed: (f: Fixture) =>
      seedWithdrawal(f, { status: 'PAID_API', amountFen: 500n, createdAt: ago(40 * DAY) }),
    now: null,
    want: [flag('credited_today'), flag('withdraw_vs_received', null, 10000)],
  },
  {
    label: '② t 为次日 00:00 +08:00 → 不打 credited_today',
    seed: async () => undefined,
    now: '2026-10-19T16:00:00.000Z',
    want: [flag('first_withdrawal'), flag('withdraw_vs_received', null, 10000)],
  },
  {
    label: '② t 为当日 23:59:59.999 +08:00 → 打 credited_today',
    seed: async () => undefined,
    now: '2026-10-19T15:59:59.999Z',
    want: BASE,
  },
  {
    label: '④ 10 单自购中 4 单失效 → 4000bp',
    seed: (f: Fixture) => seedSelfOrders(f),
    now: null,
    want: [
      flag('first_withdrawal'),
      flag('credited_today'),
      flag('invalid_ratio_60d', 4000, 3000),
      flag('withdraw_vs_received', null, 10000),
    ],
  },
  {
    label: '⑦ 曾经负余额（已回正）',
    seed: async (f: Fixture) => {
      await book(f, f.actor.userId, 15000n, 'CLAWBACK', ago(10 * DAY));
      await book(f, f.actor.userId, -20000n, 'REBATE_CREDIT', ago(9 * DAY));
    },
    now: null,
    want: [...BASE, flag('had_negative')],
  },
  {
    label: '⑧ 已解除的 recon_diff 冻结记录',
    seed: (f: Fixture) =>
      seedHold(f, { reason: 'recon_diff', createdAt: ago(20 * DAY), releasedAt: ago(10 * DAY) }),
    now: null,
    want: [...BASE, flag('recon_diff')],
  },
  {
    label: '⑩ 收款账号近 90 天内被其他会员绑定过',
    seed: async (f: Fixture) => {
      const other = await seedUser(h.db, f.actor.appId);
      await seedPastBinding(f, {
        userId: other,
        method: 'alipay',
        hmac: f.hmac,
        boundAt: ago(30 * DAY),
        changedAt: ago(10 * DAY),
      });
    },
    now: null,
    want: [...BASE, flag('payee_prev_other_user')],
  },
])('[AC-B2-11a#44] 真实数据经 W1 落快照：$label', async ({ seed, now, want }) => {
  const f = await fixture(h);
  await seed(f);
  if (now !== null) f.clock.set(now);
  const data = success(await applyIn(f, riskFor(f)));
  const row = await snapshotOf(f, data.withdrawal_id);
  expect(row.risk_flags).toEqual(want);
  expect(row.risk_flags_at).toEqual(now === null ? T : new Date(now));
});

it('[AC-B2-11a#45] 快照不随之后的数据重算：后一单反映新事实，前一单不变', async () => {
  const f = await fixture(h);
  const first = success(await applyIn(f, riskFor(f)));
  await seedHold(f, { reason: 'recon_diff', createdAt: ago(DAY), releasedAt: ago(2 * HOUR) });
  await seedWithdrawal(f, { status: 'PAID_API', amountFen: 500n, createdAt: ago(40 * DAY) });
  const second = success(await applyIn(f, riskFor(f)));
  expect(await snapshotOf(f, first.withdrawal_id)).toEqual({
    id: first.withdrawal_id,
    risk_flags: BASE,
    risk_flags_at: T,
  });
  expect((await snapshotOf(f, second.withdrawal_id)).risk_flags).toEqual([
    flag('credited_today'),
    flag('withdraw_vs_received', null, 10000),
    flag('recon_diff'),
  ]);
});

it('[AC-B2-11a#46] 阈值读本应用的 risk.withdraw.* 配置行', async () => {
  const f = await fixture(h);
  await seedSelfOrders(f);
  await f.set(KEYS.invalid_ratio_bp, 4000);
  await f.set(KEYS.withdraw_received_ratio_bp, 20000);
  const data = success(await applyIn(f, riskFor(f)));
  expect((await snapshotOf(f, data.withdrawal_id)).risk_flags).toEqual([
    flag('first_withdrawal'),
    flag('credited_today'),
    flag('withdraw_vs_received', null, 20000),
  ]);
});
