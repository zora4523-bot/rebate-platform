// B2-06f acceptance (编排裁定 D10-398; 规划/08 BR-WDR-13 ③ ④, BR-WDR-05, BR-WDR-17, BR-WDR-28;
// ADR-0002: couli_payout reads no business table it was not granted). Real PostgreSQL through the
// B2-06d process kit (process/kit.ts): the payout process's transfer handler runs on couli_payout,
// the worker's review and pause handlers on couli_app.
//   ① BR-WDR-13 ③ is two-step. The transfer job (queue `payout`, job `transfer`) past ① ② sends no
//      SQL on users or account_balances and writes no config_items / config_item_versions; it
//      enqueues one `review` job on `payout-review` { app_id, withdrawal_id, execute_seq }. The
//      worker's review (payout_disabled → queue_paused → channel_disabled → member_blocked) does W9
//      on the first failing check, else enqueues one `release` back on `payout` (key carries
//      withdrawal_id and execute_seq). The release re-checks inside the payout_daily lock (①,
//      payout_disabled / queue_paused / channel_disabled, single_cap / daily_cap) before ④ ⑤.
//   ② Payer side: W9 payer_side_after_transfer commits on the payout process's own transaction even
//      when the `pause` job cannot be sent; no query; the app is paused in process at once.
// config_items reads stay allowed (couli_payout SELECT, 0010:95): the release must read the switches.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type {
  JobHandler,
  JobPayload,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { createTransferJob } from '../../../../apps/api/src/modules/payout/jobs/transfer-job.ts';
import {
  ALERT,
  NOW,
  PAYER_SIDE_STEP,
  SINGLE_CAP,
  TIMEOUT,
  UNLISTED_STEP,
  attempts,
  close,
  configOf,
  dailyLockFree,
  expectQueryJob,
  jobs,
  negativeJobs,
  onPayoutRole,
  open,
  pauseFirstRead,
  queryJobs,
  reachedBefore,
  scripted,
  setup,
  successStep,
  withdrawal,
  type Harness,
  type ProcessFixture,
  type ScriptedChannel,
  type Seeded,
} from '../process/kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** The couli_payout handle with every compiled statement recorded (raw sql included). */
function recorded(db: Kysely<DB>) {
  const statements: string[] = [];
  const compiler = new PostgresQueryCompiler();
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      statements.push(compiler.compileQuery(args.node, args.queryId).sql);
      return args.node;
    },
    transformResult: async (args) => args.result,
  };
  return { db: db.withPlugin(plugin), statements };
}

/** Statements of the payout process that touch what D10-326 / D10-398 keep out of it. */
function forbidden(statements: readonly string[]): string[] {
  return statements.filter(
    (text) =>
      /"users"|\busers\b/i.test(text) ||
      /account_balances/i.test(text) ||
      /^\s*(insert|update|delete)\b[^;]*\bconfig_item(s|_versions)\b/i.test(text),
  );
}

/** The transfer handler of the payout process alone, on a recorded couli_payout handle. */
function payoutHandler(f: ProcessFixture, ch: ScriptedChannel, extra: object = {}) {
  const rec = recorded(f.h.payout);
  const handler = createTransferJob({
    ...f.options,
    db: rec.db,
    attemptsDb: rec.db,
    channels: { alipay: ch.channel, bank_card: ch.channel },
    ...extra,
  });
  return { handler: onPayoutRole(handler), statements: rec.statements };
}

function transferJob(w: Seeded, name = 'transfer'): ReceivedJob {
  return Object.freeze({
    id: `job-${name}-${w.id}`,
    queue: name === 'review' ? 'payout-review' : 'payout',
    name,
    payload: { app_id: w.appId, withdrawal_id: w.id, execute_seq: w.executeSeq },
    attempt: 1,
  });
}

interface QueuedRow {
  id: string;
  singleton_key: string | null;
  data: { name: string; payload: JobPayload };
}

/** Created job rows of this app on `queue` with job name `name`. */
async function queued(f: ProcessFixture, queue: string, name: string): Promise<QueuedRow[]> {
  const result = await sql<QueuedRow>`
    SELECT id::text AS id, singleton_key, data FROM pgboss.job
    WHERE name = ${queue} AND state = 'created' AND data->>'name' = ${name}
      AND data->'payload'->>'app_id' = ${f.appId}
    ORDER BY created_on, id`.execute(f.h.observer);
  return result.rows;
}

