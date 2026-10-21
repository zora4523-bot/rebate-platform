import { planCommissionAdjustment } from '@couli/domain';
import type { AdjustmentObligation } from '@couli/domain';
import { expect, it } from 'vitest';
import { beneficiary, freezeInput, input } from './fixtures.ts';

const deferred: AdjustmentObligation = { beneficiary_credit_id: 'credit-d1', kind: 'deferred' };
const firstCredit: AdjustmentObligation = {
  beneficiary_credit_id: 'credit-f1',
  kind: 'first_credit',
};

it.each(['clawback', 'settlement'] as const)(
  '[AC-B2-04g#27] BR-FUND-04⑫/08/09：%s 暂缓份额调减，原义务保持、净影响扣掉待补记变化',
  (event) => {
    const result = planCommissionAdjustment(
      freezeInput(
        input({
          event,
          platform_net_fen: 600n,
          beneficiaries: [
            beneficiary({
              status: 'held',
              net_fen: 0n,
              risk_state: 'frozen',
              obligation: firstCredit,
            }),
          ],
        }),
      ),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: 0n,
        posting: null,
        pending_before_fen: 400n,
        pending_after_fen: 240n,
        obligation_action: 'keep',
        beneficiary_credit_id: 'credit-f1',
        append_forfeited_event: false,
      },
    ]);
    expect(result).toMatchObject({
      platform_after_fen: 360n,
      platform_delta_fen: -240n,
      union_receivable_delta_fen: -240n,
    });
  },
);

it.each(['normal', 'frozen', 'appealing'] as const)(
  '[AC-B2-04g#28] BR-FUND-09：负差一路已有义务即使 %s 也不补正差、不进候选',
  (risk_state) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        reserve_bp: 0n,
        booked_base_fen: 1200n,
        booked_n_fen: 1200n,
        n_new_fen: 1100n,
        platform_net_fen: 600n,
        beneficiaries: [beneficiary({ net_fen: 500n, risk_state, obligation: deferred })],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: 0n,
        net_after_fen: 500n,
        posting: null,
        pending_before_fen: 100n,
        pending_after_fen: 50n,
        obligation_action: 'keep',
        beneficiary_credit_id: 'credit-d1',
      },
    ]);
    expect(result).toMatchObject({
      route: 'immediate',
      platform_delta_fen: -50n,
      union_receivable_delta_fen: -50n,
    });
  },
);

it('[AC-B2-04g#29] BR-FUND-09 X-05：负差一路冻结受益人出现正差，新开延后义务而不进候选', () => {
  const result = planCommissionAdjustment(
    input({
      event: 'settlement',
      reserve_bp: 0n,
      booked_base_fen: 1200n,
      booked_n_fen: 1200n,
      n_new_fen: 1100n,
      platform_net_fen: 700n,
      beneficiaries: [beneficiary({ net_fen: 500n, risk_state: 'frozen' })],
    }),
  );
  expect(result.beneficiaries).toMatchObject([
    {
      delta_fen: 0n,
      pending_before_fen: 0n,
      pending_after_fen: 50n,
      obligation_action: 'open',
      beneficiary_credit_id: null,
    },
  ]);
  expect(result).toMatchObject({
    route: 'immediate',
    platform_delta_fen: -150n,
    union_receivable_delta_fen: -150n,
  });
});

it.each(['frozen', 'appealing'] as const)(
  '[AC-B2-04g#30] BR-FUND-04⑫：%s 新延后并入既有义务，不另分配 ID',
  (risk_state) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 1200n,
        platform_net_fen: 600n,
        beneficiaries: [beneficiary({ net_fen: 300n, risk_state, obligation: deferred })],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: 0n,
        pending_before_fen: 100n,
        pending_after_fen: 180n,
        obligation_action: 'keep',
        beneficiary_credit_id: 'credit-d1',
        append_forfeited_event: false,
      },
    ]);
    expect(result.union_receivable_delta_fen).toBe(120n);
  },
);

it.each(['first_credit', 'reassign_credit', 'deferred'] as const)(
  '[AC-B2-04g#31] BR-FUND-04⑫：正差获批时状态正常，整笔补给并完成 %s 义务',
  (kind) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 1200n,
        platform_net_fen: 600n,
        beneficiaries: [
          beneficiary({
            net_fen: 0n,
            obligation: { beneficiary_credit_id: 'credit-existing', kind },
          }),
        ],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: 480n,
        net_after_fen: 480n,
        posting: 'user_available',
        pending_before_fen: 400n,
        pending_after_fen: 0n,
        obligation_action: 'done',
        beneficiary_credit_id: 'credit-existing',
        append_forfeited_event: false,
      },
    ]);
    expect(result).toMatchObject({
      route: 'approval',
      platform_delta_fen: 120n,
      union_receivable_delta_fen: 600n,
    });
  },
);

it.each([
  { kind: 'first_credit', append: true },
  { kind: 'reassign_credit', append: true },
  { kind: 'deferred', append: false },
] as const)(
  '[AC-B2-04g#32] BR-FUND-04⑫：封禁整笔归平台关闭 $kind，仅首次整份追加 forfeited',
  ({ kind, append }) => {
    const result = planCommissionAdjustment(
      input({
        platform_net_fen: 600n,
        beneficiaries: [
          beneficiary({
            net_fen: 0n,
            risk_state: 'banned',
            obligation: { beneficiary_credit_id: 'credit-existing', kind },
          }),
        ],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: 0n,
        posting: null,
        forfeit_fen: 240n,
        forfeit_reason: 'banned',
        pending_before_fen: 400n,
        pending_after_fen: 0n,
        obligation_action: 'forfeited',
        beneficiary_credit_id: 'credit-existing',
        append_forfeited_event: append,
      },
    ]);
    // 平台原净额与新应得都为 600，仍需关闭义务，调用方以 rights_event_id 关联。
    expect(result).toMatchObject({
      platform_after_fen: 600n,
      platform_delta_fen: 0n,
      platform_posting: null,
      union_receivable_delta_fen: 0n,
    });
  },
);

