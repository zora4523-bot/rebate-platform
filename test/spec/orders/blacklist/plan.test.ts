// B1-09b 第 ③ 步的纯判定（08 BR-ATTR-26「命中后的处理」与 ① 尾号维度未启用时除外）。期望值按规则原文手写，
// 不取实现。命中由 risk 端口给出，这里只验处置：
// - 未入账（UNATTRIBUTED / ESTIMATED / WAITING）→ void（R6，risk_action=void_commission）；
// - CREDITED → after_credit（order.blacklist_hit_after_credit，不自动扣回）；
// - VOID / CLAWED_BACK → 不处理；
// - 尾号维度开关关闭：命中只写 risk_hits（manual_review），不改 rebate_status，用户侧无变化。
import { describe, expect, it } from 'vitest';
import {
  planBlacklistHit,
  type BlacklistMatchInput,
} from '../../../../apps/api/src/modules/orders/domain/blacklist.ts';
import { CHANNEL, PRECREDIT, REBATE_STATES, SUFFIX } from './plan-kit.ts';

const channel: BlacklistMatchInput = { dimension: 'channel', value: CHANNEL };
const suffix: BlacklistMatchInput = { dimension: 'order_no_suffix', value: SUFFIX };
const FLAGS = [false, true] as const;
const grid = <T>(states: readonly T[]) =>
  states.flatMap((state) => FLAGS.map((flag) => [state, flag] as const));

describe('[AC-B1-09b#1] 未命中', () => {
  it.each(grid(REBATE_STATES))('%s（尾号开关 %s）：不处置、不写命中', (state, flag) => {
    const plan = planBlacklistHit({ matches: [], rebate_status: state, suffix_void_enabled: flag });
    expect(plan).toEqual({ disposition: 'none', hits: [] });
  });
});

describe('[AC-B1-09b#2] 渠道命中未入账订单 → VOID（R6），risk_action=void_commission', () => {
  it.each(grid(PRECREDIT))('%s（尾号开关 %s）', (state, flag) => {
    const plan = planBlacklistHit({
      matches: [channel],
      rebate_status: state,
      suffix_void_enabled: flag,
    });
    expect(plan).toEqual({
      disposition: 'void',
      hits: [{ dimension: 'channel', value: CHANNEL, risk_action: 'void_commission' }],
    });
  });
});

describe('[AC-B1-09b#3] 尾号维度开关打开后按命中处理', () => {
  it.each(PRECREDIT)('%s → VOID，risk_action=void_commission', (state) => {
    const plan = planBlacklistHit({
      matches: [suffix],
      rebate_status: state,
      suffix_void_enabled: true,
    });
    expect(plan).toEqual({
      disposition: 'void',
      hits: [{ dimension: 'order_no_suffix', value: SUFFIX, risk_action: 'void_commission' }],
    });
  });

  it('CREDITED → 进人工复核，不自动扣回', () => {
    const plan = planBlacklistHit({
      matches: [suffix],
      rebate_status: 'CREDITED',
      suffix_void_enabled: true,
    });
    expect(plan.disposition).toBe('after_credit');
    expect(plan.hits.some((hit) => hit.risk_action === 'void_commission')).toBe(false);
  });
});

describe('[AC-B1-09b#4] 尾号维度开关关闭：只写 risk_hits（manual_review），不改 rebate_status', () => {
  it.each([...PRECREDIT, 'CREDITED'])('%s', (state) => {
    const plan = planBlacklistHit({
      matches: [suffix],
      rebate_status: state,
      suffix_void_enabled: false,
    });
    expect(plan).toEqual({
      disposition: 'none',
      hits: [{ dimension: 'order_no_suffix', value: SUFFIX, risk_action: 'manual_review' }],
    });
  });
});

describe('[AC-B1-09b#5] 已入账命中 → after_credit（order.blacklist_hit_after_credit），不自动扣回', () => {
  it.each([
    ['渠道', [channel], false],
    ['渠道 + 尾号（开关关）', [channel, suffix], false],
    ['渠道 + 尾号（开关开）', [channel, suffix], true],
  ] as const)('%s', (_label, matches, flag) => {
    const plan = planBlacklistHit({
      matches,
      rebate_status: 'CREDITED',
      suffix_void_enabled: flag,
    });
    expect(plan.disposition).toBe('after_credit');
    expect(plan.hits.some((hit) => hit.risk_action === 'void_commission')).toBe(false);
  });
});

describe('[AC-B1-09b#6] VOID / CLAWED_BACK 不处理', () => {
  const combos = [[channel], [suffix], [channel, suffix]];
  it.each(
    grid(['VOID', 'CLAWED_BACK']).flatMap(([state, flag]) =>
      combos.map((matches) => [state, flag, matches] as const),
    ),
  )('%s（尾号开关 %s）：%j', (state, flag, matches) => {
    const plan = planBlacklistHit({ matches, rebate_status: state, suffix_void_enabled: flag });
    expect(plan.disposition).toBe('none');
    expect(plan.hits.some((hit) => hit.risk_action === 'void_commission')).toBe(false);
  });
});

describe('[AC-B1-09b#7] 两类名单同时命中：渠道命中即作废；未启用的尾号维度仍只记 manual_review', () => {
  it.each(grid(PRECREDIT))('%s（尾号开关 %s）', (state, flag) => {
    const plan = planBlacklistHit({
      matches: [suffix, channel],
      rebate_status: state,
      suffix_void_enabled: flag,
    });
    expect(plan.disposition).toBe('void');
    expect(plan.hits).toHaveLength(2);
    expect(plan.hits).toEqual(
      expect.arrayContaining([
        { dimension: 'channel', value: CHANNEL, risk_action: 'void_commission' },
        {
          dimension: 'order_no_suffix',
          value: SUFFIX,
          risk_action: flag ? 'void_commission' : 'manual_review',
        },
      ]),
    );
  });
});
