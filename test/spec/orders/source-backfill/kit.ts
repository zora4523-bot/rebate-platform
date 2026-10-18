import { vi } from 'vitest';
import type {
  BackfillOrderSourceInput,
  LinkLogCandidate,
  MatchOrderSourceInput,
  OrderSourcePorts,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { order } from '../attribution/kit.ts';

export { capture } from '../attribution/kit.ts';
export const ATTR = '2026-10-20T12:00:00+08:00';
export const at = (value: string) => new FixedClock(value).now();
export const NONE = {
  source_match: 'none',
  link_id: null,
  source_scene: null,
  agent_session_id: null,
};

export function log(patch: Partial<LinkLogCandidate> = {}): LinkLogCandidate {
  return {
    id: 1n,
    link_id: '00000000-0000-4000-8000-000000000001',
    user_id: 'user-U',
    platform: 'pdd',
    product_key: 'pdd:123',
    shop_id: 'shop-1',
    event: 'open',
    result_code: 0,
    pid_scene: 'agent',
    scene: 'agent',
    agent_session_id: '00000000-0000-4000-8000-000000000007',
    created_at: at('2026-10-18T09:12:34+08:00'),
    ...patch,
  };
}

export function input(patch: Partial<MatchOrderSourceInput> = {}): MatchOrderSourceInput {
  return {
    userId: 'user-U',
    platform: 'pdd',
    productKey: 'pdd:123',
    shopId: 'shop-1',
    pidScene: 'agent',
    attrAt: at(ATTR),
    windowHours: 360,
    exactLink: null,
    candidates: [log()],
    ...patch,
  };
}

export function matched(row: LinkLogCandidate, source_match: 'product' | 'shop' = 'product') {
  return {
    source_match,
    link_id: row.link_id,
    source_scene: row.scene,
    agent_session_id: row.agent_session_id,
  };
}

export function sourcePorts(rows: readonly LinkLogCandidate[] = [log()]) {
  const linkLogs = vi.fn<OrderSourcePorts['linkLogs']>().mockResolvedValue(rows);
  const productKey = vi.fn<OrderSourcePorts['productKey']>().mockResolvedValue('pdd:123');
  const linkByCode = vi.fn<NonNullable<OrderSourcePorts['linkByCode']>>().mockResolvedValue(null);
  const ports: OrderSourcePorts = { linkLogs, productKey, linkByCode };
  return { ports, linkLogs, productKey, linkByCode };
}

export function applicationInput(
  patch: Partial<BackfillOrderSourceInput> = {},
): BackfillOrderSourceInput {
  return {
    appId: 'app-one',
    platform: 'pdd',
    userId: 'user-U',
    attrAt: at(ATTR),
    pidScene: 'agent',
    shopId: 'shop-1',
    order: order({
      attr_params: {
        relation_id: null,
        sub_union_id: null,
        custom_parameters: '{"app":"n","uid":"abcd1234","lk":"a1b2c3"}',
      },
    }),
    ...patch,
  };
}
