// PATCH /v1/me (04 §6.1; BR-ID-39; task B1-20d): change the current user's nickname.
//
// Order (§9.3 #5, §9.4): trimmed length 1–16 extended grapheme clusters (else 20001 fields) →
// the same as the current nickname answers 0 with no change → the month's 3 successful changes
// used (+08:00 natural month) answers 30415 without a review → content-safety review (anything
// but 'pass' is 20001 reason=nickname_sensitive) → a conditional update of the user's own row
// (losing the race is 30415). Only the default nickname given at account creation is free; every
// successful change counts (§9.4 D30). A success writes one pino info line
// identity_nickname_changed with the old value masked (§9.4 D31).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { NicknameReviewPort } from '../ports/nickname-review.ts';

export interface UpdateNicknameCommand {
  readonly appId: string;
  readonly userId: string;
  /** The nickname as submitted (untrimmed). */
  readonly nickname: string;
}

export type UpdateNicknameResult =
  | { readonly code: 0 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20001; readonly data: { readonly reason: 'nickname_sensitive' } }
  | { readonly code: 30415 };

export interface UpdateNicknameOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
  readonly review: NicknameReviewPort;
}

export interface UpdateNicknameService {
  update(command: UpdateNicknameCommand): Promise<UpdateNicknameResult>;
}

export function createUpdateNicknameService(options: UpdateNicknameOptions): UpdateNicknameService {
  void options;
  throw new Error('NotImplemented: createUpdateNicknameService');
}
