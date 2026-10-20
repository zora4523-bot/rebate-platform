import { isDeepStrictEqual } from 'node:util';
import {
  checkCreditInvariant,
  planBeneficiaryCredit,
  planInitialCredit,
  type CreditBeneficiaryState,
} from '@couli/domain';
import { createPropStats, propParams, type PropStats } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  deepFreeze,
  initial,
  materialize,
  normal,
  person,
  position,
  supplemental,
} from '../../../../spec/domain/settlement/credit/fixtures.ts';

const state: fc.Arbitrary<CreditBeneficiaryState> = fc.record({
  risk_state: fc.constantFrom('normal', 'frozen', 'appealing', 'banned'),
  deletion_status: fc.constantFrom(null, 'cooling', 'processing', 'done', 'cancelled'),
  is_minor: fc.boolean(),
});
const fen = fc.oneof(
  fc.constantFrom(0n, 1n, 1234n, 9007199254740993n),
  fc.bigInt({ min: 0n, max: 4000000000000000000n }),
);

function property<T>(
  name: string,
  arbitrary: fc.Arbitrary<T>,
  predicate: (value: T, stats: PropStats) => boolean,
): boolean {
  const stats = createPropStats(`domain:settlement:credit:${name}`);
  try {
    fc.assert(
      fc.property(arbitrary, (value) => predicate(value, stats)),
      propParams(),
    );
    return true;
  } finally {
    stats.flush();
  }
}

it('[AC-B2-04e#60] 属性：Σ各份额+基础平台=B+预留，已出凭证+暂缓=B+预留，逐份floor', () => {
  expect(
    property(
      'conservation',
      fc.record({
        base: fen,
        reserve: fc.bigInt({ min: 0n, max: 1000000n }),
        own: fc.bigInt({ min: 0n, max: 5000n }),
        direct: fc.bigInt({ min: 0n, max: 2000n }),
        indirect: fc.bigInt({ min: 0n, max: 1000n }),
        states: fc.tuple(state, state, state),
        forfeited: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
        ownerRole: fc.constantFrom('self' as const, 'share' as const),
      }),
      (data, stats) => {
        const people = [
          person(data.ownerRole, data.own, data.states[0]),
          person('direct', data.direct, data.states[1]),
          person('indirect', data.indirect, data.states[2]),
        ].map((p, i) => ({
          ...p,
          snapshot_status: data.forfeited[i] ? ('forfeited' as const) : ('active' as const),
        }));
        const input = deepFreeze(
          initial({ b_credit_fen: data.base, reserve_fen: data.reserve, beneficiaries: people }),
        );
        const before = structuredClone(input);
        const plan = planInitialCredit(input);
        stats.hit(data.base === 0n ? 'zero' : 'positive');
        if (data.base > 9007199254740991n) stats.hit('above_safe_integer');
        for (const p of plan.beneficiaries) stats.hit(p.action);
        // 独立 bigint 测试预言机，不调用被测拆分函数构造期望。
        const expectedShares = people.map((p) =>
          p.snapshot_status === 'forfeited' ? 0n : (data.base * p.ratio_bp) / 10000n,
        );
        const expectedActions = people.map((p) => {
          const s = p.current;
          if (
            p.snapshot_status === 'forfeited' ||
            s.deletion_status === 'processing' ||
            s.deletion_status === 'done' ||
            s.risk_state === 'banned' ||
            (s.is_minor && p.role !== 'self')
          )
            return 'forfeited';
          return s.risk_state === 'frozen' || s.risk_state === 'appealing' ? 'held' : 'credit';
        });
        const shares = plan.beneficiaries.reduce((sum, p) => sum + p.share_fen, 0n);
        const held = plan.beneficiaries
          .filter((p) => p.action === 'held')
          .reduce((sum, p) => sum + p.share_fen, 0n);
        const vouchers = materialize(plan.vouchers);
        const receivable = vouchers
          .flatMap((v) => v.entries)
          .filter((e) => e.account.subject === 'UNION_RECEIVABLE:taobao')
          .reduce((sum, e) => sum + e.amount_fen, 0n);
        return (
          isDeepStrictEqual(
            plan.beneficiaries.map((p) => p.share_fen),
            expectedShares,
          ) &&
          isDeepStrictEqual(
            plan.beneficiaries.map((p) => p.action),
            expectedActions,
          ) &&
          plan.beneficiaries.every(
            (p, i) =>
              p.open_initial_obligation === (expectedActions[i] === 'held' && p.share_fen > 0n),
          ) &&
          shares + plan.platform_credit_fen === data.base + data.reserve &&
          plan.platform_credit_fen === plan.platform_retain_fen + data.reserve &&
          receivable + held === data.base + data.reserve &&
          vouchers.every((v) => v.entries.reduce((sum, e) => sum + e.amount_fen, 0n) === 0n) &&
          plan.vouchers.length === vouchers.length &&
          isDeepStrictEqual(input, before)
        );
      },
    ),
  ).toBe(true);
});

