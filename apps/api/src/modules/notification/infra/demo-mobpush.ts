import type { PushDeliveryChannel } from '../ports/push-delivery.ts';
import type { PushChannelAnswer } from '../resilience/index.ts';

/** Demonstration only: no vendor protocol, credentials or network access. */
export function createDemoMobPush(answer: PushChannelAnswer): PushDeliveryChannel {
  void answer;
  throw new Error('NotImplemented: createDemoMobPush');
}
