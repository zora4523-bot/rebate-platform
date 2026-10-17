import type { DB } from '@couli/db';
import type { components } from '@couli/contracts-ts';
import type { Transaction } from 'kysely';
import type { Clock, FieldCrypto, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { RiskStateSnapshot } from '../../risk/index.ts';

export interface InviteBindCommand {
  readonly channel: 'register' | 'backfill';
  readonly app_id: string;
  readonly user_id: string;
  readonly invite_code: string;
  /** Server-provided signature device, never a body field. */
  readonly device_id: string;
}

export type InviteBindingResult =
  | { readonly result: 'bound'; readonly parent_id: string; readonly bound_at: Date }
  | {
      readonly result: 'failed';
      readonly code: 10005 | 30401 | 30402 | 30403 | 30404 | 30408 | 30409 | 42901 | 50001;
      readonly retry_after_seconds?: number;
    };

export interface InviteSubject {
  readonly app_id: string;
  readonly user_id: string;
}

/** Consumer-owned read ports; app.module supplies identity's exported readers. */
export interface InviteActivityReader {
  orderCount(subject: { readonly appId: string; readonly userId: string }): Promise<number>;
  hasClaims(subject: { readonly appId: string; readonly userId: string }): Promise<boolean>;
}

export interface RegistrationInviteInput extends InviteSubject {
  readonly invite_code: string;
  readonly device_id?: string;
}

/** Structurally compatible with RegistrationOptions['bindInvite'], without importing Nest. */
export type RegistrationInviteBinding = (
  trx: Transaction<DB>,
  input: RegistrationInviteInput,
) => Promise<components['schemas']['InviteBind']>;

export interface InviteBinderDeps {
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly redis: RedisHandle;
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
  readonly config: {
    configValue(
      appId: string,
      key: string,
    ): Promise<{ readonly value: unknown; readonly version: number } | null>;
  };
  readonly loginDevices: {
    read(trx: Transaction<DB>, subject: InviteSubject): Promise<readonly string[]>;
  };
  readonly activity: (trx: Transaction<DB>) => InviteActivityReader;
  /** The assembler uses risk's readRiskState(subject, { fresh: true }) on this trx. */
  readonly readRisk: (trx: Transaction<DB>, subject: InviteSubject) => Promise<RiskStateSnapshot>;
  /** TODO(规划/11 §2.3): 实名生日读取，未接时为 null — blocked on B1-13d */
  readonly verifiedBirthDate?: (
    trx: Transaction<DB>,
    subject: InviteSubject,
  ) => Promise<string | null>;
}

export interface InviteBinder {
  bind(trx: Transaction<DB>, command: InviteBindCommand): Promise<InviteBindingResult>;
}

/** B1-11d §9.3: caller-owned transaction, one Clock sample, ordered checks, CAS + audit. */
export function createInviteBinder(deps: InviteBinderDeps): InviteBinder {
  void deps;
  throw new Error('NotImplemented: createInviteBinder');
}

/** Identity retains its SAVEPOINT; maps unexpected channel errors to 50001. */
export function createRegistrationInviteBinding(binder: InviteBinder): RegistrationInviteBinding {
  void binder;
  throw new Error('NotImplemented: createRegistrationInviteBinding');
}
