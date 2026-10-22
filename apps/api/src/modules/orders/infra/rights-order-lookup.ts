import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import type { RegisteredPlatform } from '../../union/index.ts';

export interface RightsOrderLookupInput {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly platform_order_no: string;
}

export type RightsOrderLookupResult =
  | { readonly kind: 'found'; readonly order: Selectable<DB['orders']> }
  | { readonly kind: 'sub_order_no_missing' }
  | { readonly kind: 'not_found' };

/**
 * Read-only exact sub_order_id lookup within app + platform (PDD strips hyphens).
 * A parent-only hit is diagnostic, never a list of children or a command target.
 * This result is NOT a locked snapshot: caller must lockOrderKey and reread FOR UPDATE
 * before sending a command through the settlement ports.
 */
export async function findOrderForRights(
  db: Kysely<DB>,
  input: RightsOrderLookupInput,
): Promise<RightsOrderLookupResult> {
  void db;
  void input;
  throw new Error('NotImplemented: findOrderForRights');
}
