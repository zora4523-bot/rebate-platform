import type { RegisteredPlatform, UnionOrder } from '../../union/index.ts';
import type { ExactLink, LinkLogCandidate, OrderSourceMatch } from '../domain/source-backfill.ts';

export interface OrderSourcePorts {
  linkLogs(input: {
    appId: string;
    userId: string;
    platform: RegisteredPlatform;
    from: Date;
    to: Date;
  }): Promise<readonly LinkLogCandidate[]>;
  // TODO(规划/11 §4.5): links.lk 按短码反查 — blocked on links.lk 迁移与 lk 发号
  linkByCode?(input: {
    appId: string;
    platform: RegisteredPlatform;
    lk: string;
  }): Promise<ExactLink | null>;
  productKey(input: { platform: RegisteredPlatform; order: UnionOrder }): Promise<string | null>;
  clickCode?(platform: RegisteredPlatform): boolean;
  windowHours?(): number;
}

export interface BackfillOrderSourceInput {
  readonly appId: string;
  readonly platform: RegisteredPlatform;
  readonly userId: string;
  readonly attrAt: Date;
  readonly pidScene: string;
  readonly order: UnionOrder;
  // TODO(规划/11 §4.5): 首次入库的 shopId 映射 — blocked on 联盟订单映射 shop_id
  readonly shopId: string | null;
}

export function backfillOrderSource(
  ports: OrderSourcePorts,
  input: BackfillOrderSourceInput,
): Promise<OrderSourceMatch> {
  void ports;
  void input;
  throw new Error('NotImplemented: backfillOrderSource');
}
