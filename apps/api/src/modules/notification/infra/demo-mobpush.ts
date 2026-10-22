// B1-12o: demonstration MobPush channel (AGENTS 硬规则 7). It never opens a connection, holds no
// credentials and fabricates no vendor message: every send answers the preset accepted / rejected.
import type { PushDeliveryChannel } from '../ports/push-delivery.ts';
import type { PushChannelAnswer } from '../resilience/index.ts';

/** Demonstration only: no vendor protocol, credentials or network access. */
export function createDemoMobPush(answer: PushChannelAnswer): PushDeliveryChannel {
  const status = answer.status;
  return {
    async send(targets, payload, signal) {
      void targets;
      void payload;
      signal.throwIfAborted();
      return status === 'accepted' ? { status: 'accepted' } : { status: 'rejected' };
    },
  };
}
