import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { partitionsOf, sqlState } from '../../partitions/kit.ts';
import { TIMEOUT, columns, fixture, insert, ready } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
}, TIMEOUT);

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
}, TIMEOUT);

it(
  '[AC-B1-17a#9] migrations create only a DEFAULT partition',
  async () => {
    await ready(app);
    expect((await partitionsOf(app, 'price_snapshot')).map(({ bound }) => bound)).toEqual([
      'DEFAULT',
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#1] history columns carry integer prices and run metadata without SQL observation clocks',
  async () => {
    await ready(app);
    const list = await columns(app);
    expect(list.map(({ name, type, nullable }) => ({ name, type, nullable }))).toEqual(
      expect.arrayContaining([
        { name: 'id', type: 'int8', nullable: false },
        { name: 'app_id', type: 'text', nullable: false },
        { name: 'platform', type: 'text', nullable: false },
        { name: 'product_key', type: 'text', nullable: false },
        { name: 'sku_key', type: 'text', nullable: true },
        { name: 'source_kind', type: 'text', nullable: false },
        { name: 'price_fen', type: 'int8', nullable: false },
        { name: 'coupon_fen', type: 'int8', nullable: false },
        { name: 'final_price_fen', type: 'int8', nullable: false },
        { name: 'in_stock', type: 'bool', nullable: false },
        { name: 'goods_sign_plan', type: 'text', nullable: true },
        { name: 'first_observed_at', type: 'timestamptz', nullable: false },
        { name: 'last_observed_at', type: 'timestamptz', nullable: false },
        { name: 'observation_count', type: 'int4', nullable: false },
        { name: 'created_at', type: 'timestamptz', nullable: false },
      ]),
    );
    expect(['a', 'd']).toContain(list.find(({ name }) => name === 'id')?.identity);
    expect(list.find(({ name }) => name === 'first_observed_at')?.default_expr).toBeNull();
    expect(list.find(({ name }) => name === 'last_observed_at')?.default_expr).toBeNull();
    expect(list.find(({ name }) => name === 'created_at')?.default_expr).toMatch(
      /^(?:now\(\)|CURRENT_TIMESTAMP|transaction_timestamp\(\))$/i,
    );
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#2] history has no user, device, attribution or personalized channel columns',
  async () => {
    await ready(app);
    const names = (await columns(app)).map(({ name }) => name.toLowerCase());
    for (const forbidden of [
      'user_id',
      'device_id',
      'relation_id',
      'sub_union_id',
      'subunionid',
      'custom_parameters',
      'pid',
      'promotion_slot',
      'promotion_slot_id',
      'cpin',
      'xid_buyer',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    expect(names.filter((name) => /user|device|relation|union_id/i.test(name))).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#3] every required column rejects explicit NULL, including identity and created_at',
  async () => {
    await ready(app);
    expect(await sqlState(insert(app, fixture()))).toBe('ok');
    for (const column of [
      'id',
      'app_id',
      'platform',
      'product_key',
      'source_kind',
      'price_fen',
      'coupon_fen',
      'final_price_fen',
      'in_stock',
      'first_observed_at',
      'last_observed_at',
      'observation_count',
      'created_at',
    ]) {
      expect(await sqlState(insert(app, fixture({ [column]: null }))), column).toBe('23502');
    }
    for (const omitted of ['first_observed_at', 'last_observed_at']) {
      const row = fixture();
      delete row[omitted];
      expect(await sqlState(insert(app, row)), omitted).toBe('23502');
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#4] source_kind accepts all five sources and rejects unknown or failure kinds',
  async () => {
    await ready(app);
    for (const source of ['search', 'detail', 'quote', 'convert', 'watch']) {
      expect(await sqlState(insert(app, fixture({ source_kind: source }))), source).toBe('ok');
    }
    for (const source of ['', 'unknown', 'timeout', 'error', 'invalid', 'DETAIL', 'watch_fetch']) {
      expect(await sqlState(insert(app, fixture({ source_kind: source }))), source).toBe('23514');
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#5] price shape rejects nonpositive prices and negative coupons without imposing a price equation',
  async () => {
    await ready(app);
    for (const bad of [
      { price_fen: 0n },
      { price_fen: -1n },
      { coupon_fen: -1n },
      { final_price_fen: 0n },
      { final_price_fen: -1n },
    ]) {
      expect(await sqlState(insert(app, fixture(bad))), String(Object.keys(bad))).toBe('23514');
    }
    expect(
      await sqlState(insert(app, fixture({ price_fen: 1n, coupon_fen: 0n, final_price_fen: 1n }))),
    ).toBe('ok');
    // A member-price adjustment may make final price differ from price minus coupon.
    expect(await sqlState(insert(app, fixture({ final_price_fen: 4200n })))).toBe('ok');
    expect(
      await sqlState(
        insert(
          app,
          fixture({
            product_key: 'tb:large-integers',
            price_fen: 9007199254740993n,
            coupon_fen: 0n,
            final_price_fen: 9007199254740993n,
          }),
        ),
      ),
    ).toBe('ok');
    const stored = await sql<{ price_fen: bigint; coupon_fen: bigint; final_price_fen: bigint }>`
    SELECT price_fen, coupon_fen, final_price_fen FROM app.price_snapshot
    WHERE product_key = 'tb:large-integers'
  `.execute(app);
    expect(stored.rows).toEqual([
      { price_fen: 9007199254740993n, coupon_fen: 0n, final_price_fen: 9007199254740993n },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#6] runs require positive counts and last_observed_at at or after first_observed_at',
  async () => {
    await ready(app);
    for (const bad of [
      { observation_count: 0 },
      { observation_count: -1 },
      { last_observed_at: new Date('2032-06-15T07:59:59.999Z') },
    ]) {
      expect(await sqlState(insert(app, fixture(bad)))).toBe('23514');
    }
    expect(await sqlState(insert(app, fixture({ observation_count: 1 })))).toBe('ok');
    expect(
      await sqlState(
        insert(
          app,
          fixture({
            observation_count: 2,
            last_observed_at: new Date('2032-07-01T00:00:00Z'),
          }),
        ),
      ),
    ).toBe('ok');
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#7] optional SKU and goods_sign_plan round-trip, including out-of-stock history',
  async () => {
    await ready(app);
    expect(
      await sqlState(
        insert(
          app,
          fixture({
            platform: 'pdd',
            product_key: 'pdd:synthetic-plan',
            sku_key: 'sku:synthetic',
            goods_sign_plan: 'general',
            in_stock: false,
          }),
        ),
      ),
    ).toBe('ok');
    const result = await sql<{ sku_key: string; goods_sign_plan: string; in_stock: boolean }>`
    SELECT sku_key, goods_sign_plan, in_stock FROM app.price_snapshot
    WHERE product_key = 'pdd:synthetic-plan'
  `.execute(app);
    expect(result.rows).toEqual([
      { sku_key: 'sku:synthetic', goods_sign_plan: 'general', in_stock: false },
    ]);
  },
  TIMEOUT,
);
