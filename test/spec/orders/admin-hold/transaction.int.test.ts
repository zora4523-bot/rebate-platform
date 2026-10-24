import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import type { DB } from '@couli/db';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import type {
  AdminHoldInput,
  AdminHoldResult,
  OrderRightsPorts,
  RebateAdminCommandPort,
} from '../../../../apps/api/src/modules/orders/application/rights-ports.ts';
import type { AuditInput } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  CONFLICT,
  acceptable,
  fixture,
  open,
  probe,
  underForeignLock,
  type Fixture,
  type Harness,
  type Mode,
} from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

const MODES: readonly Mode[] = ['hold', 'unhold'];
type Command = RebateAdminCommandPort['adminHold'];
const portName = (mode: Mode): 'adminHold' | 'adminUnhold' =>
  mode === 'hold' ? 'adminHold' : 'adminUnhold';
/** Ports where `mode`'s command is `command` (the other one is left out). */
const only = (mode: Mode, command: Command): OrderRightsPorts => ({
  rebate: mode === 'hold' ? { adminHold: command } : { adminUnhold: command },
});

it.each(MODES)(
  '[AC-B1-09l#27] %s 在持有子订单 advisory 锁与订单行锁的同一事务里调端口；审计与端口共用该事务，入参是锁内重读的行',
  async (mode) => {
    const f = await fixture(h);
    const o = await f.order(acceptable(mode));
    const seen: { advisoryFree: boolean; rowFree: boolean }[] = [];
    f.hooks.during = async () => {
      seen.push(await probe(h.db, o));
    };
    expect(await f.run(mode, o)).toMatchObject({ code: 0 });
    expect(seen).toEqual([{ advisoryFree: false, rowFree: false }]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.input.before).toEqual(f.calls[0]?.current);
    expect(f.auditOn).toHaveBeenCalledTimes(1);
    expect(f.transactions).toHaveLength(2);
    expect(new Set(f.transactions).size).toBe(1);
    expect(f.transactions[0]?.isTransaction).toBe(true);
    // Released with the commit.
    expect(await probe(h.db, o)).toEqual({ advisoryFree: true, rowFree: true });
  },
);

it('[AC-B1-09l#28] 锁内重读：等锁期间订单已被暂停并换了 row_version → hold 返回 20902 order，端口只见到重读后的行', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const outcome = await underForeignLock(
    h.db,
    o,
    () => f.hold(o),
    async (other) => {
      await other
        .updateTable('orders')
        .set({ hold: true, hold_reason: 'RISK', row_version: o.row_version + 1 })
        .where('app_id', '=', o.app_id)
        .where('order_id', '=', o.order_id)
        .execute();
    },
  );
  expect(outcome).toEqual({ ok: true, value: CONFLICT });
  for (const call of f.calls) expect(call.input.before).toEqual(call.current);
  const after = await f.state();
  expect(after.orders[0]).toMatchObject({
    hold: true,
    hold_reason: 'RISK',
    row_version: o.row_version + 1,
  });
  expect(after.audits).toEqual([]);
});

it('[AC-B1-09l#29] 锁内重读：等锁期间同子订单新开了 UNMAPPED_STATUS 待处理记录 → unhold 返回 20902 order，不调端口', async () => {
  const f = await fixture(h);
  const o = await f.order({ hold: true, hold_reason: 'UNMAPPED_STATUS' });
  await f.pending(o, { status: 'resolved' });
  const outcome = await underForeignLock(
    h.db,
    o,
    () => f.unhold(o),
    (other) => f.pending(o, {}, other),
  );
  expect(outcome).toEqual({ ok: true, value: CONFLICT });
  expect(f.rebate.adminUnhold).not.toHaveBeenCalled();
  const after = await f.state();
  expect(after.orders).toEqual([o]);
  expect(after.pending.map((p) => p.status)).toEqual(['resolved', 'open']);
  expect(after.audits).toEqual([]);
});

type Refusal = Exclude<AdminHoldResult['kind'], 'applied'>;
const REFUSALS: readonly Refusal[] = ['not_applicable', 'same_state', 'cas_conflict'];

