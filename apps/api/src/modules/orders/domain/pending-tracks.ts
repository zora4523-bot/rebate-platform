import type { Schema } from '@couli/contracts-ts';
import type { PendingAttempt } from '../../linking/index.ts';

export interface PendingTrackOrder {
  link_id: string | null;
  attr_at: Date;
  source_match: string | null;
}

export interface SelectPendingTracksInput {
  now: Date;
  toleranceSec: number;
  attempts: readonly PendingAttempt[];
  orders: readonly PendingTrackOrder[];
}

export function selectPendingTracks(input: SelectPendingTracksInput): Schema<'PendingTrack'>[] {
  void input;
  throw new Error('NotImplemented: selectPendingTracks');
}
