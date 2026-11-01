// B2-15r 规则测试（claude-independent，SPEC_REF deb521c2）：FU-PAY-FAKE-BILL-NOISE。假通道没有账单，每个账单日都这样，
// 补跑到期也不会有；所以 fake_not_supported 与 channel_unconfigured、kms_unavailable 一样视同没有适配器：
// runPayBillRecon 返回 skipped、记 debug pay_bill_recon_no_adapter、不补跑、不告警、不记已对账，也绝不当空账单读
// （08 BR-PAY-07：差错单、异常、PAY_FEE 都不产生），日链照常往下走。其他 unknown 原因行为不变。
// 不连库：这条路径在任何查询之前就停了，事务只发下一日任务。Top-level it() only（规划/11 §4.3）。
//
// 两处写法是为先红工具定的（tools/guard/lib/red-check.ts）：
// - 新文件的每条用例都必须红，反例在现状下是绿的，所以反例不单列，和正例写进同一条用例（#7），反例在前，整条因末尾的
//   正例而红；实现之后两部分都要成立。
// - 不直接 expect(runPayBillRecon(…)).resolves：vitest 5.0.1 把被拒绝的错误挂在 AssertionError.cause 上，而红检按最内层
//   cause 判定，PayBillUnavailable 既不是断言也不是 NotImplemented，会判「原因不明」。先经 settled() 收成一个值，再
//   .resolves.toBe('skipped')，红的就只是这条断言。
import { expect, it } from 'vitest';
import {
  PayChannelSet,
  type PayBillResult,
  type PayChannel,
} from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  PayBillUnavailable,
  runBillReconJob,
  runPayBillRecon,
  type PayReconDeps,
} from '../../../../apps/api/src/modules/payment/application/pay-recon.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  FAKE_UNKNOWN_REASON,
  FakePayChannel,
} from '../../../../apps/api/src/modules/payment/infra/channels/fake-pay-channel.ts';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';

const APP = 'couli-app-test';
const BILL_DATE = '2026-10-31';
const NEXT_BILL_DATE = '2026-11-01';
/** 账单日的次日 12:00 +08:00：T+1 跑批之后，还在补跑期限之内。 */
const NOW = new Date('2026-11-01T04:00:00.000Z');
/** 账单日 + 30 天：早已过了补跑期限（账单日结束后 3 天）。 */
const PAST_LIMIT = new Date('2026-11-30T04:00:00.000Z');
const DAILY = { app_id: APP, bill_date: BILL_DATE };
const NEXT_DAY_PAYLOAD = { app_id: APP, bill_date: NEXT_BILL_DATE };
const BOTH: readonly PayChannelCode[] = ['wechat_pay', 'alipay'];
/** 真实通道可能给出的「账单暂时拿不到」，以及一个同样带 fake 前缀、但不是「没有账单」的原因。 */
const OTHER_REASONS = ['spec_bill_unavailable', 'channel_error:SYSTEM_ERROR', FAKE_UNKNOWN_REASON];

const DEBUG = 20;
const WARN = 40;
const ERROR = 50;

interface Sent {
  readonly queue: string;
  readonly job: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly singletonKey: string | undefined;
  readonly delaySeconds: number | undefined;
}

/** 假通道的其他 unknown 应答：只换账单这一个方法，用来核对「别的原因行为不变」。 */
class OtherBillAnswer extends FakePayChannel {
  readonly #reason: string;

  constructor(channel: PayChannelCode, reason: string) {
    super(channel);
    this.#reason = reason;
  }

