// GET /v1/me (04 §6.1; task B1-02z): the current user's view, read-only, by the token's app_id and
// uid only. Skeleton of the rule-test stage: the implementation (and its controller, Nest wiring
// and app.module assembly of the ports below) is the implementer's.
//
// - identity_level from the database (BR-ID-01): phone when users.phone_hmac is set, else member;
//   realname_status none until the real-name task (BR-ID-25).
// - invite_code null when banned, or appealing with a processing account appeal whose
//   prev_risk_state is banned (BR-INV-18); inviter_bound = parent_id set.
// - invite_backfill per BR-INV-07 (a)(b)(c) and growth.invite_bind.enabled (BR-INV-21);
//   deadline_at = created_at + invite.backfill_hours when eligible, else null.
// - balance through MeBalancePort (ledger, B2; zero default assembled by app.module).
// - union_bindings taobao then pdd through MeUnionBindingsPort (linking's binding projection).
// - need_reconsent per BR-ID-12: the user-level current state of privacy or agreement is not
//   accepted, or its version is below legal.privacy.version / legal.agreement.version.
// - risk: risk's readRiskState snapshot.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { RiskStateService } from '../../risk/index.ts';
import type { SmsConfigReader } from './sms-codes.ts';

export type Me = components['schemas']['Me'];
export type MeBalance = components['schemas']['MeBalance'];
export type MeUnionBindingStatus = components['schemas']['UnionBindingState']['status'];
export type MeUnionPlatform = 'taobao' | 'pdd';

/** Only from the verified token (BR-AI-03 口径): never from request parameters. */
export interface MeSubject {
  readonly appId: string;
  readonly userId: string;
}

/** The single-balance summary (ADD-06); ledger owns it. */
export interface MeBalancePort {
  balanceOf(subject: MeSubject): Promise<MeBalance>;
}

/** linking's read-only binding projection (BR-ID-17 细则「授权管理页」); no row → unbound. */
export interface MeUnionBindingsPort {
  statusOf(subject: MeSubject, platform: MeUnionPlatform): Promise<MeUnionBindingStatus>;
}

/**
 * BR-INV-07 (c) inputs owned by other modules: orders attributed to the user (any status) and
 * recovery claims (any status; none until B1-10). Shared with the backfill bind (B1-20a).
 */
export interface InviteBackfillActivityPort {
  orderCount(subject: MeSubject): Promise<number>;
  hasClaims(subject: MeSubject): Promise<boolean>;
}

export interface MeServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: SmsConfigReader;
  readonly risk: Pick<RiskStateService, 'readRiskState'>;
  readonly balance: MeBalancePort;
  readonly unionBindings: MeUnionBindingsPort;
  readonly activity: InviteBackfillActivityPort;
}

export interface MeService {
  read(subject: MeSubject): Promise<Me>;
}

export function createMeService(options: MeServiceOptions): MeService {
  void options;
  throw new Error('NotImplemented: createMeService');
}
