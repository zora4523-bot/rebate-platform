// B2-06f rule tests: PayoutModule.forPayout in the real AppModule (规划/08 BR-WDR-13: 只有 payout 进程
// 读通道密钥；非 prod 只能沙箱或 dry-run；开关直读 PG、不连 Redis; BR-WDR-14 查询). The runtime exists on
// the payout entry only; start(decision) registers queue `payout` (transfer / query) with
// FakeChannel under dry_run and AlipayChannel with the injected credentials under live.
// #23 / #24 drive PAYING withdrawals through the registered handler over the recording driver
// (assembly-kit.ts): the statements the handler reads are answered from in-memory rows, so the
// configuration reader, the channels and the queue it was assembled with are the ones observed.
// B2-06f (D10-398, D10-327: drive steps only): a transfer job past ① ② only enqueues the worker's
// review (`payout-review` / `review`); the worker's BR-WDR-13 ③ review is not run here, the drive
// hands the payout handler the `release` it would enqueue, and the release re-checks the switches
// inside the payout_daily lock (a switch turned off between review and release is caught there).
// In #23 the payout process never writes config_items (couli_payout may not): a payer-side code
// is W9 on its own transaction plus a `pause` job (payout-landing) and an in-process pause, so the
// next release is W9 queue_paused before anything is persisted; payout.queue_paused only becomes
// true through a config_items write the assembled worker's pause handler issues for that job, and
// a new payout process then reads it from PG. The test never sets it.
// The query job's wait between two tries is its default platform timer (node:timers/promises),
// mocked below to resolve at once.
import { afterEach, expect, it, vi } from 'vitest';
import { FakeChannel } from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import { AlipayChannel } from '../../../../apps/api/src/modules/payout/infra/channels/alipay-channel.ts';
import type { PayoutRuntime } from '../../../../apps/api/src/modules/payout/payout-runtime.ts';
import { alipayKeys, appKeys, signedEnvelope } from '../channel/fixtures.ts';
import { START, assemble, job, type EntryName, type Statement } from './assembly-kit.ts';

vi.mock('node:timers/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:timers/promises')>();
  return { ...real, setTimeout: (...args: unknown[]) => Promise.resolve(args[1]) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function started(runtime: Partial<PayoutRuntime> | null | undefined): PayoutRuntime {
  expect(typeof runtime?.start).toBe('function');
  return runtime as PayoutRuntime;
}

const APP = 'app-b2-06f';
const MINUTE = 60_000;

/** A PAYING withdrawal row as the transfer / query jobs select it (synthetic values only). */
function paying(id: string, outBizNo: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    app_id: APP,
    user_id: '019a0000-0000-7000-8000-0000000b206f',
    status: 'PAYING',
    execute_seq: 1,
    row_version: 3,
    needs_manual: false,
    amount_fen: 10_000n,
    net_fen: 10_000n,
    fee_fen: 0n,
    tax_fen: 0n,
    out_biz_no: outBizNo,
    payout_channel: 'alipay',
    payout_method: 'alipay',
    payee_name: '合成姓名',
    payee_account_cipher: Buffer.from('synthetic-cipher-b2-06f'),
    blocked_reason: null,
    ...patch,
  };
}

const isSelect = (s: Statement): boolean => /^\s*select\b/i.test(s.sql);
const readsWithdrawals = (s: Statement): boolean =>
  isSelect(s) && /\bfrom "app"\."withdrawals"/.test(s.sql);
const readsConfig = (s: Statement): boolean => isSelect(s) && s.sql.includes('"config_items"');
const insertsAttempt = (s: Statement): boolean =>
  /^\s*insert into "app"\."payout_attempts"/i.test(s.sql);
const writesConfig = (s: Statement): boolean =>
  /^\s*(insert into|update) "app"\."config_items"/i.test(s.sql);
/** The written value is true, inlined (`'true'::jsonb`, `true`) or bound (true / JSON 'true'). */
const writesTrue = (s: Statement): boolean =>
  /\btrue\b/i.test(s.sql) || s.parameters.some((p) => p === true || p === 'true');