  override downloadBill(): Promise<PayBillResult> {
    return Promise.resolve({ kind: 'unknown', reason: this.#reason });
  }
}

function fakes(): readonly PayChannel[] {
  return BOTH.map((channel) => new FakePayChannel(channel));
}

function others(reason: string): readonly PayChannel[] {
  return BOTH.map((channel) => new OtherBillAnswer(channel, reason));
}

function harness(channels: readonly PayChannel[], now: Date = NOW) {
  const logs: string[] = [];
  const sent: Sent[] = [];
  const ledgerCalls: string[] = [];
  const tablesTouched: string[] = [];
  const deny = (member: string | symbol): never => {
    tablesTouched.push(String(member));
    throw new Error(`the database was touched: ${String(member)}`);
  };
  // 账单之后的任何查询（当成空账单读）、任何「已对账」写入都走到这里：记下来并失败。
  const noTables = new Proxy({}, { get: (_target, member) => deny(member) });
  const db = new Proxy(
    {},
    {
      get: (_target, member) =>
        member === 'transaction'
          ? () => ({ execute: (run: (trx: object) => unknown) => run(noTables) })
          : deny(member),
    },
  );
  const recordLedger = (name: string) => () => {
    ledgerCalls.push(name);
    return Promise.resolve({ inserted: true });
  };
  const deps = {
    clock: new FixedClock(now),
    logger: createRootLogger(
      { entry: 'worker', appEnv: 'test', level: 'trace' },
      {
        write: (line) => {
          logs.push(line);
        },
      },
    ),
    queue: {
      send: (
        queue: string,
        job: string,
        payload: Readonly<Record<string, unknown>>,
        options: { readonly singletonKey?: string; readonly delaySeconds?: number },
      ) => {
        sent.push({
          queue,
          job,
          payload,
          singletonKey: options.singletonKey,
          delaySeconds: options.delaySeconds,
        });
        return Promise.resolve(null);
      },
    },
    channels: new PayChannelSet(channels),
    ledger: {
      post: recordLedger('post'),
      registerReconDiff: recordLedger('registerReconDiff'),
      registerReconDiffOnce: recordLedger('registerReconDiffOnce'),
    },
    db,
  } as unknown as PayReconDeps;
  const lines = (): readonly { readonly level: number; readonly msg: string }[] =>
    logs.map((line) => JSON.parse(line) as { level: number; msg: string });
  const messages = (): readonly string[] => lines().map((line) => line.msg);
  const atLevel = (level: number): readonly string[] =>
    lines()
      .filter((line) => line.level === level)
      .map((line) => line.msg);
  /** warn 及以上的全部日志。 */
  const noisy = (): readonly string[] =>
    lines()
      .filter((line) => line.level >= WARN)
      .map((line) => line.msg);
  const payloads = (): readonly Readonly<Record<string, unknown>>[] =>
    sent.map((item) => item.payload);
  const catchUps = (): readonly Sent[] =>
    sent.filter((item) => item.payload['pay_channel'] !== undefined);
  return { deps, sent, ledgerCalls, tablesTouched, messages, atLevel, noisy, payloads, catchUps };
}

/** 一次调用的结果收成一个值（见文件头）：正常结束是它的返回值，抛出是 `threw <错误名>`。 */
async function settled<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error: unknown) {
    return error instanceof Error ? `threw ${error.name}` : 'threw';
  }
}

function jobOutcome(deps: PayReconDeps, payload: unknown): Promise<string> {
  return settled(async () => {
    await runBillReconJob(deps, payload);
    return 'finished';
  });
}

it.each(BOTH)(
  '[AC-B2-15r#1] 假通道 %s：runPayBillRecon 返回 skipped，只记一条 debug pay_bill_recon_no_adapter，没有 warn / error',
  async (channel) => {
    // 应答来自真的 FakePayChannel，不是测试自己写的。
    await expect(new FakePayChannel(channel).downloadBill(BILL_DATE)).resolves.toEqual({
      kind: 'unknown',
      reason: 'fake_not_supported',
    });
    const h = harness(fakes());
    await expect(
      settled(() => runPayBillRecon(h.deps, { ...DAILY, pay_channel: channel })),
    ).resolves.toBe('skipped');
    expect(h.atLevel(DEBUG)).toEqual(['pay_bill_recon_no_adapter']);
    expect(h.noisy()).toEqual([]);
  },
);

it('[AC-B2-15r#2] runBillReconJob 对假通道不发 catch-up，不记补跑日志，两个渠道各一条 debug', async () => {
  const h = harness(fakes());
  await expect(jobOutcome(h.deps, DAILY)).resolves.toBe('finished');
  expect(h.catchUps()).toEqual([]);
  expect(h.messages()).not.toContain('pay_bill_recon_catch_up');
  expect(h.messages()).not.toContain('pay_bill_unavailable');
  expect(h.atLevel(DEBUG)).toEqual(['pay_bill_recon_no_adapter', 'pay_bill_recon_no_adapter']);
  expect(h.noisy()).toEqual([]);
});

it('[AC-B2-15r#3] 账单日 + 30 天再跑假通道：没有 pay_bill_recon_abandoned，error 级一条都没有，日链仍往下走', async () => {
  const h = harness(fakes(), PAST_LIMIT);
  await expect(jobOutcome(h.deps, DAILY)).resolves.toBe('finished');
  expect(h.payloads()).toEqual([NEXT_DAY_PAYLOAD]);
  expect(h.messages()).not.toContain('pay_bill_recon_abandoned');
  expect(h.atLevel(ERROR)).toEqual([]);
  expect(h.noisy()).toEqual([]);
});