it.each<[Mode, Refusal]>(
  MODES.flatMap((mode) => REFUSALS.map((kind): [Mode, Refusal] => [mode, kind])),
)(
  '[AC-B1-09l#30] %s 时端口判 %s（settlement 的守卫与 CAS）→ 20902 order，不审计、什么都不写',
  async (mode, kind) => {
    const f = await fixture(h);
    const o = await f.order(acceptable(mode));
    const before = await f.state();
    const refusing = vi.fn(async (trx: Transaction<DB>): Promise<AdminHoldResult> => {
      f.transactions.push(trx);
      return { kind };
    });
    const result = await f.run(mode, o, {}, { deps: { ports: only(mode, refusing) } });
    expect(result).toEqual(CONFLICT);
    expect(refusing).toHaveBeenCalledTimes(1);
    expect(f.auditOn).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(before);
  },
);

it.each(MODES)(
  '[AC-B1-09l#31] %s 的 hold 列只经返利端口写：端口判 applied 而未写库时，orders 不自写任何列、不写 history，只记审计',
  async (mode) => {
    const f = await fixture(h);
    const o = await f.order(acceptable(mode));
    const before = await f.state();
    const silent = vi.fn(async (trx: Transaction<DB>): Promise<AdminHoldResult> => {
      f.transactions.push(trx);
      return { kind: 'applied' };
    });
    const result = await f.run(mode, o, {}, { deps: { ports: only(mode, silent) } });
    expect(result).toMatchObject({ code: 0 });
    expect(silent).toHaveBeenCalledTimes(1);
    const after = await f.state();
    expect(after.orders).toEqual(before.orders);
    expect(after.history).toEqual(before.history);
    expect(after.pending).toEqual(before.pending);
    expect(after.audits.map((a) => a.action)).toEqual([
      mode === 'hold' ? 'order_hold' : 'order_unhold',
    ]);
  },
);

it.each(MODES)(
  '[AC-B1-09l#32] %s 的端口写库后失败：原样抛出，整事务回滚，不留审计；重试照常受理',
  async (mode) => {
    const f = await fixture(h);
    const o = await f.order(acceptable(mode));
    const before = await f.state();
    const outage = new Error('synthetic settlement outage');
    const port: Command = f.rebate[portName(mode)];
    const failing = async (trx: Transaction<DB>, input: AdminHoldInput): Promise<never> => {
      await port(trx, input);
      throw outage;
    };
    await expect(f.run(mode, o, {}, { deps: { ports: only(mode, failing) } })).rejects.toBe(outage);
    expect(await f.state()).toEqual(before);
    expect(await f.run(mode, o)).toMatchObject({ code: 0 });
    expect((await f.state()).audits).toHaveLength(1);
  },
);

it.each(MODES)(
  '[AC-B1-09l#33] %s 的审计写入失败：原样抛出，端口已写的 hold 一并回滚',
  async (mode) => {
    const f = await fixture(h);
    const o = await f.order(acceptable(mode));
    const before = await f.state();
    const outage = new Error('synthetic audit outage');
    const auditOn = (trx: Transaction<DB>) => ({
      append: async (input: AuditInput) => {
        await createAuditWriter({ db: trx, clock: f.clock }).append(input);
        throw outage;
      },
    });
    await expect(f.run(mode, o, {}, { deps: { auditOn } })).rejects.toBe(outage);
    expect(f.calls).toHaveLength(1);
    expect(await f.state()).toEqual(before);
  },
);

type Missing = (f: Fixture, mode: Mode) => OrderRightsPorts | undefined;
const MISSING: readonly (readonly [string, Missing])[] = [
  ['未注入任何端口', () => undefined],
  ['未注入 rebate', () => ({})],
  ['rebate 为空', () => ({ rebate: {} })],
  [
    'rebate 只有另一个命令',
    (f, mode) => ({
      rebate:
        mode === 'hold' ? { adminUnhold: f.rebate.adminUnhold } : { adminHold: f.rebate.adminHold },
    }),
  ],
];

it.each<[Mode, string, Missing]>(
  MODES.flatMap((mode) =>
    MISSING.map(([label, ports]): [Mode, string, Missing] => [mode, label, ports]),
  ),
)(
  '[AC-B1-09l#34] %s 时返利端口缺失（%s）：抛 ORDERS_RIGHTS_PORT_UNAVAILABLE，什么都不写',
  async (mode, _label, ports) => {
    const f = await fixture(h);
    const o = await f.order(acceptable(mode));
    const before = await f.state();
    await expect(f.run(mode, o, {}, { deps: { ports: ports(f, mode) } })).rejects.toThrow(
      `ORDERS_RIGHTS_PORT_UNAVAILABLE: rebate.${portName(mode)}`,
    );
    expect(f.rebate.adminHold).not.toHaveBeenCalled();
    expect(f.rebate.adminUnhold).not.toHaveBeenCalled();
    expect(f.auditOn).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(before);
  },
);