/** Answers config_items reads of APP from `config` (value, version). */
function configRow(s: Statement, config: ReadonlyMap<string, unknown>): unknown[] | undefined {
  if (!readsConfig(s) || !s.parameters.includes(APP)) return undefined;
  const key = s.parameters.find((p) => typeof p === 'string' && config.has(p));
  return key === undefined ? [] : [{ value: config.get(key as string), version: 2 }];
}

/** The withdrawal row of `rows` whose id the statement binds. */
function withdrawalRow(s: Statement, rows: ReadonlyMap<string, unknown>): unknown[] {
  const id = s.parameters.find((p) => typeof p === 'string' && rows.has(p));
  return id === undefined ? [] : [rows.get(id as string)];
}

/** The payload of each `review` job the payout handler enqueued for `id` (D10-398 ①). */
function reviewsOf(app: { sends: { mock: { calls: unknown[][] } } }, id: string): unknown[] {
  return app.sends.mock.calls
    .filter(
      (call) =>
        call[0] === 'payout-review' &&
        call[1] === 'review' &&
        (call[2] as Record<string, unknown>)['withdrawal_id'] === id,
    )
    .map((call) => call[2]);
}

/**
 * The payout handler's two steps for one withdrawal (D10-398 ①, D10-327): the transfer job must
 * enqueue exactly one review { app_id, withdrawal_id, execute_seq }; the drive then hands the
 * handler the release the worker enqueues once its review passed.
 */
async function transferThenRelease(
  app: { sends: { mock: { calls: unknown[][] } } },
  handler: (received: ReturnType<typeof job>) => Promise<void>,
  id: string,
): Promise<void> {
  const target = { withdrawal_id: id, execute_seq: 1, app_id: APP };
  await handler(job('transfer', target));
  expect(reviewsOf(app, id)).toEqual([expect.objectContaining(target)]);
  await handler(job('release', target));
}

/** [withdrawal_id, hold_reason] of every payout_transfer_held line. */
function heldPairs(app: { logged(msg: string): Array<Record<string, unknown>> }): unknown[][] {
  return app
    .logged('payout_transfer_held')
    .map((line) => [line['withdrawal_id'], line['hold_reason']]);
}