it('[AC-B2-04e#61] 属性：每用户角色最多一个入账/义务意图，重放同键，跨平台不同键', () => {
  expect(
    property('identity-and-replay', fc.tuple(fen, state), ([base, current], stats) => {
      stats.hit(current.risk_state);
      const input = initial({
        b_credit_fen: base,
        reserve_fen: 0n,
        beneficiaries: [
          person('self', 5000n, current),
          person('direct', 1000n),
          person('indirect', 500n),
        ],
      });
      const plan = planInitialCredit(input);
      const keys = materialize(plan.vouchers).map((v) => v.uniq_key);
      const otherKeys = materialize(planInitialCredit({ ...input, platform: 'jd' }).vouchers).map(
        (v) => v.uniq_key,
      );
      const open = plan.beneficiaries
        .filter((p) => p.open_initial_obligation)
        .map((p) => `${p.user_id}:${p.role}`);
      const credited = materialize(plan.vouchers).flatMap((v) =>
        v.entries.filter((e) => e.account.owner_type === 'user').map((e) => e.account.owner_id),
      );
      return (
        new Set(keys).size === keys.length &&
        new Set(open).size === open.length &&
        new Set(credited).size === credited.length &&
        plan.beneficiaries.every(
          (p) => !p.open_initial_obligation || (p.action === 'held' && p.share_fen > 0n),
        ) &&
        isDeepStrictEqual(planInitialCredit(input), plan) &&
        otherKeys.every((k) => !keys.includes(k))
      );
    }),
  ).toBe(true);
});

it('[AC-B2-04e#62] 属性：⑤按每份剩余截零、仅未完成义务计入，应收差一分必失败', () => {
  expect(
    property(
      'invariant',
      fc.record({
        base: fen,
        reserve: fc.bigInt({ min: 0n, max: 1000000n }),
        ratio: fc.bigInt({ min: 0n, max: 10000n }),
        net: fen,
        open: fc.boolean(),
      }),
      (data, stats) => {
        stats.hit(data.open ? 'open' : 'closed');
        const due = (data.base * data.ratio) / 10000n;
        const pending = data.open && due > data.net ? due - data.net : 0n;
        const expected = data.base + data.reserve - pending;
        const input = {
          booked_base_fen: data.base,
          booked_n_fen: data.base + data.reserve,
          union_receivable_net_fen: expected,
          positions: [
            position({ ratio_bp: data.ratio, net_fen: data.net, has_open_obligation: data.open }),
          ],
        };
        const result = checkCreditInvariant(input);
        stats.hit(pending === 0n ? 'no_pending' : 'pending');
        return (
          result.pending_credit_fen === pending &&
          result.beneficiary_net_fen === data.net &&
          result.expected_receivable_fen === expected &&
          result.receivable_matches &&
          result.beneficiary_net_within_base === data.net <= data.base &&
          result.valid === data.net <= data.base &&
          !checkCreditInvariant({ ...input, union_receivable_net_fen: expected + 1n }).valid
        );
      },
    ),
  ).toBe(true);
});

it('[AC-B2-04e#63] 属性：补记或没收只处置剩余；关闭义务后旧执行项不再产出凭证', () => {
  expect(
    property(
      'remaining-and-close',
      fc.record({ base: fen, netBp: fc.bigInt({ min: 0n, max: 5000n }), banned: fc.boolean() }),
      (data, stats) => {
        const due = (data.base * 5000n) / 10000n;
        const net = (data.base * data.netBp) / 10000n;
        const pending = due - net;
        const input = supplemental({
          booked_base_fen: data.base,
          booked_n_fen: data.base,
          union_receivable_net_fen: data.base - pending,
          positions: [position({ net_fen: net })],
          current: { ...normal, risk_state: data.banned ? 'banned' : 'normal' },
        });
        const plan = planBeneficiaryCredit(input);
        stats.hit(data.banned ? 'forfeit' : 'credit');
        stats.hit(pending === 0n ? 'zero' : 'positive');
        const vouchers = materialize(plan.vouchers);
        const receivable = vouchers
          .flatMap((v) => v.entries)
          .filter((e) => e.account.subject === 'UNION_RECEIVABLE:taobao')
          .reduce((sum, e) => sum + e.amount_fen, 0n);
        const closedInput = {
          ...input,
          union_receivable_net_fen: data.base,
          positions: [position({ net_fen: data.banned ? net : due, has_open_obligation: false })],
          obligation: {
            ...input.obligation,
            status: data.banned ? ('forfeited' as const) : ('completed' as const),
          },
        };
        const replay = planBeneficiaryCredit(closedInput);
        return (
          plan.remaining_fen === pending &&
          plan.action === (data.banned ? 'forfeited' : 'credit') &&
          plan.obligation_action === (data.banned ? 'forfeit' : 'complete') &&
          !plan.append_forfeited_event &&
          !plan.alert &&
          receivable === pending &&
          vouchers.length === (pending === 0n ? 0 : 1) &&
          replay.action === 'skipped' &&
          replay.skip_reason === 'obligation_closed' &&
          replay.vouchers.length === 0 &&
          checkCreditInvariant(closedInput).valid
        );
      },
    ),
  ).toBe(true);
});
