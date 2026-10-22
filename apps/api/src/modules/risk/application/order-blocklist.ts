import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/clock/index.ts';
import type { FieldCrypto } from '../../platform/crypto/index.ts';

export type OrderBlocklistDimension = 'order_no_suffix' | 'channel';

export interface OrderBlocklistQuery {
  readonly app_id: string;
  readonly platform: string;
  readonly trade_parent_id: string | null;
  readonly relation_id: string | null;
  readonly union_account_id: string | null;
  readonly attr_at: Date;
}

export interface OrderBlocklistMatch {
  readonly blocklist_id: string;
  readonly dimension: OrderBlocklistDimension;
  readonly value: string;
}

export interface OrderBlocklistHitInput {
  readonly app_id: string;
  readonly user_id: string | null;
  readonly order_id: string;
  readonly dimension: OrderBlocklistDimension;
  readonly value: string;
  /** 调用方依据订单状态和尾号开关决定；本端口不变更订单。 */
  readonly risk_action: 'manual_review' | 'void_commission';
}

export interface ChannelBlocklistImport {
  readonly app_id: string;
  readonly platform: string;
  readonly union_account_id: string;
  readonly created_by: string;
  /** rights_imports.created_at；即使稍后重试，也沿用该时刻。 */
  readonly imported_at: Date;
  readonly rows: readonly {
    readonly relation_id: string;
    readonly end_at: Date | null;
  }[];
}

export interface ChannelBlocklistImportResult {
  readonly status: 'inserted' | 'duplicate';
  readonly blocklist_id: string;
}

export interface OrderBlocklistPorts {
  /** 只读；返回两种维度全部命中，订单决策由调用方负责。 */
  match(trx: Transaction<DB>, input: OrderBlocklistQuery): Promise<readonly OrderBlocklistMatch[]>;
  /** BLACKLIST_HIT 惰性登记；同一订单、同一值的重试由 PG 部分唯一索引兜底。 */
  recordHit(trx: Transaction<DB>, input: OrderBlocklistHitInput): Promise<void>;
  /** 按输入行序返回结果；只新增，既有条目不修改；整份文件审计由 orders 写。 */
  importChannels(
    trx: Transaction<DB>,
    input: ChannelBlocklistImport,
  ): Promise<readonly ChannelBlocklistImportResult[]>;
}

export interface OrderBlocklistOptions {
  readonly clock: Clock;
  /** HMAC 上下文为 blocklist.order_no_suffix / blocklist.channel，沿用名单命名惯例。 */
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
}

export function createOrderBlocklistPorts(options: OrderBlocklistOptions): OrderBlocklistPorts {
  void options;
  throw new Error('NotImplemented: createOrderBlocklistPorts');
}
