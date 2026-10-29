// B2-04zc（BR-TEXT-19）：余额流水的订单跳转——把凭证上的 order_key（{platform}:{sub_order_id}，
// BR-FUND-05）换成子订单号 orders.order_id（GET /v1/orders/{order_id} 用的那个），供 ledger 的余额流水
// 经 app.module 接线调用；ledger 不读订单的表。只换调用方给出的键（ledger 只为本人自购与分享角色的
// 分录来问，邀请分佣的分录不来问）；查不到的键不在结果里。
// 只读调用方句柄上的 SELECT（order_keys 按主键 (platform, sub_order_id) 查）：不加锁、不写库。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface OrderIdsByKeyInput {
  readonly appId: string;
  readonly orderKeys: readonly string[];
}

interface Locator {
  readonly key: string;
  readonly platform: string;
  readonly subOrderId: string;
}

/** order_key 恰好两段、都不为空；别的形状不是订单键，不查。 */
function locatorOf(key: string): Locator | null {
  const parts = key.split(':');
  if (parts.length !== 2) return null;
  const [platform, subOrderId] = parts as [string, string];
  if (platform === '' || subOrderId === '') return null;
  return { key, platform, subOrderId };
}

export async function readOrderIdsByKey(
  handle: Kysely<DB>,
  input: OrderIdsByKeyInput,
): Promise<Map<string, string>> {
  const locators = [...new Set(input.orderKeys)]
    .map((key) => locatorOf(key))
    .filter((locator): locator is Locator => locator !== null);
  const found = new Map<string, string>();
  if (locators.length === 0) return found;
  const rows = await handle
    .withSchema('app')
    .selectFrom('order_keys')
    .select(['platform', 'sub_order_id', 'order_id'])
    .where('app_id', '=', input.appId)
    .where('platform', 'in', [...new Set(locators.map((locator) => locator.platform))])
    .where(
      'sub_order_id',
      'in',
      locators.map((locator) => locator.subOrderId),
    )
    .execute();
  // 两个 IN 是超集：只留调用方问到的 (platform, sub_order_id) 组合。
  const wanted = new Set(locators.map((locator) => locator.key));
  for (const row of rows) {
    const key = `${row.platform}:${row.sub_order_id}`;
    if (wanted.has(key)) found.set(key, row.order_id);
  }
  return found;
}
