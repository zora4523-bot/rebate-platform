import { expect, it } from 'vitest';
import { EVENTS, RULES, STATES } from './cases.ts';
import { publicTransition } from './kit.ts';

it.each(RULES)('[AC-CT-04d#5] [SM-WDR-$id] 每个合法起点按原文迁移', (rule) => {
  const transition = publicTransition();
  for (const from of rule.from) {
    const actual = transition(from, rule.event);
    const allowed = rule.targets.map((to) => ({
      ok: true,
      to: to === 'same' ? from : to,
      id: rule.id,
      noop: to === 'same',
    }));
    expect(allowed).toContainEqual(actual);
  }
});

it.each([null, ...STATES])('[AC-CT-04d#6] 起点 %s 的全部表外事件拒绝，不能重复申请', (from) => {
  const transition = publicTransition();
  for (const event of EVENTS) {
    if (!RULES.some((rule) => rule.from.includes(from) && rule.event === event)) {
      expect(transition(from, event)).toStrictEqual({ ok: false, reason: 'illegal', id: null });
    }
  }
});

it.each(['REJECTED', 'PAID_API', 'PAID_MANUAL', 'FAILED'])(
  '[AC-CT-04d#7] 终态 %s 不得离开，提现没有 ADMIN_RESTORE 例外',
  (from) => {
    const transition = publicTransition();
    for (const event of [...EVENTS, 'ADMIN_RESTORE']) {
      expect(transition(from, event)).toStrictEqual({ ok: false, reason: 'illegal', id: null });
    }
  },
);

it('[AC-CT-04d#8] PAYING 未知结果连续查询保持 PAYING，不能重新 EXECUTE 或线下付款', () => {
  const transition = publicTransition();
  for (let count = 0; count < 3; count++) {
    expect(transition('PAYING', 'CHANNEL_UNKNOWN')).toStrictEqual({
      ok: true,
      to: 'PAYING',
      id: 'W7',
      noop: true,
    });
  }
  for (const event of ['EXECUTE', 'MANUAL_PAID', 'REJECT', 'CHANNEL_SUCCESS_PROVEN']) {
    expect(transition('PAYING', event)).toStrictEqual({ ok: false, reason: 'illegal', id: null });
  }
});
