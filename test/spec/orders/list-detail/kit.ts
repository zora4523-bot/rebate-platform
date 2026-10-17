import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { ContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import * as orders from '../../../../apps/api/src/modules/orders/index.ts';

export const NOW = '2028-01-15T04:00:00.000Z';
export const at = (value: string) => new FixedClock(value).now();
export const unknownFigures: orders.OrderFigures = {
  b_est: null,
  est_rebate_fen: null,
  actual_fen: null,
  clawback_fen: null,
  has_clawback: false,
  part_clawed_at: null,
  viewer_share_held: false,
  expected_credit_period: null,
  credit_overdue: false,
  appeal_pending: false,
};

export async function capture<T>(action: () => T | Promise<T>) {
  try {
    return { ok: true as const, value: await action() };
  } catch (error) {
    return { ok: false as const, error };
  }
}

/** Turn a missing public export or factory failure into an assertion before calling methods. */
export async function queries(deps: orders.OrderQueryDeps) {
  const result = await capture(() => orders.createOrderQueries(deps));
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value;
}

let sequence = 0;
export async function fixture(db: Kysely<DB>) {
  const subject = {
    app_id: `orders_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    user_id: randomUUID(),
  };
  const clock = new FixedClock(NOW);
  const values = new Map<string, orders.OrderFigures>();
  const products = new Map<string, string | null>();
  const settings = new Map<string, number | boolean>([
    ['order.user_query_months', 0],
    ['credit.enabled.jd', true],
    ['credit.enabled.taobao', true],
    ['credit.enabled.pdd', true],
  ]);
  const config: ContentReader = {
    appVersion: async () => null,
    minSupportedVersion: async () => null,
    configValue: vi.fn(async (_appId, key) => {
      return settings.has(key) ? { value: settings.get(key)!, version: 1 } : null;
    }),
  };
  const figures = {
    forOrders: vi.fn(
      async (_subject: orders.OrderSubject, ids: readonly string[]) =>
        new Map(ids.map((id) => [id, values.get(id) ?? { ...unknownFigures, b_est: 99n }])),
    ),
  };
  const links = {
    productKeys: vi.fn(
      async (_appId: string, ids: readonly string[]) =>
        new Map(ids.map((id) => [id, products.get(id) ?? null])),
    ),
  };
  async function user(appId = subject.app_id, userId = randomUUID()) {
    await db
      .insertInto('users')
      .values({
        id: userId,
        app_id: appId,
        nickname: 'synthetic buyer',
        avatar: '',
        invite_code: randomUUID().slice(0, 8),
        attr_code: randomUUID().slice(0, 8),
        level: 'member',
        register_method: 'synthetic',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    return userId;
  }
  await user(subject.app_id, subject.user_id);
  async function link(productKey: string | null) {
    const linkId = randomUUID();
    await db
      .insertInto('links')
      .values({
        app_id: subject.app_id,
        link_id: linkId,
        user_id: subject.user_id,
        platform: 'jd',
        scene: 'share',
        product_key: productKey,
        expire_at: at('2028-02-01T00:00:00.000Z'),
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    products.set(linkId, productKey);
    return linkId;
  }
  async function seed(
    patch: Partial<Insertable<DB['orders']>> = {},
    figurePatch: Partial<orders.OrderFigures> = {},
  ) {
    const offset = ++sequence * 1000;
    const time = (iso: string) => {
      const source = new FixedClock(iso);
      source.advanceMs(offset);
      return source.now();
    };
    const row = {
      order_id: randomUUID(),
      app_id: subject.app_id,
      user_id: subject.user_id,
      platform: 'jd',
      sub_order_id: `c${randomUUID().replaceAll('-', '')}`,
      parent_order_id: `p${randomUUID().replaceAll('-', '')}`,
      raw_item_id: 'synthetic-item',
      title: 'Visible Headphones',
      image_url: 'https://img.example.test/a.png',
      quantity: null,
      pay_amount_fen: 12345n,
      product_key: 'jd:i_12345',
      buy_type: 'self',
      rebate_status: 'ESTIMATED',
      platform_status: 'PAID',
      hold: false,
      rights_pending: false,
      is_presale: false,
      is_price_compare: null,
      reason: null,
      paid_at: time('2027-12-12T03:00:00.000Z'),
      deposit_paid_at: null,
      attr_at: time('2027-11-01T01:00:00.000Z'),
      created_at: time('2027-12-13T05:00:00.000Z'),
      updated_at: time('2027-12-14T06:00:00.000Z'),
      ...patch,
    } satisfies Insertable<DB['orders']>;
    await db
      .insertInto('order_keys')
      .values({
        order_id: row.order_id,
        app_id: row.app_id,
        platform: row.platform,
        sub_order_id: row.sub_order_id,
        attr_at: row.attr_at,
        created_at: row.created_at,
      })
      .execute();
    await db.insertInto('orders').values(row).execute();
    values.set(row.order_id, { ...unknownFigures, b_est: 99n, ...figurePatch });
    return row;
  }
  const deps: orders.OrderQueryDeps = { db, clock, config, figures, links };
  return {
    db,
    subject,
    clock,
    values,
    products,
    settings,
    config,
    figures,
    links,
    deps,
    seed,
    user,
    link,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const ids = (page: { items: { order_id: string }[] }) =>
  page.items.map((row) => row.order_id);
