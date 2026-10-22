// B1-09c §2: orders passes locked snapshots to settlement; guards and dedupe live there.
import { expect, it, vi } from 'vitest';
import {
  adminHoldOrder,
  adminUnholdOrder,
  findOrderForRights,
  recordOrderRights,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { APP, capture, database, holdInput, order, ports, rightsInput } from './kit.ts';

it('[AC-B1-09c#13] 只注入 rebate 不代表 rights 可用，缺失维权端口不得调用暂停命令', async () => {
  const f = ports();
  const d = database();
  const result = await capture(() =>
    d.db
      .transaction()
      .execute((trx) => recordOrderRights(trx, { rebate: f.injected.rebate! }, rightsInput())),
  );
  expect(result).toMatchObject({
    ok: false,
    error: { message: 'ORDERS_RIGHTS_PORT_UNAVAILABLE: rights.record' },
  });
  expect(f.record).not.toHaveBeenCalled();
  expect(f.adminHold).not.toHaveBeenCalled();
  expect(f.adminUnhold).not.toHaveBeenCalled();
  expect(d.statements).toEqual([]);
});

it.each([
  { name: 'adminHold', run: adminHoldOrder },
  { name: 'adminUnhold', run: adminUnholdOrder },
] as const)(
  '[AC-B1-09c#14] $name 可单独注入，当前状态、暂停原因和版本冲突均交 settlement 判定',
  async ({ name, run }) => {
    const f = ports({ kind: 'applied' }, { kind: 'not_applicable' });
    const d = database();
    const injected = { rebate: { [name]: f[name] } };
    const snapshots = [
      order({ rebate_status: 'ESTIMATED', hold: false }),
      order({ rebate_status: 'WAITING', hold: true, hold_reason: 'UNMAPPED_STATUS' }),
      order({ rebate_status: 'CREDITED', hold: false }),
      order({ rebate_status: 'VOID', hold: true }),
    ];
    await d.db.transaction().execute(async (trx) => {
      for (const before of snapshots) {
        const input = holdInput({ before, expected_row_version: 0 });
        const saved = structuredClone(input);
        expect(await run(trx, injected, input)).toEqual({ kind: 'not_applicable' });
        expect(f[name]).toHaveBeenLastCalledWith(trx, input);
        expect(f[name].mock.lastCall?.[1].before).toBe(before);
        expect(input).toEqual(saved);
      }
    });
    expect(f[name]).toHaveBeenCalledTimes(snapshots.length);
    expect(f.record).not.toHaveBeenCalled();
    expect(f[name === 'adminHold' ? 'adminUnhold' : 'adminHold']).not.toHaveBeenCalled();
    expect(d.statements).toEqual([]);
  },
);

it('[AC-B1-09c#15] rights 独立注入时不按维权号缓存去重，租户、订单及 type 均完整透传', async () => {
  const f = ports();
  const d = database();
  const inputs = [
    rightsInput(),
    rightsInput({ type: 'PUNISH' }),
    rightsInput({ before: order({ app_id: 'rights-app-b' }) }),
    rightsInput({
      before: order({ order_id: '019a0000-0000-7000-8000-000000000005' }),
      order_id: '019a0000-0000-7000-8000-000000000005',
    }),
  ];
  await d.db.transaction().execute(async (trx) => {
    for (const input of inputs) {
      expect(await recordOrderRights(trx, { rights: f.injected.rights! }, input)).toEqual({
        kind: 'applied',
      });
      expect(f.record).toHaveBeenLastCalledWith(trx, input);
      expect(f.record.mock.lastCall?.[1].before).toBe(input.before);
    }
  });
  expect(f.record).toHaveBeenCalledTimes(inputs.length);
  expect(f.adminHold).not.toHaveBeenCalled();
  expect(f.adminUnhold).not.toHaveBeenCalled();
  expect(d.statements).toEqual([]);
});

it('[AC-B1-09c#29] 定位查询失败原样上抛，不能伪装为子单不存在而跳过导入行', async () => {
  const d = database();
  const failure = new Error('synthetic lookup unavailable');
  const failQuery = vi.fn(() => {
    throw failure;
  });
  const db = d.db.withPlugin({
    transformQuery: failQuery,
    async transformResult(args) {
      return args.result;
    },
  });
  const result = await capture(() =>
    findOrderForRights(db, {
      app_id: APP,
      platform: 'taobao',
      platform_order_no: '880012340001',
    }),
  );
  expect(result).toEqual({ ok: false, error: failure });
  if (!result.ok) expect(result.error).toBe(failure);
  expect(failQuery).toHaveBeenCalledTimes(1);
  expect(d.statements).toEqual([]);
});
