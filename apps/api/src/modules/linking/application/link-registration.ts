// Card-time link registration (B1-06c; BR-PRICE-12, BR-ATTR-05/06/08/14, D33).
// A card registers a links row with its quote snapshot and a frozen identity_snapshot; it never
// converts (no union adapter call, convert_result stays null). Identity comes only from
// CallerContext: every identity field on the input (viewer included) is ignored.
// Snapshot reuse (BR-PRICE-12, optional): not done. Every card gets a new link_id, which meets
// D33 (any change of final price, coupon amount or coupon IDs gets a new snapshot) and never
// reuses across scenes; links has no index for a reuse lookup.
// links rows are only inserted here (row_version 0); the 0006 guards freeze the snapshot and later
// writers (open, B1-06d/k) update with CAS.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB } from '@couli/db';
import type { PidScene, Scene } from '@couli/contracts-ts';
import { sql, type Kysely, type RawBuilder, type Selectable } from 'kysely';
import type { LinkRegistrar, RegisterLinkInput, SourceLinkReader } from '../../catalog/index.ts';
import { newUuidV7, type Clock } from '../../platform/index.ts';
import {
  isPlatform,
  isPriceAnomaly,
  type PidPlatform,
  type Platform,
  type UnionPidService,
} from '../../union/index.ts';
import type { AttrCodeReader, Caller, CallerContext, LinkingConfigReader } from '../ports.ts';
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
    // B1-06k: inside an open re-check the card's link is the opened link's renewed snapshot.
    const openScope = openRegistrationScope.getStore();
    if (openScope !== undefined) return deferForOpen(openScope, input);
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

    const snapshot = await resolveSnapshot({
      caller,
      attrCodes,
      pids,
      platform,
      scene,
      agentSessionId: context.agentSessionId ?? null,
    });
    const now = clock.now();
    const linkId = newUuidV7(now);
    await db.transaction().execute(async (trx) => {
      await insertLinkRow(trx, {
        now,
        caller,
        linkId,
        snapshot,
        values: {
          platform,
          productKey: ref.productKey,
          rawItemId: ref.rawItemId,
          rawFetchedAt,
          scene,
          subScene: context.subScene ?? null,
          entrySource: input.entrySource,
          quotedFinalPriceFen: item.final_price_fen,
          quotedCouponFen: item.coupon_fen,
          quotedCouponId:
            item.coupon_ids === undefined || item.coupon_ids === '' ? null : item.coupon_ids,
          quotedAt,
          agentCardId: context.agentCardId ?? null,
        },
      });
      if (logsRegistration(scene, pidScene)) {
        await trx
          .insertInto('link_logs')
          .values({
            app_id: appId,
            link_id: linkId,
            event: 'register',
            user_id: snapshot.user_id,
            platform,
            product_key: ref.productKey,
            raw_item_id: ref.rawItemId,
            shop_id: ref.shopId,
            scene,
            pid_scene: snapshot.pid_scene,
            pid: snapshot.pid,
            quoted_price_fen: item.final_price_fen,
            agent_session_id: snapshot.agent_session_id,
            result_code: 0,
            created_at: now,
          })
          .execute();
      }
    });
    return { linkId };
  }

  /**
   * B1-06k (BR-PRICE-12, BR-ATTR-05): a changed snapshot at open is registered with the identity
   * and scene of the opened link (a share link keeps the sharer's snapshot), never with this
   * registration's fixed context or the current caller. Nothing is written here: the row is held
   * until the open decides the snapshot changed and commits it with its log and attempt.
   */
  function deferForOpen(
    scope: OpenRegistrationScope,
    input: RegisterLinkInput,
  ): Promise<{ readonly linkId: string }> {
    const { ref, item } = input;
    if (ref.appId !== scope.owner.appId) {
      throw new TypeError('linking: product ref belongs to another app scope');
    }
    const platform: unknown = ref.platform;
    if (
      !isPlatform(platform) ||
      item.platform !== platform ||
      scope.snapshot.platform !== platform
    ) {
      throw new TypeError(
        'linking: union item, product ref and opened link name different platforms',
      );
    }
    if (isPriceAnomaly(item)) {
      throw new TypeError('linking: price anomaly; link not registered');
    }
    const quotedAt = instant(item.quoted_at, 'quoted_at');
    const rawFetchedAt = instant(ref.rawFetchedAt, 'raw_fetched_at');
    const now = clock.now();
    const pending: PendingOpenLink = {
      now,
      caller: scope.owner,
      linkId: newUuidV7(now),
      snapshot: scope.snapshot,
      shopId: ref.shopId,
      values: {
        platform,
        productKey: ref.productKey,
        rawItemId: ref.rawItemId,
        rawFetchedAt,
        scene: scope.scene,
        subScene: scope.subScene,
        entrySource: input.entrySource,
        quotedFinalPriceFen: item.final_price_fen,
        quotedCouponFen: item.coupon_fen,
        quotedCouponId:
          item.coupon_ids === undefined || item.coupon_ids === '' ? null : item.coupon_ids,
        quotedAt,
        agentCardId: scope.agentCardId,
      },
    };
    scope.pending = pending;
    return Promise.resolve({ linkId: pending.linkId });
  }

  return { register, entrySource: (appId, linkId) => sourceLinks.entrySource(appId, linkId) };
}

