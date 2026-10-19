import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { Clock, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { OrderSubject } from './order-queries.ts';

export interface OrderClaimDeps {
  readonly db?: Kysely<DB>;
  readonly redis?: RedisHandle;
  readonly clock: Clock;
  readonly config: ContentReader;
  readonly logger: RootLogger;
}

export type ClaimFailure = {
  readonly code: 20001 | 30201 | 30202 | 30203 | 30204 | 30205 | 30206 | 50001;
  readonly data?: { readonly reason: string } | { readonly fields: readonly string[] };
};
export type ClaimResult<T> = { readonly code: 0; readonly data: T } | ClaimFailure;
export interface ClaimListInput {
  readonly cursor?: string;
  readonly limit?: number;
}

/** B1-10b: application entry shared by HTTP and rule tests; HTTP owns idempotency. */
export function createOrderClaim(
  deps: OrderClaimDeps,
  subject: OrderSubject,
  input: Schema<'CreateOrderClaimRequest'>,
): Promise<ClaimResult<Schema<'OrderClaim'>>> {
  void deps;
  void subject;
  void input;
  throw new Error('NotImplemented: createOrderClaim');
}

export function listOrderClaims(
  deps: OrderClaimDeps,
  subject: OrderSubject,
  input: ClaimListInput,
): Promise<ClaimResult<Schema<'OrderClaimListData'>>> {
  void deps;
  void subject;
  void input;
  throw new Error('NotImplemented: listOrderClaims');
}
