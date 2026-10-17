import { expect, it } from 'vitest';
import { transitionOrderRebate, type OrderRebateEvent, type OrderRebateState } from '@couli/domain';
import { machine, REBATE_STATES, rowsFor } from './kit.ts';
import { REBATE_RULES } from './rebate-cases.ts';

it.each(REBATE_RULES)('[AC-CT-04a-REB] [SM-REB-$id] 全部起点与事件按表迁移', (rule) => {
  const rows = rowsFor(machine('order-rebate'), rule.id);
  for (const row of rows) {
    expect(row.event).toEqual(expect.any(String));
    expect(rule.targets).toContain(row.to);
    for (const from of rule.from) {
      expect(
        rows.some((candidate) => candidate.event === row.event && candidate.from.includes(from)),
      ).toBe(true);
      const actual = transitionOrderRebate(
        from as OrderRebateState | null,
        row.event as OrderRebateEvent,
      );
      expect(actual).toStrictEqual({
        ok: true,
        to: row.to === 'same' ? from : row.to,
        id: rule.id,
        noop: row.to === 'same',
      });
    }
  }
});

it('[AC-CT-04a-REB#2] [SM-REB-R1] [SM-REB-R2] null 只匹配入库行，已有状态不能重复入库', () => {
  const doc = machine('order-rebate');
  const initialEvents = [...rowsFor(doc, 'R1'), ...rowsFor(doc, 'R2')].map((r) => r.event);
  for (const event of doc.events) {
    if (!initialEvents.includes(event)) {
      expect(transitionOrderRebate(null, event as OrderRebateEvent)).toStrictEqual({
        ok: false,
        reason: 'illegal',
        id: null,
      });
    }
  }
  for (const from of REBATE_STATES) {
    for (const event of initialEvents) {
      expect(
        transitionOrderRebate(from as OrderRebateState, event as OrderRebateEvent),
      ).toStrictEqual({ ok: false, reason: 'illegal', id: null });
    }
  }
});

it('[AC-CT-04a-REB#3] [SM-REB-R3b] [SM-REB-R12] [SM-REB-R13] 终态不能被自动事件复活', () => {
  const doc = machine('order-rebate');
  for (const from of ['VOID', 'CLAWED_BACK'] as const) {
    for (const event of doc.events) {
      if (event === 'ADMIN_RESTORE') continue;
      const actual = transitionOrderRebate(from, event as OrderRebateEvent);
      if (from === 'VOID' && ['ADMIN_REASSIGN', 'SYNC_ATTRIBUTED'].includes(event)) {
        expect(actual).toStrictEqual({ ok: true, to: 'VOID', id: 'R3b', noop: true });
      } else {
        expect(actual).toStrictEqual({ ok: false, reason: 'illegal', id: null });
      }
    }
  }
});

it('[AC-CT-04a-REB#4] [SM-REB-R3] [SM-REB-R3b] VOID 不接受用户找回', () => {
  expect(transitionOrderRebate('VOID', 'CLAIM_APPROVED')).toStrictEqual({
    ok: false,
    reason: 'illegal',
    id: null,
  });
});

it('[AC-CT-04a-REB#5] [SM-REB-R14] 已归属订单改派保持当前状态', () => {
  for (const from of ['ESTIMATED', 'WAITING', 'CREDITED'] as const) {
    expect(transitionOrderRebate(from, 'ADMIN_REASSIGN')).toStrictEqual({
      ok: true,
      to: from,
      id: 'R14',
      noop: true,
    });
  }
});

it('[AC-CT-04a-REB#6] [SM-REB-R11] HOLD/UNHOLD 只在 ESTIMATED/WAITING 合法', () => {
  for (const from of [null, 'UNATTRIBUTED', 'CREDITED', 'VOID', 'CLAWED_BACK'] as const) {
    for (const event of ['HOLD', 'UNHOLD'] as const) {
      expect(transitionOrderRebate(from, event)).toStrictEqual({
        ok: false,
        reason: 'illegal',
        id: null,
      });
    }
  }
});

it('[AC-CT-04a-REB#7] 表外起点与事件组合全部 illegal，不把返利自迁移泛化成 P15', () => {
  const doc = machine('order-rebate');
  for (const from of [null, ...REBATE_STATES]) {
    for (const event of doc.events) {
      // 合法起点来自独立规则清单；YAML 只提供中文事件的实现编码。
      const legal = REBATE_RULES.some(
        (rule) =>
          rule.from.includes(from) && rowsFor(doc, rule.id).some((row) => row.event === event),
      );
      if (!legal) {
        expect(
          transitionOrderRebate(from as OrderRebateState | null, event as OrderRebateEvent),
        ).toStrictEqual({ ok: false, reason: 'illegal', id: null });
      }
    }
  }
});
