import { expect, it } from 'vitest';
import {
  transitionOrderPlatform,
  type OrderPlatformEvent,
  type OrderPlatformState,
} from '@couli/domain';

// BR-FUND-01 独立列举全部 6 × 7 组合。非法和倒退不从被测 YAML 推导。
// 列顺序：定金、付款、收货、结算、失效、维权、处罚。
const EVENTS: OrderPlatformEvent[] = [
  'PLATFORM_DEPOSIT_PAID',
  'PLATFORM_PAID',
  'PLATFORM_RECEIVED',
  'PLATFORM_SETTLED',
  'PLATFORM_INVALID',
  'PLATFORM_RIGHTS',
  'PLATFORM_PUNISH',
];
const MATRIX: { from: OrderPlatformState | null; ids: (string | null)[] }[] = [
  { from: null, ids: ['P1', 'P2', 'P11', 'P12', 'P13', null, null] },
  { from: 'DEPOSIT_PAID', ids: ['P15', 'P2', 'P14', 'P5', 'P6', null, null] },
  { from: 'PAID', ids: ['P10', 'P15', 'P3', 'P5', 'P6', 'P8', 'P8'] },
  { from: 'RECEIVED', ids: ['P10', 'P10', 'P15', 'P4', 'P6', 'P8', 'P8'] },
  { from: 'SETTLED', ids: ['P10', 'P10', 'P10', 'P15', 'P7', 'P8', 'P8'] },
  { from: 'INVALID', ids: [null, 'P9', 'P9', 'P9', 'P15', null, null] },
];
const TARGET: Record<OrderPlatformEvent, OrderPlatformState | null> = {
  PLATFORM_DEPOSIT_PAID: 'DEPOSIT_PAID',
  PLATFORM_PAID: 'PAID',
  PLATFORM_RECEIVED: 'RECEIVED',
  PLATFORM_SETTLED: 'SETTLED',
  PLATFORM_INVALID: 'INVALID',
  PLATFORM_RIGHTS: null,
  PLATFORM_PUNISH: null,
};
const CASES = MATRIX.flatMap(({ from, ids }) =>
  EVENTS.map((event, i) => ({
    from,
    event,
    id: ids[i] ?? null,
    label: ids[i] ? `SM-PLT-${ids[i]}` : 'SM-PLT-ILLEGAL',
  })),
);

it.each(CASES)('[AC-CT-04a-PLT] [$label] $from + $event', ({ from, event, id }) => {
  const actual = transitionOrderPlatform(from, event);
  if (id === null) {
    expect(actual).toStrictEqual({ ok: false, reason: 'illegal', id: null });
  } else if (id === 'P10') {
    expect(actual).toStrictEqual({ ok: false, reason: 'backward', id: 'P10' });
  } else {
    const noop = ['P7', 'P8', 'P15'].includes(id);
    expect(actual).toStrictEqual({ ok: true, to: noop ? from : TARGET[event], id, noop });
  }
});

it('[AC-CT-04a-PLT#2] [SM-PLT-P9] INVALID 恢复后按普通阶段判定，不把 INVALID 当最大阶段', () => {
  const recovered = transitionOrderPlatform('INVALID', 'PLATFORM_PAID');
  expect(recovered).toStrictEqual({ ok: true, to: 'PAID', id: 'P9', noop: false });
  expect(transitionOrderPlatform('PAID', 'PLATFORM_RECEIVED')).toStrictEqual({
    ok: true,
    to: 'RECEIVED',
    id: 'P3',
    noop: false,
  });
});

it('[AC-CT-04a-PLT#3] [SM-PLT-P15] 重复上报可反复判定且不影响后续迁移', () => {
  expect(transitionOrderPlatform('PAID', 'PLATFORM_PAID')).toStrictEqual({
    ok: true,
    to: 'PAID',
    id: 'P15',
    noop: true,
  });
  expect(transitionOrderPlatform('PAID', 'PLATFORM_PAID')).toStrictEqual({
    ok: true,
    to: 'PAID',
    id: 'P15',
    noop: true,
  });
  expect(transitionOrderPlatform('PAID', 'PLATFORM_INVALID')).toStrictEqual({
    ok: true,
    to: 'INVALID',
    id: 'P6',
    noop: false,
  });
});