it('[AC-B2-15r#4] 日链：假通道的账单日只发一条任务，就是下一账单日的日任务（D+1 10:00 +08:00 到期），不多不少', async () => {
  const h = harness(fakes());
  await expect(jobOutcome(h.deps, DAILY)).resolves.toBe('finished');
  expect(h.sent).toEqual([
    {
      queue: 'pay',
      job: 'bill.recon',
      payload: NEXT_DAY_PAYLOAD,
      singletonKey: `bill.recon:${APP}:${NEXT_BILL_DATE}`,
      // 2026-11-02T02:00:00Z − NOW = 22 小时。
      delaySeconds: 79_200,
    },
  ]);
});

it('[AC-B2-15r#5] 不记为已对账、不当空账单读：不碰任何表，不产生差错单、异常、PAY_FEE，也没有 pay_bill_reconciled', async () => {
  const h = harness(fakes());
  await expect(jobOutcome(h.deps, DAILY)).resolves.toBe('finished');
  // 这几条在现状下也成立（现状是抛错，同样不读账单）；实现后防的是把它当空账单。
  expect(h.tablesTouched).toEqual([]);
  expect(h.ledgerCalls).toEqual([]);
  expect(h.messages()).not.toContain('pay_bill_reconciled');
  expect(h.messages()).not.toContain('pay_anomaly_receipt');
  expect(h.messages()).not.toContain('pay_recon_mismatch');
  // 也不是「账单暂时拿不到」：它是没有账单。
  expect(h.messages()).not.toContain('pay_bill_unavailable');
});

it.each(BOTH)(
  '[AC-B2-15r#6] 队列里还留着的 %s 补跑任务遇到假通道：到此为止，不再发任务；过了期限也不告警',
  async (channel) => {
    const within = harness(fakes());
    await expect(jobOutcome(within.deps, { ...DAILY, pay_channel: channel })).resolves.toBe(
      'finished',
    );
    expect(within.sent).toEqual([]);
    expect(within.noisy()).toEqual([]);

    const late = harness(fakes(), PAST_LIMIT);
    await expect(jobOutcome(late.deps, { ...DAILY, pay_channel: channel })).resolves.toBe(
      'finished',
    );
    expect(late.sent).toEqual([]);
    expect(late.noisy()).toEqual([]);
  },
);

it('[AC-B2-15r#7] 其他 unknown 原因不变：仍抛 PayBillUnavailable、仍发 catch-up、到期仍 abandoned；假通道才 skipped', async () => {
  // 反例，放在前面（见文件头）：现状下就成立，实现之后也必须成立。
  for (const reason of OTHER_REASONS) {
    const single = harness(others(reason));
    await expect(
      runPayBillRecon(single.deps, { ...DAILY, pay_channel: 'wechat_pay' }),
    ).rejects.toBeInstanceOf(PayBillUnavailable);
    expect(single.atLevel(WARN)).toEqual(['pay_bill_unavailable']);
    expect(single.messages()).not.toContain('pay_bill_recon_no_adapter');

    const within = harness(others(reason));
    await expect(jobOutcome(within.deps, DAILY)).resolves.toBe('finished');
    expect(within.payloads()).toEqual([
      { ...DAILY, pay_channel: 'wechat_pay' },
      { ...DAILY, pay_channel: 'alipay' },
      NEXT_DAY_PAYLOAD,
    ]);
    expect(within.messages()).toContain('pay_bill_recon_catch_up');
    expect(within.messages()).not.toContain('pay_bill_recon_abandoned');

    const late = harness(others(reason), PAST_LIMIT);
    await expect(jobOutcome(late.deps, DAILY)).resolves.toBe('finished');
    expect(late.atLevel(ERROR)).toEqual(['pay_bill_recon_abandoned', 'pay_bill_recon_abandoned']);
    expect(late.payloads()).toEqual([NEXT_DAY_PAYLOAD]);
  }

  // 正例：同一个 harness 换回真的假通道。
  const fake = harness(fakes());
  await expect(
    settled(() => runPayBillRecon(fake.deps, { ...DAILY, pay_channel: 'wechat_pay' })),
  ).resolves.toBe('skipped');
});

it('[AC-B2-15r#8] 按渠道判定：微信是假通道、支付宝账单暂时拿不到，只有支付宝补跑', async () => {
  const h = harness([
    new FakePayChannel('wechat_pay'),
    new OtherBillAnswer('alipay', 'spec_bill_unavailable'),
  ]);
  await expect(jobOutcome(h.deps, DAILY)).resolves.toBe('finished');
  expect(h.payloads()).toEqual([{ ...DAILY, pay_channel: 'alipay' }, NEXT_DAY_PAYLOAD]);
  expect(h.atLevel(DEBUG)).toEqual(['pay_bill_recon_no_adapter']);
  expect(h.atLevel(WARN)).toEqual(['pay_bill_unavailable', 'pay_bill_recon_catch_up']);
});
