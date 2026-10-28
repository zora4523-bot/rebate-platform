// B2-06f: the payout process's runtime (规划/08 BR-WDR-13, BR-WDR-14). PayoutModule.forPayout
// provides it under payoutRuntimeToken() on the payout entry only (null without a database or job
// queue). entry.ts resolves PAYOUT_MODE first (payout-mode.ts, the only guard), then resolves the
// token optionally (as the worker's order sync) and calls start(decision) once, before the queue
// starts: start registers the one handler of queue `payout` (job `transfer` → jobs/transfer-job.ts,
// job `query` → jobs/query-job.ts) over the process's handle, the injected Clock and content's
// configuration reader (switches read straight from PG, no Redis), with the channels of the
// decision: dry_run → FakeChannel (never the network), live → AlipayChannel with the injected
// credentials. start trusts the decision it is given; neither it nor its logs carry a credential.
import type { PayoutChannel, PayoutChannelName } from './infra/channels/payout-channel.ts';
import type { PayoutMode, PayoutModeDecision } from './payout-mode.ts';

export interface PayoutStarted {
  readonly mode: PayoutMode;
  /** The adapter of each channel the handlers can call. */
  readonly channels: Readonly<Partial<Record<PayoutChannelName, PayoutChannel>>>;
}

export interface PayoutRuntime {
  /** Registers queue `payout`; called once, before the queue starts. */
  start(decision: PayoutModeDecision): PayoutStarted;
}

/** The DI token of the payout process's runtime; the same symbol on every call. */
export function payoutRuntimeToken(): symbol {
  throw new Error('NotImplemented: payoutRuntimeToken');
}
