// B1-03z: commission's shares port is injected by the worker assembly (RiskScanModule.forWorker),
// never imported by risk itself (规划/02 §4.1: no reading another module's tables). A handler built
// without it must not guess: a revoked ban appeal rejects (queue retry, then dead letter) and
// nothing is written. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAppealRestoreHandler } from '../../../../apps/api/src/modules/risk/application/appeal-restore.ts';
import { openSuite, scenario, type Suite } from './db-kit.ts';
import { IN_BAN_1 } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

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
