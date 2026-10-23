// B1-09b：归因流水线第 ③ 步黑名单的端口形状（BR-ATTR-26；BR-ATTR-01 ③）。只在流水线运行时（首次入库，或
// content_hash 变化）检查；不做全表回扫。与本次写库同一事务。
// - 名单查询与命中写入经 risk 导出的订单侧名单端口（B1-09a）；这里按结构声明，risk 的实现直接满足。
// - 命中且未入账 → rebate.onBlacklistHit（settlement apply BLACKLIST_HIT，R6）；未注入时只记 manual_review 并告警，
//   不改订单列。已入账 → 入队 order.blacklist_hit_after_credit。VOID / CLAWED_BACK 不处理。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { BlacklistDimension, BlacklistRiskAction } from '../domain/blacklist.ts';

export interface OrderBlacklistQuery {
  readonly app_id: string;
  readonly platform: string;
  /** 订单父订单号（淘宝 trade_parent_id，即 orders.parent_order_id）。 */
  readonly trade_parent_id: string | null;
  readonly relation_id: string | null;
  /** 订单推广位所属的联盟账号。 */
  readonly union_account_id: string | null;
  readonly attr_at: Date;
}

export interface OrderBlacklistMatch {
  readonly blocklist_id: string;
  readonly dimension: BlacklistDimension;
  readonly value: string;
}

export interface OrderBlacklistHitRecord {
  readonly app_id: string;
  readonly user_id: string | null;
  readonly order_id: string;
  readonly dimension: BlacklistDimension;
  readonly value: string;
  readonly risk_action: BlacklistRiskAction;
}

/** risk 订单侧名单端口（B1-09a）中本步用到的两项；都在调用方事务内执行。 */
export interface OrderBlacklistPorts {
  match(trx: Transaction<DB>, input: OrderBlacklistQuery): Promise<readonly OrderBlacklistMatch[]>;
  recordHit(trx: Transaction<DB>, input: OrderBlacklistHitRecord): Promise<void>;
}

export interface OrderBlacklistDeps {
  readonly blocklist: OrderBlacklistPorts;
  /** attr.blacklist.order_suffix_void_enabled（默认 false）。 */
  readonly suffixVoidEnabled: (appId: string) => Promise<boolean>;
}

/** 交给返利端口的命中（settlement 按 BLACKLIST_HIT 走 R6，reason_code=BLACKLIST）。 */
export interface OrderBlacklistHit {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
}

export interface OrderBlacklistRebatePort {
  onBlacklistHit(trx: Transaction<DB>, hit: OrderBlacklistHit): Promise<void>;
}
