import type { PidScene, components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type PidPlatform = components['schemas']['PlatformCode'];
export type PidStatus = 'pending' | 'active' | 'retired';
export type AccountRow = Selectable<DB['union_accounts']>;
export type PidRow = Selectable<DB['union_pids']>;

/** Structural match for F1-06b's combined super-account and TOTP verifier. */
export interface VerifiedSuper {
  readonly appId: string;
  readonly adminId: string;
}

export interface SuperVerification {
  verify(request: VerifiedSuper & { readonly code: string }): Promise<VerifiedSuper | null>;
}

/** Structural match for F1-06b's audit writer; union never imports admin. */
export interface UnionAuditInput {
  readonly appId: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly before: DB['audit_logs']['before'];
  readonly after: DB['audit_logs']['after'];
  readonly ip: string | null;
}

export interface UnionAuditWriter {
  append(input: UnionAuditInput): Promise<void>;
}

export interface PidServiceDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly superVerifier: SuperVerification;
  /** Bind the injected writer to the command transaction, e.g. createAuditWriter({db, clock}). */
  readonly auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
}

export interface WriteContext {
  readonly appId: string;
  readonly adminId: string;
  readonly code: string;
  readonly ip: string | null;
}

export interface RegisterAccountInput extends WriteContext {
  readonly platform: PidPlatform;
  readonly accountName: string;
  readonly authStatus: 'active' | 'expiring' | 'expired';
  readonly authExpiresAt: Date | null;
}

export interface RegisterPidInput extends WriteContext {
  readonly platform: PidPlatform;
  readonly unionAccountId: string;
  readonly siteId: string | null;
  readonly pid: string;
  readonly pidScene: PidScene;
}

export interface PidWriteInput extends WriteContext {
  readonly pidId: string;
}

export interface ConfirmHjyInput extends PidWriteInput {
  readonly confirmedAt: Date;
  readonly evidencePath: string;
}

export interface SetPidStatusInput extends PidWriteInput {
  readonly status: 'active' | 'retired';
}

export interface ActivePidInput {
  readonly appId: string;
  readonly platform: PidPlatform;
  readonly pidScene: PidScene;
  /** query 位仅供查价；fallback 从不用于转链。 */
  readonly purpose: 'convert' | 'query';
}

export interface WhitelistInput {
  readonly appId: string;
  readonly platform: PidPlatform;
  readonly unionAccountId: string;
  readonly siteId: string | null;
  readonly pid: string;
}

/** No delete, arbitrary update, caller-supplied status or caller-supplied sync start API. */
export interface UnionPidService {
  registerAccount(input: RegisterAccountInput): Promise<AccountRow>;
  registerPid(input: RegisterPidInput): Promise<PidRow>;
  confirmHjyIgnore(input: ConfirmHjyInput): Promise<PidRow>;
  setPidStatus(input: SetPidStatusInput): Promise<PidRow>;
  getActivePid(input: ActivePidInput): Promise<PidRow | null>;
  isWhitelisted(input: WhitelistInput): Promise<boolean>;
}

export function createUnionPidService(deps: PidServiceDeps): UnionPidService {
  void deps;
  throw new Error('NotImplemented: createUnionPidService');
}
