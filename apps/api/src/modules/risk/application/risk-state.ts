import type { RiskState } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, EventBus, TokenPrincipal } from '../../platform/index.ts';

export type RiskReasonCategory =
  'malicious_rights' | 'fraud_invite' | 'abnormal_trade' | 'account_security' | 'other';

export interface RiskSubject {
  readonly app_id: string;
  readonly user_id: string;
}

/** Public read projection: no rule details or raw reason. Dates remain dates inside the API. */
export interface RiskStateSnapshot {
  readonly state: RiskState;
  readonly reason_category: RiskReasonCategory | null;
  readonly frozen_until: Date | null;
}

export interface SetRiskState extends RiskSubject, RiskStateSnapshot {
  readonly reason: string | null;
  readonly changed_by: string;
}

/** Stage ⑤ input, after signature and token checks and stage ④a. */
export interface RiskStateRequest {
  readonly id: string;
  readonly method: string;
  readonly routeOptions: { readonly url?: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly principal?: TokenPrincipal;
  readonly body?: unknown;
}

export interface RiskStateService {
  readRiskState(
    subject: RiskSubject,
    options?: { readonly fresh: boolean },
  ): Promise<RiskStateSnapshot>;
  /** Caller owns commit/rollback; CAS and event publication use exactly this transaction. */
  setRiskState(trx: Transaction<DB>, command: SetRiskState): Promise<void>;
  /** Post-miss callers pass their claim transaction; must not acquire a second connection. */
  checkRequest(request: RiskStateRequest, trx?: Transaction<DB>): Promise<void>;
}

export interface RiskStateOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly events: EventBus;
}

export function createRiskStateService(options: RiskStateOptions): RiskStateService {
  void options;
  throw new Error('NotImplemented: createRiskStateService');
}

/** DI token of the same service instance used by the guard and post-miss hook. */
export function riskStateServiceToken(): symbol {
  throw new Error('NotImplemented: riskStateServiceToken');
}
