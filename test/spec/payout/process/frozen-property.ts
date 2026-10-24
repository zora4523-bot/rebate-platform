// B2-06d ⑧ (B2-05e 不变量 06 carried over; 规划/08 BR-WDR-09, BR-WDR-13, BR-WDR-14): under any
// sequence of transfer-job deliveries — every synchronous result (success, definite failure,
// payer side, a code outside the lists, unknown, timeout), a review hold (single_cap, and the
// queue_paused holds a pause causes), and redeliveries of the same job — after every delivery:
//   frozen_fen = Σ amount_fen of the member's withdrawals in PENDING_REVIEW / APPROVED / PAYING;
//   available_fen + frozen_fen + Σ amount_fen of PAID_API = what the member was funded with;
//   wd:{id}:PAID exists exactly for PAID_API, wd:{id}:RETURN exactly for FAILED;
//   the channel saw at most one transfer per out_biz_no.
// Real PG, real ledger, real queue; each generated case uses a fresh member (the job commits its
// own transactions, so nothing is rolled back). test/properties/README.md: the property body
// returns a boolean (no expect inside); the entry (frozen.int.test.ts) makes the one summary
// assertion on the returned statistics.
import { addFen } from '@couli/money';
import { createPropStats, propParams, type PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';
import type { FakeStep } from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import {
  FAIL_STEP,
  PAYER_SIDE_STEP,
  SINGLE_CAP,
  TIMEOUT_STEP,
  UNKNOWN_STEP,
  UNLISTED_STEP,
  balanceOf,
  scripted,
  successStep,
  withdrawalVouchers,
  type ProcessFixture,
  type ScriptedChannel,
  type Seeded,
} from './kit.ts';

export const OUTCOMES = [
  'success',
  'fail',
  'payer_side',
  'unlisted',
  'unknown',
  'timeout',
  'single_cap',
] as const;
type Outcome = (typeof OUTCOMES)[number];

const OPEN: ReadonlySet<string> = new Set(['PENDING_REVIEW', 'APPROVED', 'PAYING']);

function stepOf(outcome: Outcome, w: Seeded): FakeStep | null {
  switch (outcome) {
    case 'success':
      return successStep(`CH${w.outBizNo}`);
    case 'fail':
      return FAIL_STEP;
    case 'payer_side':
      return PAYER_SIDE_STEP;
    case 'unlisted':
      return UNLISTED_STEP;
    case 'unknown':
      return UNKNOWN_STEP;
    case 'timeout':
      return TIMEOUT_STEP;
    case 'single_cap':
      return null;
  }
}

const plan = fc.record({
  outcome: fc.constantFrom(...OUTCOMES),
  net: fc.bigInt({ min: 1n, max: BigInt(SINGLE_CAP) }),
  fee: fc.bigInt({ min: 0n, max: 300n }),
  tax: fc.bigInt({ min: 0n, max: 300n }),
});

async function consistent(
  f: ProcessFixture,
  owner: string,
  funded: bigint,
  transfers: () => readonly { outBizNo: string }[],
): Promise<boolean> {
  const rows = await f.h.observer
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(['id', 'status', 'amount_fen'])
    .where('app_id', '=', f.appId)
    .where('user_id', '=', owner)
    .execute();
  const open = rows
    .filter((row) => OPEN.has(row.status))
    .reduce((total, row) => addFen(total, row.amount_fen), 0n);
  const paid = rows
    .filter((row) => row.status === 'PAID_API')
    .reduce((total, row) => addFen(total, row.amount_fen), 0n);
  const balance = await balanceOf(f, owner);
  const keys = new Set(await withdrawalVouchers(f));
  const counts = new Map<string, number>();
  for (const request of transfers()) {
    counts.set(request.outBizNo, (counts.get(request.outBizNo) ?? 0) + 1);
  }
  return (
    balance.frozen_fen === open &&
    addFen(addFen(balance.available_fen, balance.frozen_fen), paid) === funded &&
    rows.every(
      (row) =>
        keys.has(`wd:${row.id}:PAID`) === (row.status === 'PAID_API') &&
        keys.has(`wd:${row.id}:RETURN`) === (row.status === 'FAILED'),
    ) &&
    [...counts.values()].every((count) => count <= 1)
  );
}

/** Runs the property; returns its generator statistics (flushed) for the entry's one assertion. */
export async function assertFrozenInvariant(f: ProcessFixture): Promise<PropStatsRecord> {
  const stats = createPropStats('B2-06d:frozen-invariant');
  // One handler for every case (built first: red is the skeleton's NotImplemented, not a
  // counterexample); its channel forwards to the current case's scripted FakeChannel.
  let current: ScriptedChannel = scripted({});
  const handler = f.job({
    transfer: (request) => current.channel.transfer(request),
    query: (outBizNo) => current.channel.query(outBizNo),
  });
  // Far above Σ net of every run of one seed: daily_cap never masks the generated outcomes.
  await f.set('payout.daily_cap_fen', 9_000_000_000_000);
  await fc.assert(
    fc.asyncProperty(
      fc.array(plan, { minLength: 1, maxLength: 3 }),
      fc.array(fc.nat({ max: 5 }), { maxLength: 6 }),
      async (plans, deliveries) => {
        stats.hit('run');
        for (const outcome of new Set(plans.map((each) => each.outcome))) stats.hit(outcome);
        await f.set('payout.queue_paused', false);
        const amounts = plans.map((each) => {
          const net = each.outcome === 'single_cap' ? BigInt(SINGLE_CAP) + each.net : each.net;
          return { net, fee: each.fee, tax: each.tax };
        });
        const funded = amounts.reduce(
          (total, each) => addFen(total, addFen(addFen(each.net, each.fee), each.tax)),
          1_000n,
        );
        const owner = await f.newUser(funded);
        const seeded: Seeded[] = [];
        for (const each of amounts) seeded.push(await f.seedWithdrawal({ userId: owner, ...each }));
        const steps: Record<string, FakeStep[]> = {};
        seeded.forEach((w, i) => {
          const step = stepOf(plans[i]!.outcome, w);
          if (step !== null) steps[w.outBizNo] = [step];
        });
        const ch = scripted(steps);
        current = ch;
        const order = [...deliveries.map((i) => seeded[i % seeded.length]!), ...seeded];
        let valid = await consistent(f, owner, funded, ch.transfers);
        for (const w of order) {
          await handler(f.jobOf(w));
          valid &&= await consistent(f, owner, funded, ch.transfers);
          if (!valid) break;
        }
        return valid;
      },
    ),
    propParams(),
  );
  return stats.flush();
}

/** The one summary of the entry: runs, discards, and the outcomes hit in fewer than 1% of runs. */
export function summarize(record: PropStatsRecord) {
  const runs = record.hits['run'] ?? 0;
  return {
    runs,
    discards: record.discards,
    thin: OUTCOMES.filter((outcome) => (record.hits[outcome] ?? 0) * 100 < runs),
  };
}
