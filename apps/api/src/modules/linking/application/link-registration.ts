// Card-time link registration (B1-06c; BR-PRICE-12, BR-ATTR-05/06/08/14, D33).
// A card registers a links row with its quote snapshot and a frozen identity_snapshot; it never
// converts (no union adapter call, convert_result stays null). Identity comes only from
// CallerContext: every identity field on the input (viewer included) is ignored.
// Snapshot reuse (BR-PRICE-12, optional): not done. Every card gets a new link_id, which meets
// D33 (any change of final price, coupon amount or coupon IDs gets a new snapshot) and never
// reuses across scenes; links has no index for a reuse lookup.
// links rows are only inserted here (row_version 0); the 0006 guards freeze the snapshot and later
// writers (open, B1-06d/k) update with CAS.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { LinkRegistrar, RegisterLinkInput, SourceLinkReader } from '../../catalog/index.ts';
import { newUuidV7, type Clock } from '../../platform/index.ts';
import {
  isPlatform,
  isPriceAnomaly,
  type PidPlatform,
  type UnionPidService,
} from '../../union/index.ts';
import type { AttrCodeReader, CallerContext, LinkingConfigReader } from '../ports.ts';
import {
  TLJ_SWITCH,
  LinkingError,
  isSwitchOn,
  logsRegistration,
  parseScene,
  pidSceneOf,
  urlLifetimeMs,
} from '../domain/rules.ts';

export interface RegistrationContext {
  /** Validated against the contract scene enum; invalid/missing values fail with code 20001. */
  readonly scene: string;
  readonly subScene?: string | null;
  readonly agentSessionId?: string | null;
  readonly agentCardId?: string | null;
}

export interface LinkingOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  /** Omitted until identity wiring: unavailable, never a userId fallback. */
  readonly attrCodes?: AttrCodeReader;
  readonly config: LinkingConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly context: RegistrationContext;
}

/** Implements both catalog ports without making catalog depend on linking. */
export interface LinkRegistration extends LinkRegistrar, SourceLinkReader {}

/** The identity frozen on a link at registration (BR-ATTR-05); attr_code is the 归因参数. */
export interface IdentitySnapshot {
  readonly user_id: string | null;
  readonly platform: string;
  readonly pid: string | null;
  readonly pid_scene: string;
  readonly attr_code: string | null;
  readonly agent_session_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The instant as given, after checking it parses; a malformed instant registers nothing. */
function instant(value: string, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`linking: ${field} is not an instant; link not registered`);
  }
  return value;
}

/**
 * Reads the entry_source of a link in the given app scope (BR-PRICE-07 inheritance). Read only:
 * no write, no log, expiry irrelevant. A foreign, unknown or malformed link ID gives null.
 */
export function createSourceLinkReader(db: Kysely<DB>): SourceLinkReader {
  return {
    async entrySource(appId, linkId) {
      if (typeof appId !== 'string' || typeof linkId !== 'string' || !UUID.test(linkId)) {
        return null;
      }
      const row = await db
        .selectFrom('links')
        .select('entry_source')
        .where('app_id', '=', appId)
        .where('link_id', '=', linkId)
        .executeTakeFirst();
      return row?.entry_source ?? null;
    },
  };
}

export function createLinkRegistration(options: LinkingOptions): LinkRegistration {
  const { db, clock, callerContext, attrCodes, config, pids, context } = options;
  const sourceLinks = createSourceLinkReader(db);

  async function register(input: RegisterLinkInput): Promise<{ readonly linkId: string }> {
    const scene = parseScene(context.scene);
    const pidScene = pidSceneOf(scene);
    // Server-side identity only; input.viewer and any other identity field are ignored.
    const caller = await callerContext.current();
    const appId = caller.appId;
    if (scene === 'taolijin') {
      const value = await config.configValue(appId, TLJ_SWITCH);
      if (!isSwitchOn(value?.value)) throw new LinkingError(20001, 'scene_disabled', ['scene']);
    }

    const { ref, item } = input;
    if (ref.appId !== appId) {
      throw new TypeError('linking: product ref belongs to another app scope');
    }
    const platform: unknown = ref.platform;
    if (!isPlatform(platform) || item.platform !== platform) {
      throw new TypeError('linking: union item and product ref name different platforms');
    }
    // D33: a price anomaly never gets a link (catalog's own check does not read price_status).
    if (isPriceAnomaly(item)) {
      throw new TypeError('linking: price anomaly; link not registered');
    }
    const quotedAt = instant(item.quoted_at, 'quoted_at');
    const rawFetchedAt = instant(ref.rawFetchedAt, 'raw_fetched_at');

    const userId = caller.userId;
    // BR-ATTR-06: attr_code only from the port; unavailable stays null, never the user_id.
    const attrCode =
      userId === null || attrCodes === undefined
        ? null
        : ((await attrCodes.attrCode(appId, userId)) ?? null);
    const pidRow = await pids.getActivePid({
      appId,
      platform: platform as PidPlatform,
      pidScene,
      purpose: 'convert',
    });
    // Only an active row of exactly this app, platform and pid_scene is frozen; anything else
    // (none, or a row of another scope) leaves pid empty for open to judge.
    const pid =
      pidRow !== null &&
      pidRow.status === 'active' &&
      pidRow.app_id === appId &&
      pidRow.platform === platform &&
      pidRow.pid_scene === pidScene
        ? pidRow.pid
        : null;
    const agentSessionId = context.agentSessionId ?? null;

    const now = clock.now();
    const linkId = newUuidV7(now);
    const snapshot: IdentitySnapshot = {
      user_id: userId,
      platform,
      pid,
      pid_scene: pidScene,
      attr_code: typeof attrCode === 'string' && attrCode !== '' ? attrCode : null,
      agent_session_id: agentSessionId,
    };
    const couponIds =
      item.coupon_ids === undefined || item.coupon_ids === '' ? null : item.coupon_ids;

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('links')
        .values({
          link_id: linkId,
          app_id: appId,
          user_id: userId,
          device_id: caller.deviceId,
          platform,
          product_key: ref.productKey,
          raw_item_id: ref.rawItemId,
          raw_fetched_at: rawFetchedAt,
          scene,
          sub_scene: context.subScene ?? null,
          pid_scene: pidScene,
          pid,
          entry_source: input.entrySource,
          // Only strings and null: JSON.stringify never meets a bigint here.
          identity_snapshot: sql<
            DB['links']['identity_snapshot']
          >`${JSON.stringify(snapshot)}::jsonb`,
          quoted_final_price_fen: item.final_price_fen,
          quoted_coupon_fen: item.coupon_fen,
          quoted_coupon_id: couponIds,
          quoted_at: quotedAt,
          expire_at: sql<Date>`${now.toISOString()}::timestamptz + ${urlLifetimeMs(pidScene)} * interval '1 millisecond'`,
          agent_session_id: agentSessionId,
          agent_card_id: context.agentCardId ?? null,
          row_version: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
      if (logsRegistration(scene, pidScene)) {
        await trx
          .insertInto('link_logs')
          .values({
            app_id: appId,
            link_id: linkId,
            event: 'register',
            user_id: userId,
            platform,
            product_key: ref.productKey,
            raw_item_id: ref.rawItemId,
            shop_id: ref.shopId,
            scene,
            pid_scene: pidScene,
            pid,
            quoted_price_fen: item.final_price_fen,
            agent_session_id: agentSessionId,
            result_code: 0,
            created_at: now,
          })
          .execute();
      }
    });
    return { linkId };
  }

  return { register, entrySource: (appId, linkId) => sourceLinks.entrySource(appId, linkId) };
}
