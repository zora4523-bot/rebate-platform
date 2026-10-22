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
 * 平台单号的比较用规范形态：拼多多去掉全部连字符（存储侧也按同样规则规范化后再比较），
 * 其他平台原样（保留连字符与前导零）。不假设连字符的位置，也不转 number。
 */
export function normalizeOrderNo(platform: RegisteredPlatform, platformOrderNo: string): string {
  return platform === 'pdd' ? platformOrderNo.replaceAll('-', '') : platformOrderNo;
}

type OrderNoColumn = 'sub_order_id' | 'parent_order_id';

/**
 * Read-only sub_order_id lookup within app + platform. PDD adapters store order_sn verbatim
 * (with hyphens), so for PDD both the stored column and the input are hyphen-stripped before
 * comparing: replace(col, '-', '') = <normalized input>. An exact `col = <normalized input>`
 * branch is kept next to it in one UNION ALL statement (redundant for matching; it keeps a bound
 * equality on the column). Taobao / JD compare the stored value verbatim.
 * A parent-only hit is diagnostic, never a list of children or a command target.
 * This result is NOT a locked snapshot: caller must lockOrderKey and reread FOR UPDATE
 * before sending a command through the settlement ports.
 */
export async function findOrderForRights(
  db: Kysely<DB>,
  input: RightsOrderLookupInput,
): Promise<RightsOrderLookupResult> {
  const no = normalizeOrderNo(input.platform, input.platform_order_no);
  const pdd = input.platform === 'pdd';
  const scoped = () =>
    db
      .withSchema('app')
      .selectFrom('orders')
      .where('app_id', '=', input.app_id)
      .where('platform', '=', input.platform);
  const exact = (column: OrderNoColumn) => scoped().where(column, '=', no);
  const stripped = (column: OrderNoColumn) =>
    scoped().where((eb) =>
      eb(eb.fn<string>('replace', [eb.ref(column), eb.val('-'), eb.val('')]), '=', no),
    );

  const subQuery = pdd
    ? exact('sub_order_id').selectAll().unionAll(stripped('sub_order_id').selectAll())
    : exact('sub_order_id').selectAll();
  const order = await subQuery.executeTakeFirst();
  if (order !== undefined) return { kind: 'found', order };

  // Diagnostic probe only: a parent hit is reported, never expanded to its children.
  const parentQuery = pdd
    ? exact('parent_order_id')
        .select('sub_order_id')
        .unionAll(stripped('parent_order_id').select('sub_order_id'))
    : exact('parent_order_id').select('sub_order_id');
  const parent = await parentQuery.limit(1).executeTakeFirst();
  return parent === undefined ? { kind: 'not_found' } : { kind: 'sub_order_no_missing' };
}
