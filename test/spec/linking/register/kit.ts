// Public-entry acceptance tests. Database writes below are synthetic fixture setup only.
// Every test constructs the skeleton inside its body, outside rejection assertions.
// Reuse is optional: require different IDs only when reuse would violate the BRs.
// Snapshot convention: attr_code is stored as the opaque identity input; construction of
// platform-specific conversion parameters and authorization belongs to later open tasks.
// lk/click-code generation (BR-ATTR-15) is outside this task; the current schema has no lk.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { RegisterLinkInput } from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  createLinkRegistration,
  type Caller,
  type LinkingOptions,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { ActivePidInput, UnionPidRow } from '../../../../apps/api/src/modules/union/index.ts';

export const START = '2031-05-06T07:08:09.000Z';
export const QUOTED = '2031-05-06T07:07:09.000Z';
export const RAW_AT = '2031-05-06T07:06:09.000Z';
export const USER_A = '0199a3b4-5c6d-7000-8000-000000000001';
export const USER_B = '0199a3b4-5c6d-7000-8000-000000000002';
export const DEVICE_A = '0199a3b4-5c6d-7000-8000-000000000003';
export const DEVICE_B = '0199a3b4-5c6d-7000-8000-000000000004';
export const SESSION = '0199a3b4-5c6d-7000-8000-000000000005';

export function caller(overrides: Partial<Caller> = {}): Caller {
  return { appId: 'register-app', userId: USER_A, deviceId: DEVICE_A, ...overrides };
}

export function input(overrides: Partial<RegisterLinkInput> = {}): RegisterLinkInput {
  return {
    viewer: caller(),
    ref: {
      appId: 'register-app',
      platform: 'taobao',
      productKey: `tb:synthetic:${expect.getState().currentTestName}`,
      rawItemId: ' 000-Synthetic/原串+= ',
      rawFetchedAt: RAW_AT,
      receivedAt: QUOTED,
      canonicalUrl: null,
      title: '合成商品',
      shopId: null,
      shopType: null,
      source: 'search',
    },
    item: {
      platform: 'taobao',
      item_id: 'adapter-id-is-not-catalog-raw',
      title: '合成商品',
      price_fen: 12000n,
      coupon_fen: 2000n,
      final_price_fen: 10000n,
      commission_rate_bp: 1000n,
      quoted_at: QUOTED,
      coupon_ids: 'coupon-a,coupon-z',
    },
    quote: { rebateMinFen: 100n, rebateMaxFen: 100n, estNetPriceFen: 9900n, rebateBasis: 'normal' },
    entrySource: 'search',
    ...overrides,
  };
}

export function pid(query: ActivePidInput): UnionPidRow {
  return {
    id: '0199a3b4-5c6d-7000-8000-000000000006',
    app_id: query.appId,
    platform: query.platform,
    pid_scene: query.pidScene,
    pid: `synthetic-${query.pidScene}`,
    union_account_id: '0199a3b4-5c6d-7000-8000-000000000007',
    site_id: null,
    status: 'active',
    row_version: 0,
    hjy_ignore_confirmed_at: null,
    hjy_ignore_evidence_path: null,
    created_at: new Date(RAW_AT),
    updated_at: new Date(RAW_AT),
  };
}

export function fixture(db: Kysely<DB>, overrides: Partial<LinkingOptions> = {}) {
  const clock = new FixedClock(START);
  const current = vi.fn(async () => caller());
  const attrCode = vi.fn(async (appId: string, userId: string): Promise<string | null> => {
    void appId;
    void userId;
    return 'demo0001';
  });
  const configValue = vi.fn(async () => null);
  const getActivePid = vi.fn(async (query: ActivePidInput): Promise<UnionPidRow | null> =>
    pid(query),
  );
  const options: LinkingOptions = {
    db,
    clock,
    callerContext: { current },
    attrCodes: { attrCode },
    config: { configValue },
    pids: { getActivePid },
    context: { scene: 'search' },
    ...overrides,
  };
  const service = createLinkRegistration(options);
  return { service, options, clock, current, attrCode, configValue, getActivePid };
}

export async function seed(db: Kysely<DB>) {
  for (const [id, suffix] of [
    [USER_A, '1'],
    [USER_B, '2'],
  ] as const) {
    await db
      .insertInto('users')
      .values({
        id,
        app_id: 'register-app',
        nickname: '合成用户',
        avatar: 'synthetic-avatar',
        invite_code: `demo${suffix}`,
        attr_code: `demo000${suffix}`,
        level: 'T1',
        register_method: 'synthetic',
        created_at: START,
        updated_at: START,
      })
      .execute();
  }
  for (const [id, digit] of [
    [DEVICE_A, 'a'],
    [DEVICE_B, 'b'],
  ] as const) {
    await db
      .insertInto('devices')
      .values({
        id,
        app_id: 'register-app',
        device_hash: digit.repeat(64),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('synthetic-cipher'),
        platform: 'ios',
        app_version: '0.0.0',
        last_seen_at: START,
        created_at: START,
        updated_at: START,
      })
      .execute();
  }
}

export async function stored(db: Kysely<DB>, linkId: string) {
  return db.selectFrom('links').selectAll().where('link_id', '=', linkId).executeTakeFirstOrThrow();
}

export async function logs(db: Kysely<DB>, linkId: string) {
  return db.selectFrom('link_logs').selectAll().where('link_id', '=', linkId).execute();
}
