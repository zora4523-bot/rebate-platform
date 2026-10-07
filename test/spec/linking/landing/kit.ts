import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { LandingLink } from '../../../../apps/api/src/modules/linking/application/link-landing.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const APP = 'synthetic_landing';
export const OTHER_APP = 'synthetic_landing_other';
export const NOW = '2026-10-08T04:00:00.000Z';
export const QUOTED = '2026-10-07T03:02:01.000Z';
export const OWNER = '0199a3b4-5c6d-7000-8000-000000000001';
export const OTHER = '0199a3b4-5c6d-7000-8000-000000000002';
export const DEVICE = '0199a3b4-5c6d-7000-8000-000000000003';
export const LINK = '0199a3b4-5c6d-7000-8000-000000000004';
export const MISSING = '0199a3b4-5c6d-7000-8000-000000000005';
export const TRACE = '0199a3b4-5c6d-7000-8000-000000000006';
export const ROOT = new URL('../../../../', import.meta.url);
export const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

export function snapshot(overrides: Partial<LandingLink> = {}): LandingLink {
  return {
    link_id: LINK,
    app_id: APP,
    user_id: OWNER,
    device_id: DEVICE,
    platform: 'jd',
    product_key: 'jd:synthetic-landing',
    raw_item_id: 'synthetic-item',
    raw_fetched_at: new Date(QUOTED),
    scene: 'share',
    sub_scene: null,
    pid_scene: 'share',
    pid: 'synthetic-share',
    entry_source: 'search',
    identity_snapshot: {
      user_id: OWNER,
      platform: 'jd',
      pid: 'synthetic-share',
      pid_scene: 'share',
      attr_code: 'demo0001',
      agent_session_id: null,
    },
    convert_result: null,
    cache_hit: false,
    quoted_final_price_fen: 10000n,
    quoted_coupon_fen: 2000n,
    quoted_coupon_id: null,
    quoted_at: new Date(QUOTED),
    expire_at: new Date('2026-10-07T04:00:00.000Z'),
    agent_session_id: null,
    agent_card_id: null,
    row_version: 0,
    created_at: new Date(QUOTED),
    updated_at: new Date(QUOTED),
    promo_url: null,
    promo_url_fetched_at: null,
    ...overrides,
  };
}

export function fullCard(link: LandingLink): components['schemas']['ProductCard'] {
  return {
    product_key: link.product_key,
    item_ref: 'synthetic-item-reference',
    platform: 'jd',
    title: '合成落地页商品',
    image: 'https://example.test/product.png',
    shop_type: null,
    shop_name: '合成店铺',
    price_fen: 12000,
    coupon_fen: 2000,
    final_price_fen: 10000,
    rebate_min_fen: 123,
    rebate_max_fen: 456,
    rebate_basis: 'normal',
    no_rebate_cause: null,
    est_net_price_fen: 9877,
    benefit_tags: ['有券'],
    is_presale: false,
    link_id: link.link_id,
    cta: { text_key: 'btn.buy.coupon' },
    // Deliberately distinct: the landing quote must come from links, not a refreshed card.
    quoted_at: NOW,
    stale: true,
    age_sec: 89879,
    source: 'jd_union',
    disclaimer_keys: ['price_basis'],
    availability: 'ok',
    card_id: 'c1',
    match_tag: 'matched',
    spec_text: '合成规格',
  };
}

let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(
  value: unknown,
  name: 'LinkLandingResponse' | 'ErrorEnvelope',
): Promise<void> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((contract) => contract.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

export function landingData(value: unknown): components['schemas']['LinkLandingData'] {
  expect(value).toMatchObject({ code: 0, data: { product_card: expect.any(Object) } });
  return (value as components['schemas']['LinkLandingResponse']).data;
}

export function expectPrivateFieldsAbsent(card: object): void {
  expect(Object.keys(card).filter((key) => key.startsWith('rebate_'))).toEqual([]);
  for (const key of [
    'est_net_price_fen',
    'no_rebate_cause',
    'cta',
    'card_id',
    'match_tag',
    'spec_text',
    'quoted_at',
    'identity_snapshot',
    'user_id',
    'pid',
    'jump',
  ]) {
    expect(card).not.toHaveProperty(key);
  }
}

/** Whole tables, including row values: catches updates as well as inserts/deletes. */
export async function persisted(db: Kysely<DB>) {
  return {
    links: await db.selectFrom('links').selectAll().orderBy('link_id').execute(),
    logs: await db.selectFrom('link_logs').selectAll().orderBy('id').execute(),
    attempts: await db.selectFrom('link_open_attempts').selectAll().orderBy('attempt_id').execute(),
  };
}
