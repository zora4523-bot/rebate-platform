import { vi } from 'vitest';
import type { LinkOpenOwnerResult } from '../../../../apps/api/src/modules/linking/index.ts';
import type {
  JdPddConversionInput,
  LinkConversionOptions,
} from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  type ActivePidInput,
  type UnionPidRow,
} from '../../../../apps/api/src/modules/union/index.ts';
import { caller, pid, START, USER_A, USER_B } from '../register/kit.ts';

export { START, USER_A, USER_B };
export const EXPIRES = '2031-05-06T07:23:09.000Z';
export const LINK = '0199a3b4-5c6d-7000-8000-000000000088';

export function owner(platform: 'jd' | 'pdd' | 'taobao' = 'jd'): LinkOpenOwnerResult {
  const snapshot = {
    user_id: USER_A,
    platform,
    pid: 'synthetic-self_buy',
    pid_scene: 'self_buy',
    attr_code: 'demo0001',
    agent_session_id: null,
  };
  return {
    identitySnapshot: snapshot,
    link: {
      link_id: LINK,
      app_id: 'register-app',
      user_id: USER_A,
      platform,
      product_key: platform === 'jd' ? 'jd:12345' : platform === 'pdd' ? 'pdd:67890' : 'tb:12345',
      raw_item_id: platform === 'pdd' ? 'synthetic-sign' : '12345',
      raw_fetched_at: new Date(START),
      scene: 'detail',
      sub_scene: null,
      entry_source: 'clipboard',
      pid: snapshot.pid,
      pid_scene: snapshot.pid_scene,
      identity_snapshot: snapshot,
      quoted_final_price_fen: 2990n,
      quoted_coupon_fen: 0n,
      quoted_coupon_id: '',
      quoted_at: new Date(START),
      device_id: null,
      agent_session_id: null,
      agent_card_id: null,
      cache_hit: false,
      convert_result: null,
      promo_url: 'https://example.test/other-promoter?pid=untrusted',
      promo_url_fetched_at: new Date(START),
      expire_at: new Date(EXPIRES),
      created_at: new Date(START),
      updated_at: new Date(START),
      row_version: 0,
    },
    new_link_id: null,
    old_final_price_fen: '2990',
    message: null,
  };
}

export function conversionInput(platform: 'jd' | 'pdd' | 'taobao' = 'jd'): JdPddConversionInput {
  return {
    owner: owner(platform),
    noRebate: false,
    installed: 'true',
    client: 'ios',
    idempotencyKey: 'synthetic-open-1',
    traceId: 'synthetic-trace',
  };
}

export function conversionFixture(platform: 'jd' | 'pdd' = 'jd') {
  const clock = new FixedClock(START);
  const adapter = new DemoUnionAdapter({
    platform,
    seed: 'open-jdpdd',
    clock,
    environment: 'test',
  });
  const convert = vi.spyOn(adapter, 'convert');
  const current = vi.fn(async () => caller());
  const attrCode = vi.fn(async (_app: string, userId: string): Promise<string | null> =>
    userId === USER_A ? 'demo0001' : 'demo0002',
  );
  const settings = new Map<string, boolean | number | string>([
    [`convert.enabled.${platform}`, true],
    ['attr.click_code.jd', false],
    ['attr.click_code.pdd', false],
    ['attr.jd.user_key_mode', 'sub_union_id'],
  ]);
  const configValue = vi.fn(async (_app: string, name: string) => {
    const value = settings.get(name);
    return value === undefined ? null : { value, version: 1 };
  });
  const getActivePid = vi.fn(async (query: ActivePidInput): Promise<UnionPidRow | null> =>
    pid(query),
  );
  const warn = vi.fn();
  const get = vi.fn(() => adapter);
  const options: LinkConversionOptions = {
    clock,
    callerContext: { current },
    attrCodes: { attrCode },
    config: { configValue },
    pids: { getActivePid },
    registry: { get },
    logger: { warn },
  };
  return { options, clock, adapter, convert, current, attrCode, settings, getActivePid, warn, get };
}

/** Pull a real synthetic catalog item so the demo adapter can reject invalid wiring. */
export async function demoInput(
  f: ReturnType<typeof conversionFixture>,
): Promise<JdPddConversionInput> {
  const page = await f.adapter.searchItems(
    { keyword: '演示商品' },
    { appId: 'register-app', requestId: 'synthetic-trace', purpose: 'online' },
  );
  const item = page.items[0]!;
  const raw = item.platform === 'jd' ? (item.itemId ?? item.skuId) : item.goods_sign;
  if (raw === undefined || raw === null)
    throw new Error('synthetic demo catalog lacks item identity');
  const input = conversionInput(f.adapter.platform as 'jd' | 'pdd');
  const stable = item.platform === 'jd' ? `i_${raw.split('_')[1]}` : item.goods_id;
  return {
    ...input,
    owner: {
      ...input.owner,
      link: { ...input.owner.link, product_key: `${item.platform}:${stable}`, raw_item_id: raw },
    },
  };
}

/** Preserve rejections as assertion data when exercising an existing implementation. */
export async function settled<T>(work: () => Promise<T>): Promise<T | { rejected: unknown }> {
  try {
    return await work();
  } catch (rejected) {
    return { rejected };
  }
}
