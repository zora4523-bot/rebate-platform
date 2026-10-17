import { expect, it } from 'vitest';
import { planImportState } from '../../../../apps/api/src/modules/orders/domain/import-state.ts';
import { at, RECEIVED, SETTLED } from './kit.ts';

it.each([
  ['PLATFORM_DEPOSIT_PAID', 'DEPOSIT_PAID'],
  ['PLATFORM_PAID', 'PAID'],
  ['PLATFORM_INVALID', 'INVALID'],
] as const)('[AC-B1-08h#14] P1/P2/P13 首态 %s 只记一条迁移', (event, state) => {
  expect(planImportState(event, null, null)).toEqual({
    kind: 'insert',
    platform_status: state,
    received_at: null,
    pending: null,
    history: [{ from_status: null, event, to_status: state }],
  });
});
it('[AC-B1-08h#15] P11 补 PAID、RECEIVED，P12 补 PAID、RECEIVED、SETTLED', () => {
  const paid = { from_status: null, event: 'PLATFORM_PAID', to_status: 'PAID' };
  const received = { from_status: 'PAID', event: 'PLATFORM_RECEIVED', to_status: 'RECEIVED' };
  const settled = { from_status: 'RECEIVED', event: 'PLATFORM_SETTLED', to_status: 'SETTLED' };
  expect(planImportState('PLATFORM_RECEIVED', at(RECEIVED), null)).toEqual({
    kind: 'insert',
    platform_status: 'RECEIVED',
    received_at: at(RECEIVED),
    pending: null,
    history: [paid, received],
  });
  for (const time of [at(RECEIVED), null]) {
    expect(planImportState('PLATFORM_SETTLED', time, at(SETTLED))).toEqual({
      kind: 'insert',
      platform_status: 'SETTLED',
      received_at: time ?? at(SETTLED),
      pending: null,
      history: [paid, received, settled],
    });
  }
});
it.each(['PLATFORM_RECEIVED', 'PLATFORM_SETTLED'] as const)(
  '[AC-B1-08h#16] %s 缺可用收货时间只入 PAID，保留 NO_RECEIVED_AT',
  (event) => {
    expect(planImportState(event, null, null)).toEqual({
      kind: 'insert',
      platform_status: 'PAID',
      received_at: null,
      pending: 'NO_RECEIVED_AT',
      history: [{ from_status: null, event: 'PLATFORM_PAID', to_status: 'PAID' }],
    });
  },
);
it('[AC-B1-08h#17] P11 不能借结算时间替代缺失收货时间', () => {
  expect(planImportState('PLATFORM_RECEIVED', null, at(SETTLED))).toMatchObject({
    platform_status: 'PAID',
    received_at: null,
    pending: 'NO_RECEIVED_AT',
  });
});
it.each(['PLATFORM_RIGHTS', 'PLATFORM_PUNISH'] as const)(
  '[AC-B1-08h#18] 首次 %s 无合法迁移，不猜造首态',
  (event) => {
    expect(planImportState(event, at(RECEIVED), at(SETTLED))).toEqual({
      kind: 'pending',
      reason: 'ILLEGAL_TRANSITION',
    });
  },
);
