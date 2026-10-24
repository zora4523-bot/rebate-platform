import { expect, it } from 'vitest';
import {
  checkHoldBody,
  checkUnholdBody,
  decideAdminHold,
  deriveHoldReasonCode,
  type AdminHoldOrderState,
  type HoldOperator,
} from '../../../../apps/api/src/modules/orders/domain/admin-hold.ts';

const NOTE = '用户反映订单异常，先暂停核实';
const RISK_OP: HoldOperator = { isSuper: false, permissions: ['order.hold', 'risk.freeze'] };
const CS_OP: HoldOperator = { isSuper: false, permissions: ['order.hold', 'order.claim'] };
const BOTH_OP: HoldOperator = {
  isSuper: false,
  permissions: ['order.hold', 'risk.blocklist', 'order.claim'],
};
const NONE_OP: HoldOperator = { isSuper: false, permissions: ['order.hold', 'order.view'] };
const SUPER_OP: HoldOperator = { isSuper: true, permissions: [] };

it.each<[readonly string[], boolean, 'RISK' | 'CS' | null]>([
  [['risk.freeze'], false, 'RISK'],
  [['risk.ban'], false, 'RISK'],
  [['risk.blocklist'], false, 'RISK'],
  [['risk.appeal'], false, 'RISK'],
  [['order.hold', 'risk.freeze', 'risk.ban', 'config.risk'], false, 'RISK'],
  [['order.claim'], false, 'CS'],
  [['order.hold', 'order.claim'], false, 'CS'],
  [['order.hold', 'order.claim', 'config.risk'], false, 'CS'],
  [['risk.freeze', 'order.claim'], false, null],
  [['order.hold', 'risk.appeal', 'order.claim'], false, null],
  [['order.hold'], false, null],
  [[], false, null],
  [['config.risk'], false, null],
  [['order.hold', 'config.risk'], false, null],
  [['order.hold', 'order.view', 'order.assign', 'user.lookup'], false, null],
  [[], true, null],
  [['risk.freeze'], true, null],
  [['order.claim'], true, null],
])(
  '[AC-B1-09l#1] 原因码按权限推导：权限 %j、超管 %s → %s（risk.* 不含 config.risk；两类都有或都没有、超管 → 不推导）',
  (permissions, isSuper, expected) => {
    expect(deriveHoldReasonCode({ isSuper, permissions })).toBe(expected);
  },
);

it.each<[string, HoldOperator, string | undefined, 'RISK' | 'CS']>([
  ['只持 risk.* 不传', RISK_OP, undefined, 'RISK'],
  ['只持 risk.* 传 RISK', RISK_OP, 'RISK', 'RISK'],
  ['只持 order.claim 不传', CS_OP, undefined, 'CS'],
  ['只持 order.claim 传 CS', CS_OP, 'CS', 'CS'],
  ['两类都持有选 RISK', BOTH_OP, 'RISK', 'RISK'],
  ['两类都持有选 CS', BOTH_OP, 'CS', 'CS'],
  ['两类都没有选 RISK', NONE_OP, 'RISK', 'RISK'],
  ['两类都没有选 CS', NONE_OP, 'CS', 'CS'],
  ['超管选 RISK', SUPER_OP, 'RISK', 'RISK'],
  ['超管选 CS', SUPER_OP, 'CS', 'CS'],
])('[AC-B1-09l#2] hold 受理的原因码：%s', (_label, operator, reasonCode, expected) => {
  const body = reasonCode === undefined ? { note: NOTE } : { reason_code: reasonCode, note: NOTE };
  expect(checkHoldBody(operator, body)).toEqual({ ok: true, reasonCode: expected, note: NOTE });
});

it.each<[string, HoldOperator, string | undefined]>([
  ['推得 RISK 却传 CS', RISK_OP, 'CS'],
  ['推得 CS 却传 RISK', CS_OP, 'RISK'],
  ['两类都持有而不传', BOTH_OP, undefined],
  ['两类都没有而不传', NONE_OP, undefined],
  ['超管不传', SUPER_OP, undefined],
  ['传 UNMAPPED_STATUS（只由系统置）', BOTH_OP, 'UNMAPPED_STATUS'],
  ['推得 CS 时传 UNMAPPED_STATUS', CS_OP, 'UNMAPPED_STATUS'],
  ['传小写 cs', BOTH_OP, 'cs'],
  ['传空串', CS_OP, ''],
  ['传带空格的 RISK', RISK_OP, ' RISK'],
])('[AC-B1-09l#3] hold 拒收的原因码 → 20001 reason_code：%s', (_label, operator, reasonCode) => {
  const body = reasonCode === undefined ? { note: NOTE } : { reason_code: reasonCode, note: NOTE };
  expect(checkHoldBody(operator, body)).toEqual({ ok: false, fields: ['reason_code'] });
});

it.each<[string | undefined, boolean]>([
  ['RISK', true],
  ['CS', true],
  [undefined, false],
  ['UNMAPPED_STATUS', false],
  ['risk', false],
  ['', false],
])('[AC-B1-09l#4] unhold 原因码必选，只收 RISK、CS：%s → 受理 %s', (reasonCode, accepted) => {
  const body = reasonCode === undefined ? { note: NOTE } : { reason_code: reasonCode, note: NOTE };
  expect(checkUnholdBody(body)).toEqual(
    accepted ? { ok: true, reasonCode, note: NOTE } : { ok: false, fields: ['reason_code'] },
  );
});

