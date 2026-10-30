// B2-07e W11 rule tests, the guard (claude-independent, SPEC_REF 37808a50): 规划/08 BR-WDR-08 W11
// guard (hold_reason=payer_side_after_transfer；该单唯一的转账尝试 result=fail；含该 out_biz_no 的
// 账单行，金额 = net_fen；开关 payout.proven_success_writeoff.enabled=on) and its order of task
// §9.2: switch off → writeoff_disabled before anything else; not APPROVED (or not this app's) →
// 20902 resource=withdrawal (WithdrawalConflictError); then withdrawal_not_returned,
// transfer_attempts_mismatch, not_payer_side_case, amount_mismatch. A refusal writes nothing:
// withdrawal, attempts, vouchers, balances, events and the job queue stay as they were.
// W11's port runs on a real PostgreSQL (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WithdrawalConflictError } from '../../../../apps/api/src/modules/payout/application/withdrawal-commands.ts';
import {
  SWITCH,
  TIMEOUT,
  close,
  expectWithdrawalConflict,
  open,
  setup,
  type Harness,
  type SeedStatus,
  type Seeded,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-07e#6] 开关 payout.proven_success_writeoff.enabled=false → refused writeoff_disabled，先于其他一切判断（单已是终态也一样）；什么都不写、不入队',
  async () => {
    const f = await setup(h);
    await f.set(SWITCH, false);
    const port = f.port();
    const returned = await f.seed();
    const paid = await f.seed({ status: 'PAID_API' });
    const before = await f.snapshot();

    for (const w of [returned, paid]) {
      expect(await f.prove(f.input(w), port)).toEqual({
        kind: 'refused',
        reason: 'writeoff_disabled',
      });
    }

    expect(await f.snapshot()).toEqual(before);
    expect(f.sent).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#7] 单不是 APPROVED（PENDING_REVIEW / PAYING / PAID_API / FAILED / REJECTED）、单不存在或属于别的应用 → 抛 WithdrawalConflictError（20902 resource=withdrawal）；终态单不改状态或金额，什么都不写',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const statuses: SeedStatus[] = ['PENDING_REVIEW', 'PAYING', 'PAID_API', 'FAILED', 'REJECTED'];
    const rows: Seeded[] = [];
    for (const status of statuses) rows.push(await f.seed({ status }));
    const other = await setup(h);
    const foreign = await other.seed();
    const before = await f.snapshot();
    const foreignBefore = await other.snapshot();

    for (const w of rows) await expectWithdrawalConflict(f.prove(f.input(w), port));
    await expectWithdrawalConflict(
      f.prove(f.input(rows[0]!, { withdrawalId: randomUUID() }), port),
    );
    await expectWithdrawalConflict(f.prove(f.input(foreign, { appId: f.appId }), port));
    let caught: unknown;
    try {
      await f.prove(f.input(rows[1]!), port);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WithdrawalConflictError);

    expect(await f.snapshot()).toEqual(before);
    expect(await other.snapshot()).toEqual(foreignBefore);
    expect(f.sent).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#8] APPROVED 但不是付款方侧退回（hold_reason 为空或别的暂停原因）→ refused withdrawal_not_returned；什么都不写',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const plain = await f.seed({ holdReason: null });
    const paused = await f.seed({ holdReason: 'queue_paused' });
    const before = await f.snapshot();

    for (const w of [plain, paused]) {
      expect(await f.prove(f.input(w), port)).toEqual({
        kind: 'refused',
        reason: 'withdrawal_not_returned',
      });
    }

    expect(await f.snapshot()).toEqual(before);
    expect(f.sent).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#9] 转账尝试不是「恰一条且 result=fail」（没有；只有失败的查询记录、没有转账；一条 success / unknown / pending，带不带查询记录）→ refused transfer_attempts_mismatch；什么都不写（每单至多一条转账由 payout_attempts_transfer_once_key 保证，造不出两条）',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const seeds = [
      await f.seed({ attempts: [] }),
      await f.seed({ attempts: [['query', 'fail']] }),
      await f.seed({ attempts: [['transfer', 'success']] }),
      await f.seed({ attempts: [['transfer', 'unknown']] }),
      await f.seed({ attempts: [['transfer', 'pending']] }),
      await f.seed({
        attempts: [
          ['transfer', 'unknown'],
          ['query', 'fail'],
        ],
      }),
    ];
    const before = await f.snapshot();

    for (const w of seeds) {
      expect(await f.prove(f.input(w), port)).toEqual({
        kind: 'refused',
        reason: 'transfer_attempts_mismatch',
      });
    }

    expect(await f.snapshot()).toEqual(before);
    expect(f.sent).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#10] 账单行的 out_biz_no 不是这张单的（别的单号、没有单号）→ refused not_payer_side_case；账单金额 ≠ net_fen（多 1 分、少 1 分、等于含费税的总额）→ refused amount_mismatch；什么都不写',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed({ net: 1000n, fee: 30n, tax: 20n });
    const another = await f.seed();
    const before = await f.snapshot();

    for (const outBizNo of [another.outBizNo, null]) {
      expect(await f.prove(f.input(w, { billLine: { outBizNo } }), port)).toEqual({
        kind: 'refused',
        reason: 'not_payer_side_case',
      });
    }
    for (const expectedFen of [w.net + 1n, w.net - 1n, w.amount]) {
      expect(await f.prove(f.input(w, { expectedFen }), port)).toEqual({
        kind: 'refused',
        reason: 'amount_mismatch',
      });
    }

    expect(await f.snapshot()).toEqual(before);
    expect(f.sent).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#11] 判断顺序：不是退回单先于尝试与账单行（withdrawal_not_returned）；尝试不符先于账单行（transfer_attempts_mismatch）；单号不符先于金额（not_payer_side_case）',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const notReturned = await f.seed({ holdReason: null, attempts: [] });
    const noAttempt = await f.seed({ attempts: [] });
    const w = await f.seed();

    expect(
      await f.prove(f.input(notReturned, { billLine: { outBizNo: null }, expectedFen: 1n }), port),
    ).toEqual({ kind: 'refused', reason: 'withdrawal_not_returned' });
    expect(
      await f.prove(f.input(noAttempt, { billLine: { outBizNo: null }, expectedFen: 1n }), port),
    ).toEqual({ kind: 'refused', reason: 'transfer_attempts_mismatch' });
    expect(
      await f.prove(f.input(w, { billLine: { outBizNo: null }, expectedFen: 1n }), port),
    ).toEqual({ kind: 'refused', reason: 'not_payer_side_case' });
    expect(f.sent).toEqual([]);
  },
  TIMEOUT,
);