it('[AC-B2-06f#18] 只有 payout 入口提供运行体，其余入口不注册 payout 队列；装配不查库、不发任务', async () => {
  for (const entry of [
    'api',
    'stream',
    'admin',
    'worker',
  ] as const satisfies readonly EntryName[]) {
    const app = await assemble(entry);
    try {
      expect(app.runtime() ?? null, entry).toBeNull();
      expect(app.payoutHandlers(), entry).toHaveLength(0);
    } finally {
      await app.close();
    }
  }
  const app = await assemble('payout');
  try {
    started(app.runtime());
    expect(app.queries).toEqual([]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B2-06f#19] dry_run：payout 队列恰好一个 handler；alipay 是 FakeChannel，没有任何 AlipayChannel；启动不查库不发任务', async () => {
  const app = await assemble('payout');
  try {
    const result = started(app.runtime()).start({ mode: 'dry_run' });
    expect(result.mode).toBe('dry_run');
    expect(app.payoutHandlers()).toHaveLength(1);
    expect(result.channels.alipay).toBeInstanceOf(FakeChannel);
    for (const adapter of Object.values(result.channels)) {
      expect(adapter).not.toBeInstanceOf(AlipayChannel);
    }
    expect(app.queries).toEqual([]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B2-06f#20] live：alipay 不是 FakeChannel，按注入凭证的网关地址发请求；日志不含私钥', async () => {
  const gatewayUrl = 'https://alipay.test.invalid/b2-06f/gateway.do';
  const fetch = vi.fn(async () => new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const app = await assemble('payout');
  try {
    const result = started(app.runtime()).start({
      mode: 'live',
      credentials: {
        appId: 'test_app_id_b2_06f',
        privateKey: appKeys().privateKey,
        alipayPublicKey: alipayKeys().publicKey,
        gatewayUrl,
      },
    });
    expect(result.mode).toBe('live');
    expect(app.payoutHandlers()).toHaveLength(1);
    const alipay = result.channels.alipay;
    expect(alipay).toBeDefined();
    expect(alipay).not.toBeInstanceOf(FakeChannel);
    const answer = await alipay!.query('wd_b2_06f_live_probe');
    expect(answer.kind).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe(gatewayUrl);
    expect(app.lines.join('\n')).not.toContain(appKeys().privateKey);
  } finally {
    await app.close();
  }
});

it('[AC-B2-06f#21] payout 队列的 handler 按任务名分派转账 / 查询，读本进程的库，不调通道', async () => {
  const app = await assemble('payout');
  try {
    const result = started(app.runtime()).start({ mode: 'dry_run' });
    const [handler] = app.payoutHandlers();
    expect(handler).toBeTypeOf('function');

    await handler!(job('transfer', {}));
    expect(app.msgs()).toContain('payout_transfer_bad_payload');
    await handler!(job('query', {}));
    expect(app.msgs()).toContain('payout_query_bad_payload');
    expect(app.queries).toEqual([]);

    const target = { withdrawal_id: 'wd-b2-06f', execute_seq: 1, app_id: 'app-b2-06f' };
    await handler!(job('transfer', target));
    expect(app.msgs()).toContain('payout_transfer_skipped');
    const afterTransfer = app.queries.length;
    expect(app.queries.some((sql) => sql.includes('"withdrawals"'))).toBe(true);

    await handler!(job('query', { ...target, point: 0 }));
    expect(app.msgs()).toContain('payout_query_skipped');
    expect(app.queries.length).toBeGreaterThan(afterTransfer);

    expect((result.channels.alipay as FakeChannel).calls).toEqual([]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B2-06f#23] 转账复核的开关每次从 PG 现读（transfer 只发复核，release 在锁内再复核）；付款方异常 payout 自做 W9 并发 pause 任务、不写 config_items，落库前进程内暂停使下一单 W9 queue_paused、不再发送；worker 消费 pause 写入 payout.queue_paused 后新进程以库为准', async () => {
  // BR-WDR-17 / BR-WDR-28: a payer-side code (listed in payout.payer_side_codes, or still unlisted
  // and so an unknown business code) pauses the queue either way; the sub_code is synthetic.
  const payerSideCode = 'TEST_PAYER_SIDE';
  const gatewayUrl = 'https://alipay.test.invalid/b2-06f/pause.do';
  const sentOutBizNos: unknown[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    const biz = JSON.parse(params.get('biz_content') ?? '{}') as Record<string, unknown>;
    sentOutBizNos.push(biz['out_biz_no']);
    const node = JSON.stringify({
      code: '40004',
      msg: 'Business Failed',
      sub_code: payerSideCode,
      sub_msg: 'synthetic payer side',
      out_biz_no: biz['out_biz_no'],
    });
    return new Response(signedEnvelope('transfer', node), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  const app = await assemble('payout');
  try {
    started(app.runtime()).start({
      mode: 'live',
      credentials: {
        appId: 'test_app_id_b2_06f',
        privateKey: appKeys().privateKey,
        alipayPublicKey: alipayKeys().publicKey,
        gatewayUrl,
      },
    });
    const [handler] = app.payoutHandlers();
    expect(handler).toBeTypeOf('function');

    // The first member carries the negative balance block (never reached: payout_disabled comes
    // first, BR-WDR-13 ③ order); the other two pass every review step on the default config.
    const disabledId = 'wd-b2-06f-config-1';
    const payerId = 'wd-b2-06f-payer-2';
    const nextId = 'wd-b2-06f-paused-3';
    const rows = new Map<string, Record<string, unknown>>([
      [disabledId, paying(disabledId, 'B206FCONFIG0001', { blocked_reason: 'NEGATIVE_BALANCE' })],
      [payerId, paying(payerId, 'B206FPAYER0002')],
      [nextId, paying(nextId, 'B206FPAUSED0003')],
    ]);
    // config_items as an operator leaves it after the process started; payout.queue_paused is
    // only ever set by a write of the assembled pause port below.
    const config = new Map<string, unknown>([
      ['payout.enabled', false],
      ['payout.payer_side_codes', [payerSideCode]],
    ]);
    const pauseWrites: Statement[] = [];
    app.respond((s) => {
      if (readsWithdrawals(s)) return withdrawalRow(s, rows);
      if (
        writesConfig(s) &&
        s.parameters.includes(APP) &&
        s.parameters.includes('payout.queue_paused')
      ) {
        pauseWrites.push(s);
        if (writesTrue(s)) config.set('payout.queue_paused', true);
        return [{ value: true, version: 3 }];
      }
      return configRow(s, config);
    });

    await transferThenRelease(app, handler!, disabledId);
    expect(heldPairs(app)).toEqual([[disabledId, 'payout_disabled']]);
    expect(fetch).not.toHaveBeenCalled();

    // 10 seconds later (规划/04 §10.2: a switch takes effect within 10 seconds) the operator has
    // turned payout back on; the next withdrawal is sent and the channel answers payer-side.
    app.clock.set(new Date(Date.parse(START) + 10_000));
    config.set('payout.enabled', true);
    await transferThenRelease(app, handler!, payerId);
    expect(sentOutBizNos).toEqual(['B206FPAYER0002']);
    expect(app.statements.filter(insertsAttempt)).toHaveLength(1);
    // D10-398 ②: W9 payer_side_after_transfer by the payout process itself; the pause is a job
    // for the worker, never a config_items write of couli_payout.
    expect(
      app.statements.some(
        (s) =>
          /^\s*update "app"\."withdrawals"/i.test(s.sql) &&
          s.parameters.includes('payer_side_after_transfer'),
      ),
    ).toBe(true);
    expect(app.statements.filter(writesConfig)).toEqual([]);
    expect(pauseWrites).toEqual([]);
    const pauses = app.sends.mock.calls.filter(
      (call) => call[0] === 'payout-landing' && call[1] === 'pause',
    );
    expect(pauses.map((call) => call[2])).toEqual([
      expect.objectContaining({ app_id: APP, reason: 'payer_side' }),
    ]);

    // The withdrawal after it, before the worker persisted anything: the in-process pause makes
    // its release W9 queue_paused, nothing sent.
    await transferThenRelease(app, handler!, nextId);
    expect(heldPairs(app)).toEqual([
      [disabledId, 'payout_disabled'],
      [nextId, 'queue_paused'],
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentOutBizNos).toEqual(['B206FPAYER0002']);
    expect(app.statements.filter(insertsAttempt)).toHaveLength(1);
    expect(config.has('payout.queue_paused')).toBe(false);

    // The worker consumes the pause job: its pause handler writes payout.queue_paused = true.
    const worker = await assemble('worker');
    try {
      const landing = worker.registrations
        .filter((r) => r.name === 'payout-landing')
        .map((r) => r.handler);
      expect(landing).toHaveLength(1);
      worker.respond((s) => {
        if (
          writesConfig(s) &&
          s.parameters.includes(APP) &&
          s.parameters.includes('payout.queue_paused')
        ) {
          pauseWrites.push(s);
          if (writesTrue(s)) config.set('payout.queue_paused', true);
          return [{ value: true, version: 3 }];
        }
        return configRow(s, config);
      });
      await landing[0]!(
        Object.freeze({
          id: 'job-b2-06f-pause',
          queue: 'payout-landing',
          name: 'pause',
          payload: pauses[0]![2] as Record<string, unknown>,
          attempt: 1,
        }) as ReturnType<typeof job>,
      );
    } finally {
      await worker.close();
    }
    expect(pauseWrites.length).toBeGreaterThan(0);
    expect(config.get('payout.queue_paused')).toBe(true);

    // A new payout process (restart) reads the persisted pause from PG: W9 queue_paused, not sent.
    const restarted = await assemble('payout');
    try {
      started(restarted.runtime()).start({
        mode: 'live',
        credentials: {
          appId: 'test_app_id_b2_06f',
          privateKey: appKeys().privateKey,
          alipayPublicKey: alipayKeys().publicKey,
          gatewayUrl,
        },
      });
      const [restartedHandler] = restarted.payoutHandlers();
      expect(restartedHandler).toBeTypeOf('function');
      const afterId = 'wd-b2-06f-restart-4';
      const restartRows = new Map<string, Record<string, unknown>>([
        [afterId, paying(afterId, 'B206FRESTART0004')],
      ]);
      restarted.respond((s) => {
        if (readsWithdrawals(s)) return withdrawalRow(s, restartRows);
        return configRow(s, config);
      });
      await transferThenRelease(restarted, restartedHandler!, afterId);
      expect(heldPairs(restarted)).toEqual([[afterId, 'queue_paused']]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(restarted.statements.filter(insertsAttempt)).toEqual([]);
      expect(restarted.statements.filter(writesConfig)).toEqual([]);
    } finally {
      await restarted.close();
    }
  } finally {
    await app.close();
  }
}, 30_000);

it('[AC-B2-06f#24] payout.enabled=off 且 queue_paused=true：已发出转账的 PAYING 单仍由注册的 query handler 用 start 返回的通道查询并投递下一查询点；未发出转账的单 transfer 只发复核、release 锁内再复核 W9、不发送', async () => {
  const app = await assemble('payout');
  try {
    const result = started(app.runtime()).start({ mode: 'dry_run' });
    const [handler] = app.payoutHandlers();
    expect(handler).toBeTypeOf('function');

    const sentId = 'wd-b2-06f-query-1';
    const sentOutBizNo = 'B206FQUERY0001';
    const unsentId = 'wd-b2-06f-query-2';
    const rows = new Map<string, Record<string, unknown>>([
      [sentId, paying(sentId, sentOutBizNo)],
      [unsentId, paying(unsentId, 'B206FQUERY0002')],
    ]);
    // Payout switched off and the queue paused (BR-WDR-17): queries go on, transfers stop.
    const config = new Map<string, unknown>([
      ['payout.enabled', false],
      ['payout.queue_paused', true],
    ]);
    // The sent withdrawal's transfer attempt was written 2 minutes ago (T); the schedule is the
    // default. The unsent one has no attempt.
    const transferAt = new Date(Date.parse(START) - 2 * MINUTE);
    app.respond((s) => {
      if (readsWithdrawals(s)) return withdrawalRow(s, rows);
      if (isSelect(s) && s.sql.includes('"payout_attempts"')) {
        return s.parameters.includes(sentId)
          ? [{ first_at: transferAt, id: 'attempt-b2-06f-transfer' }]
          : [];
      }
      return configRow(s, config);
    });

    await handler!(job('query', { withdrawal_id: sentId, execute_seq: 1, app_id: APP, point: 0 }));

    expect(app.msgs()).not.toContain('payout_query_no_channel');
    expect(app.msgs()).not.toContain('payout_query_skipped');
    const calls = (result.channels.alipay as FakeChannel).calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toEqual(calls.map(() => ({ kind: 'query', outBizNo: sentOutBizNo })));
    expect(app.statements.filter(insertsAttempt)).toHaveLength(calls.length);
    const nextQueries = app.sends.mock.calls
      .filter((call) => call[0] === 'payout' && call[1] === 'query')
      .map((call) => call[2]);
    expect(nextQueries).toEqual([{ withdrawal_id: sentId, execute_seq: 1, app_id: APP, point: 1 }]);

    const queried = calls.length;
    // The release reaches the payout process although the switches are off (turned off after the
    // worker's review): its re-check inside the payout_daily lock is W9 payout_disabled.
    await transferThenRelease(app, handler!, unsentId);
    expect(heldPairs(app)).toEqual([[unsentId, 'payout_disabled']]);
    expect(calls).toHaveLength(queried);
    expect(calls.filter((call) => call.kind === 'transfer')).toEqual([]);
    expect(app.statements.filter(insertsAttempt)).toHaveLength(queried);
  } finally {
    await app.close();
  }
}, 30_000);