it.each([
  { deletion_status: 'processing', is_minor: false, reason: 'deleted' },
  { deletion_status: 'done', is_minor: false, reason: 'deleted' },
  { deletion_status: null, is_minor: true, reason: 'minor' },
] as const)(
  '[AC-B2-04g#33] BR-FUND-04⑫：$reason 只没收延后余额，不抹掉已有净额或追加整份没收事件',
  ({ deletion_status, is_minor, reason }) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 1200n,
        platform_net_fen: 600n,
        beneficiaries: [
          beneficiary({
            role: 'share',
            net_fen: 300n,
            deletion_status,
            is_minor,
            obligation: deferred,
          }),
        ],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: 0n,
        net_after_fen: 300n,
        forfeit_fen: 180n,
        forfeit_reason: reason,
        pending_before_fen: 100n,
        pending_after_fen: 0n,
        obligation_action: 'forfeited',
        append_forfeited_event: false,
      },
    ]);
    expect(result).toMatchObject({ platform_after_fen: 900n, union_receivable_delta_fen: 300n });
  },
);

it.each(['first_credit', 'reassign_credit', 'deferred'] as const)(
  '[AC-B2-04g#34] BR-FUND-08：R8 作废全部未完成 %s 义务与未批候选',
  (kind) => {
    const result = planCommissionAdjustment(
      input({
        n_new_fen: -50n,
        platform_net_fen: 600n,
        beneficiaries: [
          beneficiary({
            net_fen: 300n,
            risk_state: 'frozen',
            obligation: { beneficiary_credit_id: 'credit-existing', kind },
          }),
        ],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: -300n,
        net_after_fen: 0n,
        pending_before_fen: 100n,
        pending_after_fen: 0n,
        obligation_action: 'voided',
        beneficiary_credit_id: 'credit-existing',
        append_forfeited_event: false,
      },
    ]);
    expect(result).toMatchObject({
      transition: 'R8',
      void_pending_candidates: true,
      booked_after: { booked_base_fen: 0n, booked_n_fen: 0n },
      union_receivable_delta_fen: -900n,
    });
  },
);

it('[AC-B2-04g#35] BR-FUND-04⑫：已关闭义务之后又冻结出现待补记额，要求新开义务', () => {
  // 旧义务已关闭：输入只含未完成义务，因此 obligation=null，禁止复用旧 ID。
  const result = planCommissionAdjustment(
    input({
      event: 'settlement',
      n_new_fen: 1200n,
      platform_net_fen: 600n,
      beneficiaries: [beneficiary({ risk_state: 'frozen', obligation: null })],
    }),
  );
  expect(result.beneficiaries).toMatchObject([
    { obligation_action: 'open', beneficiary_credit_id: null, pending_after_fen: 80n },
  ]);
});

it('[AC-B2-04g#39] BR-FUND-09：同单负差立即扣、正差留作待补记，不能逐人另进正差候选', () => {
  const result = planCommissionAdjustment(
    input({
      event: 'settlement',
      reserve_bp: 0n,
      booked_base_fen: 1200n,
      booked_n_fen: 1200n,
      n_new_fen: 1100n,
      platform_net_fen: 480n,
      beneficiaries: [
        beneficiary({ net_fen: 500n, risk_state: 'frozen', obligation: deferred }),
        beneficiary({ user_id: 'u2', role: 'direct', ratio_bp: 1000n, net_fen: 120n }),
      ],
    }),
  );
  expect(result.beneficiaries).toMatchObject([
    {
      user_id: 'u1',
      delta_fen: 0n,
      posting: null,
      pending_before_fen: 100n,
      pending_after_fen: 50n,
      obligation_action: 'keep',
    },
    {
      user_id: 'u2',
      delta_fen: -10n,
      posting: 'user_available',
      net_after_fen: 110n,
      pending_before_fen: 0n,
      pending_after_fen: 0n,
      obligation_action: null,
    },
  ]);
  expect(result).toMatchObject({
    route: 'immediate',
    transition: 'R10',
    platform_after_fen: 440n,
    platform_delta_fen: -40n,
    union_receivable_delta_fen: -50n,
  });
});

it('[AC-B2-04g#40] BR-FUND-09：批准时按当前净额和状态重算，不沿用候选的冻结正差', () => {
  const candidateInput = input({
    event: 'settlement',
    n_new_fen: 1200n,
    platform_net_fen: 600n,
    beneficiaries: [beneficiary({ net_fen: 300n, risk_state: 'frozen', obligation: deferred })],
  });
  const candidate = planCommissionAdjustment(candidateInput);
  expect(candidate.beneficiaries).toMatchObject([
    { delta_fen: 0n, pending_after_fen: 180n, obligation_action: 'keep' },
  ]);
  // 此后旧义务已补记 100 并关闭，批准事务传入最新状态和净额。
  const approved = planCommissionAdjustment({
    ...candidateInput,
    beneficiaries: [beneficiary({ net_fen: 400n, risk_state: 'normal', obligation: null })],
  });
  expect(approved.beneficiaries).toMatchObject([
    {
      delta_fen: 80n,
      net_after_fen: 480n,
      pending_before_fen: 0n,
      pending_after_fen: 0n,
      obligation_action: null,
    },
  ]);
  expect(approved.union_receivable_delta_fen).toBe(200n);
});
