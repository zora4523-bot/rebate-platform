// B1-03z: the producer's ports are injected by the worker assembly (RiskScanModule.forWorker),
// never imported by risk itself (规划/02 §4.1: no reading another module's tables): commission's
// shares and banned-run reads, and the ledger read of the FORFEIT voucher amount (attempt 4, funds
// review S0). A handler that lacks one it needs, or cannot get a share's forfeited amount, must not
// guess (never the snapshot estimate): a revoked ban appeal rejects (queue retry, then dead letter),
// nothing is written, and a missing amount logs `appeal_restore_amount_unavailable` at error.
// Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createAppealRestoreHandler,
  type AppealRestoreLogger,
} from '../../../../apps/api/src/modules/risk/application/appeal-restore.ts';
import { PORTS, openSuite, scenario, type Suite } from './db-kit.ts';
import { IN_BAN_1, IN_BAN_2 } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

function spyLogger() {
  const error = vi.fn<AppealRestoreLogger['error']>();
  return { logger: { error } satisfies AppealRestoreLogger, error };
}

it('[B1-03z 份额端口] 不传 shares 端口时，被撤销的封禁申诉 → 处理器拒绝（队列重试 / 死信），不写差错单、不入账、不动份额事件与申诉行', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();
  const handler = createAppealRestoreHandler({ clock: f.clock });

  await expect(
    f.db.transaction().execute((trx) => handler(f.event(appeal), trx)),
  ).rejects.toThrow();

  expect(await f.diffs()).toEqual([]);
  expect(await f.untouched()).toEqual(before);
});

it('[B1-03z 没收金额端口] 不传 FORFEIT 凭证金额端口时，被撤销且有被没收份额的封禁申诉 → 拒绝、记 error appeal_restore_amount_unavailable，不登记（不回落快照值）', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();
  const { logger, error } = spyLogger();
  const handler = createAppealRestoreHandler({
    clock: f.clock,
    shares: PORTS.shares,
    bannedRunStart: PORTS.bannedRunStart,
    logger,
  });

  await expect(
    f.db.transaction().execute((trx) => handler(f.event(appeal), trx)),
  ).rejects.toThrow();

  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ app_id: f.appId, appeal_id: appeal.id }),
    'appeal_restore_amount_unavailable',
  );
  expect(await f.diffs()).toEqual([]);
  expect(await f.untouched()).toEqual(before);
});

it('[B1-03z 没收金额端口] 两份被没收份额里一份查不到 FORFEIT 凭证（端口答 null）→ 整个事件拒绝、记 error appeal_restore_amount_unavailable，有凭证的那份也不登记', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const withVoucher = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const without = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
  await f.forfeit(withVoucher, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(without, { userId: member, role: 'direct' }, 'banned', IN_BAN_2, null);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();
  const { logger, error } = spyLogger();
  const handler = f.handler(logger);

  await expect(
    f.db.transaction().execute((trx) => handler(f.event(appeal), trx)),
  ).rejects.toThrow();

  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ app_id: f.appId, appeal_id: appeal.id }),
    'appeal_restore_amount_unavailable',
  );
  expect(await f.diffs()).toEqual([]);
  expect(await f.untouched()).toEqual(before);
});

it('[B1-03z 存量窗口端口] penalty_started_at 为空且不传 bannedRunStart 端口时，被撤销的封禁申诉 → 拒绝，不写差错单', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  const appeal = await f.appeal({ userId: member, penaltyStartedAt: null });
  const before = await f.untouched();
  const handler = createAppealRestoreHandler({
    clock: f.clock,
    shares: PORTS.shares,
    forfeitedAmount: PORTS.forfeitedAmount,
  });

  await expect(
    f.db.transaction().execute((trx) => handler(f.event(appeal), trx)),
  ).rejects.toThrow();

  expect(await f.diffs()).toEqual([]);
  expect(await f.untouched()).toEqual(before);
});