/** Runs and deletes each created `name` job of this app on `queue` through `handler`. */
async function runQueued(f: ProcessFixture, queue: string, name: string, handler: JobHandler) {
  const rows = await queued(f, queue, name);
  for (const row of rows) {
    await sql`DELETE FROM pgboss.job WHERE name = ${queue} AND id = ${row.id}::uuid`.execute(
      f.h.observer,
    );
    await handler(
      Object.freeze({
        id: row.id,
        queue,
        name: row.data.name,
        payload: row.data.payload,
        attempt: 1,
      }),
    );
  }
  return rows.length;
}

function expectKeyed(rows: readonly QueuedRow[], w: Seeded) {
  expect(rows).toHaveLength(1);
  expect(rows[0]!.data.payload).toMatchObject({
    app_id: w.appId,
    withdrawal_id: w.id,
    execute_seq: w.executeSeq,
  });
  expect(rows[0]!.singleton_key).toEqual(expect.stringContaining(w.id));
  expect(rows[0]!.singleton_key).toEqual(expect.stringContaining(String(w.executeSeq)));
}

async function expectHeldBy(f: ProcessFixture, w: Seeded, reason: string, ch: ScriptedChannel) {
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'APPROVED',
    hold_reason: reason,
    hold_at: NOW,
    executor_id: null,
    executed_at: null,
    execute_seq: w.executeSeq,
  });
  expect(ch.transfers()).toEqual([]);
  expect(await attempts(f, w.id)).toEqual([]);
  expect(queryJobs(await jobs(f))).toEqual([]);
}

it.each([
  { label: '会员风控 frozen', blocked: true },
  { label: '会员正常', blocked: false },
])(
  '[AC-B2-06f#25] transfer 在 couli_payout 上只过 ① ② 并发一条 review（$label）：不对 users / account_balances 发 SQL、不写 config_items；release 同样不碰；会员被阻断时由 worker W9 member_blocked、不转账、不写尝试',
  async ({ blocked }) => {
    const f = await setup(h);
    const w = await f.seedWithdrawal({ net: 900n });
    if (blocked) f.risk.set(w.userId, { state: 'frozen', frozen_until: null });
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const payout = payoutHandler(f, ch);
    const review = f.reviewJob();
    const before = await withdrawal(f, w.id);

    await expect(payout.handler(transferJob(w))).resolves.toBeUndefined();
    expect(forbidden(payout.statements)).toEqual([]);
    expect(await withdrawal(f, w.id)).toEqual(before);
    expect(await attempts(f, w.id)).toEqual([]);
    expect(ch.transfers()).toEqual([]);
    expectKeyed(await queued(f, 'payout-review', 'review'), w);

    expect(await runQueued(f, 'payout-review', 'review', review)).toBe(1);
    if (blocked) {
      await expectHeldBy(f, w, 'member_blocked', ch);
      expect(negativeJobs(await jobs(f))).toHaveLength(1);
      expect(await queued(f, 'payout', 'release')).toEqual([]);
      return;
    }
    expectKeyed(await queued(f, 'payout', 'release'), w);
    expect(await runQueued(f, 'payout', 'release', payout.handler)).toBe(1);
    expect(forbidden(payout.statements)).toEqual([]);
    expect(ch.transfers()).toHaveLength(1);
    expect(await attempts(f, w.id)).toEqual([
      expect.objectContaining({ kind: 'transfer', result: 'success' }),
    ]);
  },
);

it.each([
  { label: 'payout.enabled=off', reason: 'payout_disabled', key: 'payout.enabled', value: false },
  {
    label: 'payout.queue_paused=on',
    reason: 'queue_paused',
    key: 'payout.queue_paused',
    value: true,
  },
  {
    label: 'payout.channel_paused.alipay=on',
    reason: 'channel_disabled',
    key: 'payout.channel_paused.alipay',
    value: true,
  },
  { label: '会员 frozen', reason: 'member_blocked', key: null, value: null },
])(
  '[AC-B2-06f#26] worker review：$label → W9 hold_reason=$reason，不发 release、不转账',
  async ({ reason, key, value }) => {
    const f = await setup(h);
    const w = await f.seedWithdrawal({ net: 900n });
    if (key === null) f.risk.set(w.userId, { state: 'frozen', frozen_until: null });
    else await f.set(key, value);
    const ch = scripted({});
    const review = f.reviewJob();
    await expect(review(transferJob(w, 'review'))).resolves.toBeUndefined();
    await expectHeldBy(f, w, reason, ch);
    expect(await queued(f, 'payout', 'release')).toEqual([]);
  },
);

