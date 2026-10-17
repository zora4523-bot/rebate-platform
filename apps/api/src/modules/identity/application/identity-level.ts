import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContractAuth, IdempotencyPostMissCheck } from '../../platform/index.ts';
import type { MinimumVersionRequest } from '../../risk/index.ts';

export type RealnameStatus = 'none' | 'verified' | 'failed';

/** Read-only, uncached; the handle is the claim transaction on the post-miss path. */
export interface RealnameStatusReader {
  read(
    handle: Kysely<DB>,
    subject: { readonly app_id: string; readonly user_id: string },
  ): Promise<RealnameStatus>;
}

export interface IdentityLevelInput {
  readonly required: ContractAuth | undefined;
  readonly phoneBound: boolean;
  readonly realnameStatus: RealnameStatus;
}

export interface IdentityLevelGuard {
  canActivate(context: {
    switchToHttp(): { getRequest(): MinimumVersionRequest };
  }): Promise<boolean>;
}

export interface IdentityLevelChecks {
  readonly guard: IdentityLevelGuard;
  readonly postMiss: IdempotencyPostMissCheck;
}

export interface IdentityLevelOptions {
  readonly db: Kysely<DB> | null;
  readonly realname: RealnameStatusReader;
}

/** BR-ID-01: phone before realname; lower auth levels impose neither check. */
export function identityLevelRefusal(input: IdentityLevelInput): null | 10005 | 30304 {
  void input;
  throw new Error('NotImplemented: identityLevelRefusal');
}

/** Contract-driven ⑧⑨; app.module supplies both parts to risk's ordered lists. */
export function createIdentityLevelChecks(options: IdentityLevelOptions): IdentityLevelChecks {
  void options;
  throw new Error('NotImplemented: createIdentityLevelChecks');
}

/**
 * The implementation-stage default must read as none.
 * TODO(规划/11 §2.3): 实名状态读 app.realname — blocked on B1-13d
 */
export function createDefaultRealnameStatusReader(): RealnameStatusReader {
  throw new Error('NotImplemented: createDefaultRealnameStatusReader');
}
