import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import {
  createLinkOpenOwner,
  createLinkRegistration,
  type Caller,
  type LinkOpenOwnerOptions,
  type RegistrationContext,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { FixedClock, newUuidV7 } from '../../../../apps/api/src/modules/platform/index.ts';
import type { ActivePidInput, Platform } from '../../../../apps/api/src/modules/union/index.ts';
import { caller, input, pid, START, USER_A, USER_B } from '../register/kit.ts';

export {
  DEVICE_A,
  DEVICE_B,
  QUOTED,
  RAW_AT,
  SESSION,
  START,
  USER_A,
  USER_B,
} from '../register/kit.ts';
export const USER_C = '0199a3b4-5c6d-7000-8000-000000000008';

export function ownerFixture(db: Kysely<DB>, opener: Partial<Caller> = {}) {
  const clock = new FixedClock(START);
  const current = vi.fn(async () => caller({ userId: USER_B, ...opener }));
  const attrCode = vi.fn(async (_appId: string, userId: string) => {
    return userId === USER_A ? 'demo0001' : userId === USER_B ? 'demo0002' : 'demo0003';
  });
  const getActivePid = vi.fn(async (query: ActivePidInput) => pid(query));
  const configValue = vi.fn(async () => ({ value: true, version: 1 }));
  const options: LinkOpenOwnerOptions = {
    db,
    clock,
    callerContext: { current },
    attrCodes: { attrCode },
    pids: { getActivePid },
    config: { configValue },
  };
  return { options, current, attrCode, getActivePid, clock };
}

/** Real B1-06c registration: fixtures never implement the ownership decisions. */
export async function sourceLink(
  db: Kysely<DB>,
  context: RegistrationContext = { scene: 'search' },
  owner: Partial<Caller> = {},
  platform: Platform = 'taobao',
  price: bigint = 10000n,
) {
  const f = ownerFixture(db, { userId: USER_A, ...owner });
  const request = input();
  const registration = createLinkRegistration({ ...f.options, context });
  const registered = await registration.register({
    ...request,
    ref: { ...request.ref, platform },
    item: {
      ...request.item,
      platform,
      price_fen: price === 10000n ? 12000n : price,
      coupon_fen: price === 10000n ? 2000n : 0n,
      final_price_fen: price,
    },
  });
  return stored(db, registered.linkId);
}

/** An existing amount_unknown card: synthetic row, since B1-06c accepts priced cards only. */
export async function unknownPriceLink(db: Kysely<DB>) {
  const original = await sourceLink(db);
  const linkId = newUuidV7(new Date(START));
  await db
    .insertInto('links')
    .values({
      ...original,
      link_id: linkId,
      quoted_final_price_fen: null,
      quoted_coupon_fen: null,
      quoted_coupon_id: null,
    })
    .execute();
  return stored(db, linkId);
}

/** Synthetic PDD direct-link card: no product information or quote snapshot. */
export async function unknownPricePddLink(db: Kysely<DB>) {
  const original = await sourceLink(db, { scene: 'clipboard' }, {}, 'pdd');
  const linkId = newUuidV7(new Date(START));
  await db
    .insertInto('links')
    .values({
      ...original,
      link_id: linkId,
      product_key: null,
      raw_item_id: null,
      raw_fetched_at: null,
      quoted_final_price_fen: null,
      quoted_coupon_fen: null,
      quoted_coupon_id: null,
      quoted_at: null,
    })
    .execute();
  return stored(db, linkId);
}

export function ownerService(f: ReturnType<typeof ownerFixture>) {
  // Construct outside rejection assertions: the skeleton must make negative cases red too.
  return createLinkOpenOwner(f.options);
}

export async function stored(db: Kysely<DB>, linkId: string) {
  return db.selectFrom('links').selectAll().where('link_id', '=', linkId).executeTakeFirstOrThrow();
}

export async function allLinks(db: Kysely<DB>) {
  return db.selectFrom('links').selectAll().orderBy('link_id').execute();
}