it('[AC-B2-06f#26] worker review：payout 关停且会员被阻断 → 按 08 ③ 顺序 W9 payout_disabled；全过 → 恰一条 release（去重键含 withdrawal_id、execute_seq，重投 review 不再多一条），单据不动；execute_seq 不符 → 什么都不写', async () => {
  const f = await setup(h);
  const review = f.reviewJob();
  const first = await f.seedWithdrawal({ net: 900n });
  const ch = scripted({});

  const owner = await f.newUser();
  const both = await f.seedWithdrawal({ userId: owner, net: 900n });
  f.risk.set(owner, { state: 'frozen', frozen_until: null });
  await f.set('payout.enabled', false);
  await review(transferJob(both, 'review'));
  await expectHeldBy(f, both, 'payout_disabled', ch);
  await f.set('payout.enabled', true);

  const before = await withdrawal(f, first.id);
  await review(transferJob(first, 'review'));
  await review(Object.freeze({ ...transferJob(first, 'review'), id: 'again', attempt: 2 }));
  expectKeyed(await queued(f, 'payout', 'release'), first);
  expect(await withdrawal(f, first.id)).toEqual(before);
  expect(await attempts(f, first.id)).toEqual([]);

  const stale = await f.seedWithdrawal({ net: 900n, executeSeq: 2 });
  const staleBefore = await withdrawal(f, stale.id);
  await review(
    Object.freeze({
      ...transferJob(stale, 'review'),
      payload: { app_id: stale.appId, withdrawal_id: stale.id, execute_seq: 1 },
    }),
  );
  expect(await withdrawal(f, stale.id)).toEqual(staleBefore);
  expect(
    (await queued(f, 'payout', 'release')).filter(
      (row) => row.data.payload['withdrawal_id'] === stale.id,
    ),
  ).toEqual([]);
});

it.each([
  { label: 'payout.enabled=off', reason: 'payout_disabled' },
  { label: 'payout.queue_paused=on', reason: 'queue_paused' },
  { label: 'payout.channel_enabled.alipay=off', reason: 'channel_disabled' },
  { label: 'payout.single_cap_fen 899 < 900', reason: 'single_cap' },
  { label: '当日已发出 200 + 本单 900 > payout.daily_cap_fen 1000', reason: 'daily_cap' },
])(
  '[AC-B2-06f#27] review 通过后、release 之前 $label：release 在 payout_daily 锁内再复核 → W9 hold_reason=$reason，不写尝试、不转账',
  async ({ reason }) => {
    const f = await setup(h);
    const w = await f.seedWithdrawal({ net: 900n });
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const payout = payoutHandler(f, ch);
    await payout.handler(transferJob(w));
    await runQueued(f, 'payout-review', 'review', f.reviewJob());
    expectKeyed(await queued(f, 'payout', 'release'), w);
    if (reason === 'payout_disabled') await f.set('payout.enabled', false);
    if (reason === 'queue_paused') await f.set('payout.queue_paused', true);
    if (reason === 'channel_disabled') await f.set('payout.channel_enabled.alipay', false);
    if (reason === 'single_cap') await f.set('payout.single_cap_fen', 899);
    if (reason === 'daily_cap') {
      await f.set('payout.daily_cap_fen', 1000);
      await f.seedSent({ net: 200n, result: 'pending', at: NOW });
    }
    expect(await runQueued(f, 'payout', 'release', payout.handler)).toBe(1);
    await expectHeldBy(f, w, reason, ch);
    expect(forbidden(payout.statements)).toEqual([]);
  },
);

