import type { PushChannelAnswer } from '../resilience/index.ts';

/** Routing information belongs to the transport envelope, never the device payload. */
export interface PushTarget {
  readonly provider: string;
  readonly token: string;
}

export interface PushPayload {
  readonly message_id: string;
  readonly title: string;
  readonly body: string;
}

export interface PushDeliveryChannel {
  send(
    targets: readonly PushTarget[],
    payload: PushPayload,
    signal: AbortSignal,
  ): Promise<PushChannelAnswer>;
}
