// B1-09b 实现者单元测试：第 ③ 步处置的端口调用（不连库；trx 只作透传的标记对象）。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  applyOrderBlacklist,
  blacklistVoids,
  checkOrderBlacklist,
  type OrderBlacklistCheck,
  type OrderBlacklistDeps,
  type OrderBlacklistStepDeps,
} from './blacklist-step.ts';

const trx = { isTransaction: true } as unknown as Transaction<DB>;
const ATTR_AT = new Date('2026-10-20T04:00:00.000Z');
const subject = {
  app_id: 'unit',
  order_id: '01900000-0000-7000-8000-000000000001',
  user_id: null,
  platform: 'taobao',
  attr_at: ATTR_AT,
};

function deps(options: { rebate?: boolean; events?: boolean; suffixOn?: boolean } = {}) {
  const match = vi.fn<OrderBlacklistDeps['blocklist']['match']>().mockResolvedValue([]);
  const recordHit = vi
    .fn<OrderBlacklistDeps['blocklist']['recordHit']>()
    .mockResolvedValue(undefined);
  const suffixVoidEnabled = vi.fn(async () => options.suffixOn ?? false);
  const onBlacklistHit = vi.fn(async () => undefined);
  const publish = vi.fn(async () => ({ eventId: 'e', duplicate: false }));
  const warn = vi.fn();
  const step: OrderBlacklistStepDeps = {
    blacklist: { blocklist: { match, recordHit }, suffixVoidEnabled },
    ...(options.rebate === false ? {} : { onBlacklistHit }),
    ...(options.events === false ? {} : { events: { publish } }),
    logger: { info: vi.fn(), warn, error: vi.fn() },
  };
  return { step, match, recordHit, suffixVoidEnabled, onBlacklistHit, publish, warn };
}

const channel: OrderBlacklistCheck = {
  matches: [{ blocklist_id: 'b1', dimension: 'channel', value: 'R8' }],
  suffixVoidEnabled: false,
};

it('[AC-B1-09b#u6] 只有尾号命中时才读尾号开关；无命中不读', async () => {
  const d = deps();
  const query = {
    app_id: 'unit',
    platform: 'taobao',
    trade_parent_id: null,
    relation_id: null,
    union_account_id: null,
    attr_at: ATTR_AT,
  };
  expect(await checkOrderBlacklist(trx, d.step.blacklist, query)).toEqual({
    matches: [],
    suffixVoidEnabled: false,
  });
  expect(d.suffixVoidEnabled).not.toHaveBeenCalled();
  d.match.mockResolvedValueOnce([{ blocklist_id: 'b2', dimension: 'order_no_suffix', value: '1' }]);
  expect((await checkOrderBlacklist(trx, d.step.blacklist, query)).suffixVoidEnabled).toBe(false);
  expect(d.suffixVoidEnabled).toHaveBeenCalledWith('unit');
});

it('[AC-B1-09b#u7] 未入账渠道命中：先写命中，再经返利端口，同一 trx', async () => {
  const d = deps();
  expect(await applyOrderBlacklist(trx, d.step, subject, channel, 'WAITING')).toBe('void');
  expect(d.recordHit.mock.calls[0]?.[1]).toMatchObject({ risk_action: 'void_commission' });
  expect(d.onBlacklistHit).toHaveBeenCalledWith(trx, {
    app_id: 'unit',
    order_id: subject.order_id,
    attr_at: ATTR_AT,
  });
  expect(d.recordHit.mock.invocationCallOrder[0]).toBeLessThan(
    d.onBlacklistHit.mock.invocationCallOrder[0]!,
  );
  expect(blacklistVoids(channel, 'WAITING', d.step)).toBe(true);
});

it('[AC-B1-09b#u8] 已入账命中但总线未注入：只记 manual_review 并告警', async () => {
  const d = deps({ events: false });
  expect(await applyOrderBlacklist(trx, d.step, subject, channel, 'CREDITED')).toBe('none');
  expect(d.recordHit.mock.calls[0]?.[1]).toMatchObject({ risk_action: 'manual_review' });
  expect(d.warn).toHaveBeenCalledTimes(1);
  expect(d.onBlacklistHit).not.toHaveBeenCalled();
});

it('[AC-B1-09b#u9] 已入账命中：复核事件载荷只有订单 id、平台与维度名，事件 ID 由内容派生', async () => {
  const d = deps();
  expect(await applyOrderBlacklist(trx, d.step, subject, channel, 'CREDITED')).toBe('after_credit');
  const event = (d.publish.mock.calls[0] as unknown[] | undefined)?.[1];
  expect(event).toMatchObject({
    appId: 'unit',
    name: 'order.blacklist_hit_after_credit',
    payload: { order_id: subject.order_id, platform: 'taobao', dimensions: ['channel'] },
  });
  expect(JSON.stringify(event)).not.toContain('R8');
  const again = deps();
  await applyOrderBlacklist(trx, again.step, subject, channel, 'CREDITED');
  expect((again.publish.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual(event);
});

it('[AC-B1-09b#u10] 返利端口未接线：不预判作废（第 ⑥ 步照常）', () => {
  const d = deps({ rebate: false });
  expect(blacklistVoids(channel, 'ESTIMATED', d.step)).toBe(false);
  expect(blacklistVoids(null, 'ESTIMATED', deps().step)).toBe(false);
});

it('[AC-B1-09m#u1] 每条命中都标明来自本次判定（作废、复核事件、只记复核三种处置）', async () => {
  const two: OrderBlacklistCheck = {
    matches: [
      { blocklist_id: 'b1', dimension: 'channel', value: 'R8' },
      { blocklist_id: 'b2', dimension: 'order_no_suffix', value: '123456' },
    ],
    suffixVoidEnabled: true,
  };
  const voided = deps();
  await applyOrderBlacklist(trx, voided.step, subject, two, 'WAITING');
  const credited = deps();
  await applyOrderBlacklist(trx, credited.step, subject, channel, 'CREDITED');
  const reviewOnly = deps({ rebate: false });
  await applyOrderBlacklist(trx, reviewOnly.step, subject, channel, 'ESTIMATED');
  const inputs = [voided, credited, reviewOnly].flatMap((d) =>
    d.recordHit.mock.calls.map(([, input]) => input),
  );
  expect(inputs).toHaveLength(4);
  for (const input of inputs) expect(input.decided_in_force).toBe(true);
});

it('[AC-B1-09m#u2] 无命中或返利状态不处理时不写命中', async () => {
  const none = deps();
  const empty: OrderBlacklistCheck = { matches: [], suffixVoidEnabled: false };
  await applyOrderBlacklist(trx, none.step, subject, empty, 'WAITING');
  const settled = deps();
  await applyOrderBlacklist(trx, settled.step, subject, channel, 'VOID');
  expect(none.recordHit).not.toHaveBeenCalled();
  expect(settled.recordHit).not.toHaveBeenCalled();
});