it('[AC-B2-06f#27] release 读 payout.queue_paused 时 payout_daily 锁已被持有（锁内复核）', async () => {
  const f = await setup(h);
  const w = await f.seedWithdrawal({ net: 900n });
  const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
  const plain = payoutHandler(f, ch);
  await plain.handler(transferJob(w));
  await runQueued(f, 'payout-review', 'review', f.reviewJob());
  const paused = pauseFirstRead(f, 'payout.queue_paused');
  const gated = payoutHandler(f, ch, { config: paused.config });
  const run = runQueued(f, 'payout', 'release', gated.handler);
  run.catch(() => undefined);
  let reached = false;
  let held = false;
  try {
    reached = await reachedBefore(paused.inside, run);
    if (reached) held = !(await dailyLockFree(f));
  } finally {
    paused.resume.open();
  }
  await expect(run).resolves.toBe(1);
  expect(reached).toBe(true);
  expect(held).toBe(true);
  expect(ch.transfers()).toHaveLength(1);
});

it.each([
  { label: '付款方侧失败（payer_side_codes 内）', step: PAYER_SIDE_STEP, payer: true },
  { label: '清单外业务码（未知并暂停）', step: UNLISTED_STEP, payer: false },
])(
  '[AC-B2-06f#28] $label 且 pause 任务发不出：结果已提交（付款方侧 W9 payer_side_after_transfer、不转查询；未知仍投首个查询）、告警；进程内立即暂停，下一单 release W9 queue_paused 不发送；库里 queue_paused 仍为 false',
  async ({ step, payer }) => {
    const f = await setup(h);
    const owner = await f.newUser(5_000n);
    const w = await f.seedWithdrawal({ userId: owner, net: 800n });
    const next = await f.seedWithdrawal({ userId: owner, net: 700n });
    const ch = scripted({
      [w.outBizNo]: [step],
      [next.outBizNo]: [successStep(`CH${next.outBizNo}`)],
    });
    const failing = vi.fn(async (...args: Parameters<typeof f.send>) => {
      if (args[0] === 'payout-landing' && args[1] === 'pause') {
        throw new Error('synthetic: pause job not sent');
      }
      return f.send(...args);
    });
    const handler = f.rawJob(ch.channel, { queue: { send: failing } });

    await handler(f.jobOf(w)).catch(() => undefined);
    expect(
      failing.mock.calls.filter((call) => call[0] === 'payout-landing' && call[1] === 'pause'),
    ).not.toEqual([]);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
    if (payer) {
      expect(await withdrawal(f, w.id)).toMatchObject({
        status: 'APPROVED',
        hold_reason: 'payer_side_after_transfer',
        hold_at: NOW,
      });
      expect(await attempts(f, w.id)).toEqual([
        expect.objectContaining({
          kind: 'transfer',
          result: 'fail',
          resp_sub_code: 'TEST_PAYER_SIDE',
        }),
      ]);
      expect(queryJobs(await jobs(f))).toEqual([]);
    } else {
      expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', hold_reason: null });
      expect(await attempts(f, w.id)).toEqual([
        expect.objectContaining({ kind: 'transfer', result: 'unknown' }),
      ]);
      expectQueryJob(await jobs(f), w);
    }
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        withdrawal_id: w.id,
        cause: payer ? 'payer_side' : 'unknown_code',
      }),
      ALERT,
    );

    await handler(f.jobOf(next)).catch(() => undefined);
    expect(await withdrawal(f, next.id)).toMatchObject({
      status: 'APPROVED',
      hold_reason: 'queue_paused',
    });
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
    expect(await attempts(f, next.id)).toEqual([]);
    expect(await configOf(f, 'payout.queue_paused')).toBe(false);
    expect(f.pause).not.toHaveBeenCalled();
  },
);

/** payout.queue_paused of this app with its config version (PG, observer). */
async function queuePausedRow(f: ProcessFixture): Promise<{ value: unknown; version: number }> {
  const result = await sql<{ value: unknown; version: number }>`
    SELECT value, version FROM app.config_items
    WHERE app_id = ${f.appId} AND key = 'payout.queue_paused'`.execute(f.h.observer);
  const row = result.rows[0];
  if (row === undefined) throw new Error('no payout.queue_paused row');
  return { value: row.value, version: Number(row.version) };
}

/** A withdrawal the release held on the in-process pause: W9 queue_paused, nothing sent. */
async function expectPausedInProcess(f: ProcessFixture, w: Seeded) {
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'APPROVED',
    hold_reason: 'queue_paused',
    hold_at: NOW,
    executor_id: null,
    executed_at: null,
  });
  expect(await attempts(f, w.id)).toEqual([]);
}

