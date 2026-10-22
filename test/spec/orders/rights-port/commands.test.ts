// BR-FUND-06 + B1-09c §2: only orders' command boundary; settlement guards/writes are B2-04l.
import { expect, it, vi } from 'vitest';
import {
  adminHoldOrder,
  adminUnholdOrder,
  recordOrderRights,
  type OrderRightsPorts,
  type RightsRecordInput,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { capture, database, holdInput, order, ports, rightsInput } from './kit.ts';

it.each(['applied', 'duplicate', 'not_applicable'] as const)(
  '[AC-B1-09c#1] rights.record 的 %s 结果原样返回，复用事务与写前快照且不自行写库',
  async (kind) => {
    const result = Object.freeze({ kind });
    const f = ports(result);
    const d = database();
    const input = Object.freeze(rightsInput());
    const saved = structuredClone(input);
    await d.db.transaction().execute(async (trx) => {
      expect(await recordOrderRights(trx, f.injected, input)).toEqual(result);
      expect(f.record).toHaveBeenCalledExactlyOnceWith(trx, input);
      expect(f.record.mock.calls[0]?.[0]).toBe(trx);
      expect(f.record.mock.calls[0]?.[1].before).toBe(input.before);
    });
    expect(input).toEqual(saved);
    expect(d.statements).toEqual([]);
    expect(f.adminHold).not.toHaveBeenCalled();
    expect(f.adminUnhold).not.toHaveBeenCalled();
  },
);

it.each([
  { source: 'API', type: 'RIGHTS', status: 'PROCESSING', platform_rights_no: 'rights-a' },
  { source: 'IMPORT', type: 'RIGHTS', status: 'WAIT_COMMISSION', platform_rights_no: 'rights-a' },
  { source: 'IMPORT', type: 'PUNISH', status: 'SUCCEEDED', platform_rights_no: 'rights-a' },
  { source: 'API', type: 'RIGHTS', status: 'FAILED', platform_rights_no: null },
  { source: 'API', type: 'INVALID_AFTER_SETTLE', status: 'SUCCEEDED', platform_rights_no: null },
  { source: 'IMPORT', type: 'REFUND_AFTER_SETTLE', status: 'SUCCEEDED', platform_rights_no: 'r-b' },
] satisfies Partial<RightsRecordInput>[])(
  '[AC-B1-09c#2] $source/$type/$status 及可空平台维权号完整交给 settlement，不改写去重字段',
  async (patch) => {
    const f = ports();
    const d = database();
    const input = rightsInput(patch);
    await d.db.transaction().execute(async (trx) => {
      expect(await recordOrderRights(trx, f.injected, input)).toEqual({ kind: 'applied' });
    });
    expect(f.record.mock.calls[0]?.[1]).toEqual(input);
    expect(input.occurred_at).not.toEqual(input.now);
    expect(d.statements).toEqual([]);
  },
);

it.each([
  { amount_fen: null, deduction_commission_fen: null },
  { amount_fen: 0n, deduction_commission_fen: 0n },
  { amount_fen: 9007199254740993n, deduction_commission_fen: 9007199254740995n },
] satisfies Partial<RightsRecordInput>[])(
  '[AC-B1-09c#3] 金额不丢精度，null 不补零也不推算佣金：$amount_fen/$deduction_commission_fen',
  async (patch) => {
    const f = ports();
    const d = database();
    const input = rightsInput(patch);
    await d.db.transaction().execute(async (trx) => {
      expect(await recordOrderRights(trx, f.injected, input)).toEqual({ kind: 'applied' });
    });
    expect(f.record.mock.calls[0]?.[1]).toEqual(input);
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(d.statements).toEqual([]);
  },
);

const adminCommands = [
  { name: 'adminHold', run: adminHoldOrder },
  { name: 'adminUnhold', run: adminUnholdOrder },
] as const;

it.each(
  adminCommands.flatMap((command) =>
    (['applied', 'not_applicable', 'same_state', 'cas_conflict'] as const).map((kind) => ({
      ...command,
      kind,
    })),
  ),
)(
  '[AC-B1-09c#4] $name/$kind 不合并结果、不重试、不另写 history 或返利状态',
  async ({ name, run, kind }) => {
    const result = Object.freeze({ kind });
    const f = ports({ kind: 'applied' }, result);
    const d = database();
    const input = Object.freeze(holdInput());
    const saved = structuredClone(input);
    await d.db.transaction().execute(async (trx) => {
      expect(await run(trx, f.injected, input)).toEqual(result);
      expect(f[name]).toHaveBeenCalledExactlyOnceWith(trx, input);
      expect(f[name].mock.calls[0]?.[0]).toBe(trx);
      expect(f[name].mock.calls[0]?.[1].before).toBe(input.before);
    });
    expect(input).toEqual(saved);
    expect(f.record).not.toHaveBeenCalled();
    expect(f[name === 'adminHold' ? 'adminUnhold' : 'adminHold']).not.toHaveBeenCalled();
    expect(d.statements).toEqual([]);
  },
);

it.each(adminCommands)(
  '[AC-B1-09c#5] $name 逐次传入当前锁内快照、原始 CAS 版本及审计原因，不缓存旧快照',
  async ({ name, run }) => {
    const f = ports();
    const d = database();
    const first = holdInput({ reason_code: 'CS', reason: '客服首次核对' });
    const second = holdInput({
      before: Object.freeze(order({ row_version: 21, hold: true, hold_reason: 'UNMAPPED_STATUS' })),
      expected_row_version: 20,
      actor: '019a0000-0000-7000-8000-000000000004',
      reason_code: 'RISK',
      reason: '风控复核说明',
      ip: null,
    });
    await d.db.transaction().execute(async (trx) => {
      expect(await run(trx, f.injected, first)).toEqual({ kind: 'applied' });
      expect(await run(trx, f.injected, second)).toEqual({ kind: 'applied' });
      expect(f[name].mock.calls).toEqual([
        [trx, first],
        [trx, second],
      ]);
      expect(f[name].mock.calls[1]?.[1].before).toBe(second.before);
    });
    expect(d.statements).toEqual([]);
  },
);

it.each([undefined, {}] satisfies (OrderRightsPorts | undefined)[])(
  '[AC-B1-09c#6] 无 rights.record 注入时明确失败，订单、维权、历史、审计都不写：%j',
  async (injected) => {
    const d = database();
    const input = rightsInput();
    const saved = structuredClone(input);
    const result = await capture(() =>
      d.db.transaction().execute((trx) => recordOrderRights(trx, injected, input)),
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
    if (!result.ok) {
      expect(result.error).toHaveProperty(
        'message',
        'ORDERS_RIGHTS_PORT_UNAVAILABLE: rights.record',
      );
    }
    expect(input).toEqual(saved);
    expect(d.statements).toEqual([]);
  },
);

it.each(
  adminCommands.flatMap((c) =>
    ['none', 'empty', 'other-only'].map((missing) => ({ ...c, missing })),
  ),
)(
  '[AC-B1-09c#7] $name 缺失（$missing）不走另一个命令，也不直接写库',
  async ({ name, run, missing }) => {
    const f = ports();
    const d = database();
    const injected: OrderRightsPorts | undefined =
      missing === 'none'
        ? undefined
        : missing === 'empty'
          ? { rights: f.injected.rights!, rebate: {} }
          : {
              rights: f.injected.rights!,
              rebate:
                name === 'adminHold' ? { adminUnhold: f.adminUnhold } : { adminHold: f.adminHold },
            };
    const input = holdInput();
    const saved = structuredClone(input);
    const result = await capture(() =>
      d.db.transaction().execute((trx) => run(trx, injected, input)),
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
    if (!result.ok) {
      expect(result.error).toHaveProperty(
        'message',
        `ORDERS_RIGHTS_PORT_UNAVAILABLE: rebate.${name}`,
      );
    }
    expect(input).toEqual(saved);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.adminHold).not.toHaveBeenCalled();
    expect(f.adminUnhold).not.toHaveBeenCalled();
    expect(d.statements).toEqual([]);
  },
);

it('[AC-B1-09c#8] rights.record 故障原样抛出以供调用方回滚，不吞成 duplicate 或自动重试', async () => {
  const failure = new Error('synthetic settlement write failure');
  const f = ports();
  f.record.mockRejectedValue(failure);
  const d = database();
  const result = await capture(() =>
    d.db.transaction().execute((trx) => recordOrderRights(trx, f.injected, rightsInput())),
  );
  expect(result).toEqual({ ok: false, error: failure });
  if (!result.ok) expect(result.error).toBe(failure);
  expect(f.record).toHaveBeenCalledTimes(1);
  expect(d.statements).toEqual([]);
});

it.each(adminCommands)(
  '[AC-B1-09c#9] $name 故障原样抛出，不吞成 same_state/cas_conflict 或自动重试',
  async ({ name, run }) => {
    const failure = new Error(`synthetic ${name} audit failure`);
    const f = ports();
    f[name].mockRejectedValue(failure);
    const d = database();
    const result = await capture(() =>
      d.db.transaction().execute((trx) => run(trx, f.injected, holdInput())),
    );
    expect(result).toEqual({ ok: false, error: failure });
    if (!result.ok) expect(result.error).toBe(failure);
    expect(f[name]).toHaveBeenCalledTimes(1);
    expect(d.statements).toEqual([]);
  },
);

it.each(adminCommands)(
  '[AC-B1-09c#10] $name 保留注入对象的方法上下文，异步结果完成后才返回',
  async ({ name, run }) => {
    const d = database();
    const trace: string[] = [];
    const rebate = {
      marker: 'synthetic-settlement-instance',
      async adminHold() {
        trace.push(this.marker);
        await Promise.resolve();
        trace.push('finished');
        return { kind: 'same_state' as const };
      },
      async adminUnhold() {
        return this.adminHold();
      },
    };
    const called = vi.spyOn(rebate, name);
    await d.db.transaction().execute(async (trx) => {
      expect(await run(trx, { rebate }, holdInput())).toEqual({ kind: 'same_state' });
      expect(trace).toEqual(['synthetic-settlement-instance', 'finished']);
    });
    expect(called).toHaveBeenCalledTimes(1);
    expect(d.statements).toEqual([]);
  },
);

it('[AC-B1-09c#11] API 与 IMPORT 同键重复仍逐次交 settlement，duplicate 不被改成 applied', async () => {
  const f = ports();
  f.record.mockResolvedValueOnce({ kind: 'applied' }).mockResolvedValueOnce({ kind: 'duplicate' });
  const d = database();
  const first = rightsInput({ source: 'API', platform_rights_no: null });
  const again = rightsInput({ source: 'IMPORT', platform_rights_no: null });
  await d.db.transaction().execute(async (trx) => {
    expect(await recordOrderRights(trx, f.injected, first)).toEqual({ kind: 'applied' });
    expect(await recordOrderRights(trx, f.injected, again)).toEqual({ kind: 'duplicate' });
    expect(f.record.mock.calls).toEqual([
      [trx, first],
      [trx, again],
    ]);
  });
  expect(d.statements).toEqual([]);
});

it('[AC-B1-09c#12] rights.record 保留方法上下文并等待异步结果，不使用默认成功占位', async () => {
  const d = database();
  const trace: string[] = [];
  const rights = {
    marker: 'synthetic-rights-instance',
    async record() {
      trace.push(this.marker);
      await Promise.resolve();
      trace.push('finished');
      return { kind: 'duplicate' as const };
    },
  };
  await d.db.transaction().execute(async (trx) => {
    expect(await recordOrderRights(trx, { rights }, rightsInput())).toEqual({ kind: 'duplicate' });
    expect(trace).toEqual(['synthetic-rights-instance', 'finished']);
  });
  expect(d.statements).toEqual([]);
});