/** B1-06k: the identity and scene an open's renewed snapshot inherits from the opened link. */
export interface OpenRegistrationScope {
  /** The identity's owner as a caller: app, snapshot user_id, the opened link's device. */
  readonly owner: Caller;
  readonly snapshot: IdentitySnapshot;
  readonly scene: Scene;
  readonly subScene: string | null;
  readonly agentCardId: string | null;
  /** Set by the registrar when the card registers; written only if the open commits it. */
  pending: PendingOpenLink | null;
}

/** A link registered for an open's renewed snapshot, not yet written. */
export interface PendingOpenLink {
  readonly now: Date;
  readonly caller: Caller;
  readonly linkId: string;
  readonly snapshot: IdentitySnapshot;
  readonly shopId: string | null;
  readonly values: LinkRowValues;
}

/** Set by the open re-check around catalog's card entry (B1-06k); internal to linking. */
export const openRegistrationScope = new AsyncLocalStorage<OpenRegistrationScope>();

/**
 * Writes a pending open link through the module's single links insert, with the register log of
 * the scenes that log registration, inside the open's transaction. Idempotent per link_id: a
 * link already written by an earlier open of the same flight is left as it is.
 */
export async function insertPendingOpenLink(
  executor: Kysely<DB>,
  pending: PendingOpenLink,
): Promise<void> {
  const { now, caller, linkId, snapshot, values } = pending;
  // B1-06m: opens sharing the card run in their own transactions. A row another open has written
  // but not yet committed makes this insert wait for that transaction: committed → nothing to do;
  // rolled back → this open writes the link (and its register log) itself.
  const inserted = await linkInsert(executor, { now, caller, linkId, snapshot, values })
    .onConflict((oc) => oc.column('link_id').doNothing())
    .returning('link_id')
    .executeTakeFirst();
  if (inserted === undefined) return;
  if (logsRegistration(values.scene, pidSceneOf(values.scene))) {
    await executor
      .insertInto('link_logs')
      .values({
        app_id: caller.appId,
        link_id: linkId,
        event: 'register',
        user_id: snapshot.user_id,
        platform: values.platform,
        product_key: values.productKey,
        raw_item_id: values.rawItemId,
        shop_id: pending.shopId,
        scene: values.scene,
        pid_scene: snapshot.pid_scene,
        pid: snapshot.pid,
        quoted_price_fen: values.quotedFinalPriceFen,
        agent_session_id: snapshot.agent_session_id,
        result_code: 0,
        created_at: now,
      })
      .execute();
  }
}

/** The card fields a links row is registered with; identity is never among them. */
export interface LinkRowValues {
  readonly platform: Platform;
  readonly productKey: string | null;
  readonly rawItemId: string | null;
  readonly rawFetchedAt: string | Date | null;
  readonly scene: Scene;
  readonly subScene: string | null;
  readonly entrySource: string | null;
  readonly quotedFinalPriceFen: bigint | null;
  readonly quotedCouponFen: bigint | null;
  readonly quotedCouponId: string | null;
  readonly quotedAt: string | Date | null;
  readonly agentCardId: string | null;
}

