import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { PendingAttemptStore } from '../../linking/index.ts';
import type { Clock } from '../../platform/index.ts';
import type { OrderSubject } from './order-queries.ts';

export interface PendingTracksDeps {
  db: Kysely<DB>;
  clock: Clock;
  config: ContentReader;
  attempts: PendingAttemptStore;
}

export class PendingTracks {
  list(subject: OrderSubject): Promise<Schema<'PendingTracksData'>> {
    void subject;
    throw new Error('NotImplemented: PendingTracks.list');
  }

  dismiss(subject: OrderSubject, linkId: string, attemptId: string): Promise<void> {
    void subject;
    void linkId;
    void attemptId;
    throw new Error('NotImplemented: PendingTracks.dismiss');
  }
}

export function createPendingTracks(deps: PendingTracksDeps): PendingTracks {
  void deps;
  throw new Error('NotImplemented: createPendingTracks');
}
