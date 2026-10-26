// B2-06d ③ (规划/08 BR-WDR-13 ③): the pure review of application/payout-review.ts. Every subset of
// the six failing checks yields the earliest one in the fixed order payout_disabled →
// queue_paused → channel_disabled → member_blocked → single_cap → daily_cap (none → ok); the caps
// compare exactly in bigint fen (net = cap passes, sent + net = cap passes), beyond 2^53 too.
import { expect, it } from 'vitest';
import {
  reviewTransfer,
  type TransferHoldReason,
  type TransferReviewInput,
  type TransferReviewVerdict,
} from '../../../../apps/api/src/modules/payout/application/payout-review.ts';

const ORDER: readonly TransferHoldReason[] = [
  'payout_disabled',
  'queue_paused',
  'channel_disabled',
  'member_blocked',
  'single_cap',
  'daily_cap',
];

const PASS: TransferReviewInput = Object.freeze({
  payoutEnabled: true,
  queuePaused: false,
  channelOpen: true,
  memberBlocked: false,
  netFen: 1000n,
  singleCapFen: 1000n,
  dailySentFen: 0n,
  dailyCapFen: 1000n,
});

/** PASS with exactly the checks of `reasons` failing (each by the smallest step past its edge). */
function failing(reasons: ReadonlySet<TransferHoldReason>): TransferReviewInput {
  return Object.freeze({
    ...PASS,
    payoutEnabled: !reasons.has('payout_disabled'),
    queuePaused: reasons.has('queue_paused'),
    channelOpen: !reasons.has('channel_disabled'),
    memberBlocked: reasons.has('member_blocked'),
    singleCapFen: reasons.has('single_cap') ? 999n : 1000n,
    dailySentFen: reasons.has('daily_cap') ? 1n : 0n,
  });
}

it('[AC-B2-06d#3] 六项复核的全部 64 种组合：结果恰为顺序中最前一项不满足的原因，全满足为通过', () => {
  const got: TransferReviewVerdict[] = [];
  const want: TransferReviewVerdict[] = [];
  for (let mask = 0; mask < 1 << ORDER.length; mask += 1) {
    const reasons = new Set(ORDER.filter((_, bit) => (mask & (1 << bit)) !== 0));
    got.push(reviewTransfer(failing(reasons)));
    const first = ORDER.find((reason) => reasons.has(reason));
    want.push(first === undefined ? { ok: true } : { ok: false, reason: first });
  }
  expect(got).toEqual(want);
});

it('[AC-B2-06d#3] 限额按分精确比较，超过 2^53 也不丢精度：net = single_cap 通过、多 1 分即 single_cap；已发出 + net = daily_cap 通过、多 1 分即 daily_cap', () => {
  const big = 2n ** 60n;
  const at = (values: Partial<TransferReviewInput>) => reviewTransfer({ ...PASS, ...values });
  expect([
    at({ netFen: big, singleCapFen: big, dailyCapFen: big }),
    at({ netFen: big + 1n, singleCapFen: big, dailyCapFen: big * 2n }),
    at({ netFen: 1n, singleCapFen: big, dailySentFen: big, dailyCapFen: big + 1n }),
    at({ netFen: 2n, singleCapFen: big, dailySentFen: big, dailyCapFen: big + 1n }),
    at({ netFen: 0n, singleCapFen: 1n, dailySentFen: 5n, dailyCapFen: 5n }),
  ]).toEqual([
    { ok: true },
    { ok: false, reason: 'single_cap' },
    { ok: true },
    { ok: false, reason: 'daily_cap' },
    { ok: true },
  ]);
});