it.each<[string, string, boolean]>([
  ['1 个字', '查', true],
  ['200 个汉字', '暂'.repeat(200), true],
  ['200 个 ASCII', 'x'.repeat(200), true],
  ['200 个增补平面字符（按字符计，不按 UTF-16 码元）', '𠀀'.repeat(200), true],
  ['空串', '', false],
  ['201 个汉字', '暂'.repeat(201), false],
  ['201 个 ASCII', 'x'.repeat(201), false],
  ['201 个增补平面字符', '𠀀'.repeat(201), false],
])(
  '[AC-B1-09l#5] 说明必填且 1–200 字（hold、unhold 同）：%s → 受理 %s',
  (_label, note, accepted) => {
    const refused = { ok: false, fields: ['note'] };
    expect(checkHoldBody(CS_OP, { note })).toEqual(
      accepted ? { ok: true, reasonCode: 'CS', note } : refused,
    );
    expect(checkUnholdBody({ reason_code: 'RISK', note })).toEqual(
      accepted ? { ok: true, reasonCode: 'RISK', note } : refused,
    );
  },
);

const state = (patch: Partial<AdminHoldOrderState>): AdminHoldOrderState => ({
  rebate_status: 'ESTIMATED',
  hold: false,
  hold_reason: null,
  row_version: 2,
  ...patch,
});

it.each<[string, Partial<AdminHoldOrderState>, number, 'proceed' | 'conflict']>([
  ['ESTIMATED 未暂停', {}, 2, 'proceed'],
  ['WAITING 未暂停', { rebate_status: 'WAITING' }, 2, 'proceed'],
  ['UNATTRIBUTED（R11 起点不符）', { rebate_status: 'UNATTRIBUTED' }, 2, 'conflict'],
  ['CREDITED（入账后不得 hold）', { rebate_status: 'CREDITED' }, 2, 'conflict'],
  ['VOID', { rebate_status: 'VOID' }, 2, 'conflict'],
  ['CLAWED_BACK', { rebate_status: 'CLAWED_BACK' }, 2, 'conflict'],
  ['已人工 CS 暂停（同状态）', { hold: true, hold_reason: 'CS' }, 2, 'conflict'],
  [
    'WAITING 已 RISK 暂停（同状态）',
    { rebate_status: 'WAITING', hold: true, hold_reason: 'RISK' },
    2,
    'conflict',
  ],
  [
    '已系统 UNMAPPED_STATUS 暂停（同状态）',
    { hold: true, hold_reason: 'UNMAPPED_STATUS' },
    2,
    'conflict',
  ],
  ['row_version 落后', {}, 1, 'conflict'],
  ['row_version 超前', {}, 3, 'conflict'],
])('[AC-B1-09l#6] hold 判定：%s → %s', (_label, patch, expected, decision) => {
  expect(decideAdminHold('hold', state(patch), expected, false)).toBe(decision);
});

it.each<[string, Partial<AdminHoldOrderState>, number, boolean, 'proceed' | 'conflict']>([
  ['ESTIMATED 人工 RISK 暂停', { hold: true, hold_reason: 'RISK' }, 2, false, 'proceed'],
  [
    'WAITING 人工 CS 暂停',
    { rebate_status: 'WAITING', hold: true, hold_reason: 'CS' },
    2,
    false,
    'proceed',
  ],
  [
    'UNMAPPED_STATUS 暂停且待处理记录已关闭',
    { hold: true, hold_reason: 'UNMAPPED_STATUS' },
    2,
    false,
    'proceed',
  ],
  [
    'UNMAPPED_STATUS 暂停而待处理记录未关闭',
    { hold: true, hold_reason: 'UNMAPPED_STATUS' },
    2,
    true,
    'conflict',
  ],
  ['未暂停（同状态）', {}, 2, false, 'conflict'],
  ['WAITING 未暂停（同状态）', { rebate_status: 'WAITING' }, 2, false, 'conflict'],
  [
    '暂停后作废 VOID（标记保留，不提供解除）',
    { rebate_status: 'VOID', hold: true, hold_reason: 'CS' },
    2,
    false,
    'conflict',
  ],
  [
    'CREDITED 带暂停',
    { rebate_status: 'CREDITED', hold: true, hold_reason: 'RISK' },
    2,
    false,
    'conflict',
  ],
  [
    'CLAWED_BACK 带暂停',
    { rebate_status: 'CLAWED_BACK', hold: true, hold_reason: 'CS' },
    2,
    false,
    'conflict',
  ],
  [
    'UNATTRIBUTED 带暂停',
    { rebate_status: 'UNATTRIBUTED', hold: true, hold_reason: 'RISK' },
    2,
    false,
    'conflict',
  ],
  ['row_version 落后', { hold: true, hold_reason: 'CS' }, 1, false, 'conflict'],
  ['row_version 超前', { hold: true, hold_reason: 'CS' }, 3, false, 'conflict'],
])('[AC-B1-09l#7] unhold 判定：%s → %s', (_label, patch, expected, pendingOpen, decision) => {
  expect(decideAdminHold('unhold', state(patch), expected, pendingOpen)).toBe(decision);
});
