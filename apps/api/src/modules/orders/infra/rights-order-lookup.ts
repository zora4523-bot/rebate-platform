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
  // PDD order numbers are stored without hyphens; other platforms keep the number verbatim.
  const no =
    input.platform === 'pdd'
      ? input.platform_order_no.replaceAll('-', '')
      : input.platform_order_no;
  const order = await db
    .withSchema('app')
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', input.app_id)
    .where('platform', '=', input.platform)
    .where('sub_order_id', '=', no)
    .executeTakeFirst();
  if (order !== undefined) return { kind: 'found', order };
  // Diagnostic probe only: a parent hit is reported, never expanded to its children.
  const parent = await db
    .withSchema('app')
    .selectFrom('orders')
    .select('sub_order_id')
    .where('app_id', '=', input.app_id)
    .where('platform', '=', input.platform)
    .where('parent_order_id', '=', no)
    .limit(1)
    .executeTakeFirst();
  return parent === undefined ? { kind: 'not_found' } : { kind: 'sub_order_no_missing' };
}