/**
 * The identity a new link freezes, from the caller only (BR-ATTR-05): user_id, attr_code from the
 * port (never the user_id, BR-ATTR-06), the active pid of the scene's pid_scene (BR-ATTR-08) and
 * the Agent session. Read before any transaction: it only reads other modules' ports.
 */
export async function resolveSnapshot(args: {
  readonly caller: Caller;
  readonly attrCodes: AttrCodeReader | undefined;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly platform: Platform;
  readonly scene: Scene;
  readonly agentSessionId: string | null;
}): Promise<IdentitySnapshot> {
  const { caller, attrCodes, pids, platform, scene, agentSessionId } = args;
  const appId = caller.appId;
  const pidScene: PidScene = pidSceneOf(scene);
  const attrCode = await attrCodeOf(attrCodes, appId, caller.userId);
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
  return {
    user_id: caller.userId,
    platform,
    pid,
    pid_scene: pidScene,
    attr_code: attrCode,
    agent_session_id: agentSessionId,
  };
}

/**
 * The single links insert of the module (B1-06c registration; B1-06d registers the opener's own
 * link through it too): row_version 0, expire_at from the pid_scene's URL lifetime; the inserted
 * row is returned as stored.
 */
interface LinkRowArgs {
  readonly now: Date;
  readonly caller: Caller;
  readonly linkId: string;
  readonly snapshot: IdentitySnapshot;
  readonly values: LinkRowValues;
}

export async function insertLinkRow(
  executor: Kysely<DB>,
  args: LinkRowArgs,
): Promise<Selectable<DB['links']>> {
  return linkInsert(executor, args).returningAll().executeTakeFirstOrThrow();
}

/** The module's single links insert statement (not yet executed). */
function linkInsert(executor: Kysely<DB>, args: LinkRowArgs) {
  const { now, caller, linkId, snapshot, values } = args;
  const pidScene = pidSceneOf(values.scene);
  if (
    snapshot.pid_scene !== pidScene ||
    snapshot.platform !== values.platform ||
    snapshot.user_id !== caller.userId
  ) {
    throw new TypeError('linking: identity snapshot does not match the row being registered');
  }
  return executor.insertInto('links').values({
    link_id: linkId,
    app_id: caller.appId,
    user_id: caller.userId,
    device_id: caller.deviceId,
    platform: values.platform,
    product_key: values.productKey,
    raw_item_id: values.rawItemId,
    raw_fetched_at: values.rawFetchedAt,
    scene: values.scene,
    sub_scene: values.subScene,
    pid_scene: pidScene,
    pid: snapshot.pid,
    entry_source: values.entrySource,
    identity_snapshot: snapshotJson(snapshot),
    quoted_final_price_fen: values.quotedFinalPriceFen,
    quoted_coupon_fen: values.quotedCouponFen,
    quoted_coupon_id: values.quotedCouponId,
    quoted_at: values.quotedAt,
    expire_at: sql<Date>`${now.toISOString()}::timestamptz + ${urlLifetimeMs(pidScene)} * interval '1 millisecond'`,
    agent_session_id: snapshot.agent_session_id,
    agent_card_id: values.agentCardId,
    row_version: 0,
    created_at: now,
    updated_at: now,
  });
}

/** BR-ATTR-06: attr_code only from the port; unavailable or empty stays null, never the user_id. */
export async function attrCodeOf(
  attrCodes: AttrCodeReader | undefined,
  appId: string,
  userId: string | null,
): Promise<string | null> {
  if (userId === null || attrCodes === undefined) return null;
  const value = await attrCodes.attrCode(appId, userId);
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The jsonb value of a snapshot; only strings and null, so JSON.stringify never meets a bigint. */
export function snapshotJson(
  snapshot: IdentitySnapshot,
): RawBuilder<DB['links']['identity_snapshot']> {
  return sql<DB['links']['identity_snapshot']>`${JSON.stringify(snapshot)}::jsonb`;
}