it('[AC-B2-06f#29] 付款方异常 → 进程内暂停，worker 落库前下一单 release W9 queue_paused → worker 消费 pause 任务，库里 payout.queue_paused=true（版本 +1）→ 管理员解除（false，版本再 +1）→ 同一 payout 进程不重启再执行新的一单：review 通过、release 照常发出（调用通道、写尝试），不 W9 queue_paused', async () => {
  const f = await setup(h);
  const owner = await f.newUser(5_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 800n });
  const held = await f.seedWithdrawal({ userId: owner, net: 700n });
  const after = await f.seedWithdrawal({ userId: owner, net: 600n });
  const ch = scripted({
    [w.outBizNo]: [PAYER_SIDE_STEP],
    [held.outBizNo]: [successStep(`CH${held.outBizNo}`)],
    [after.outBizNo]: [successStep(`CH${after.outBizNo}`)],
  });
  // One payout process: the same transfer handler instance for every job below.
  const handler = f.rawJob(ch.channel);
  const start = await queuePausedRow(f);
  expect(start.value).toBe(false);

  // (a) payer side: W9 payer_side_after_transfer, paused in process, pause job left for the worker.
  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'APPROVED',
    hold_reason: 'payer_side_after_transfer',
  });
  expect(await queued(f, 'payout-landing', 'pause')).toHaveLength(1);
  await expect(handler(f.jobOf(held))).resolves.toBeUndefined();
  await expectPausedInProcess(f, held);
  expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
  expect(await queuePausedRow(f)).toEqual(start);

  // (b) the worker persists the pause: payout.queue_paused = true, version + 1.
  expect(await runQueued(f, 'payout-landing', 'pause', f.pauseJob())).toBe(1);
  expect(f.pause).toHaveBeenCalledTimes(1);
  expect(await queuePausedRow(f)).toEqual({ value: true, version: start.version + 1 });

  // (c) an admin releases the pause: payout.queue_paused = false, version + 1 again.
  await f.set('payout.queue_paused', false);
  expect(await queuePausedRow(f)).toEqual({ value: false, version: start.version + 2 });

  // (d) the same process, not restarted: the next withdrawal is reviewed and released as usual.
  await expect(handler(f.jobOf(after))).resolves.toBeUndefined();
  expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo, after.outBizNo]);
  expect(await attempts(f, after.id)).toEqual([
    expect.objectContaining({ kind: 'transfer', result: 'success' }),
  ]);
  expect(await withdrawal(f, after.id)).toMatchObject({ status: 'PAYING', hold_reason: null });
  expect(await queuePausedRow(f)).toEqual({ value: false, version: start.version + 2 });
});

it('[AC-B2-06f#30] 对照：付款方异常进程内暂停后 pause 任务未被消费（库里 payout.queue_paused 仍 false、版本未变；别的配置项改版本不算）→ 进程内标记保持，之后每一单 release 仍 W9 queue_paused，不调用通道、不写尝试', async () => {
  const f = await setup(h);
  const owner = await f.newUser(5_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 800n });
  const first = await f.seedWithdrawal({ userId: owner, net: 700n });
  const second = await f.seedWithdrawal({ userId: owner, net: 600n });
  const ch = scripted({
    [w.outBizNo]: [PAYER_SIDE_STEP],
    [first.outBizNo]: [successStep(`CH${first.outBizNo}`)],
    [second.outBizNo]: [successStep(`CH${second.outBizNo}`)],
  });
  const handler = f.rawJob(ch.channel);
  const start = await queuePausedRow(f);
  expect(start.value).toBe(false);

  await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'APPROVED',
    hold_reason: 'payer_side_after_transfer',
  });
  await expect(handler(f.jobOf(first))).resolves.toBeUndefined();
  await expectPausedInProcess(f, first);

  await f.set('payout.single_cap_fen', SINGLE_CAP);
  await expect(handler(f.jobOf(second))).resolves.toBeUndefined();
  await expectPausedInProcess(f, second);

  expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
  expect(await queuePausedRow(f)).toEqual(start);
  expect(await queued(f, 'payout-landing', 'pause')).toHaveLength(1);
  expect(f.pause).not.toHaveBeenCalled();
});
