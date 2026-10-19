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
import { generateLinkCode, type LinkCodeDB } from '../infra/link-code.ts';
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
  /** B1-08s test seam: the lk source (default generateLinkCode, crypto.randomInt); production omits it. */
  readonly linkCode?: () => string;
  /** B1-08s: where an exhausted lk issuance is alerted (linking.link_code.exhausted). */
  readonly logger?: { error(fields: Readonly<Record<string, unknown>>, message?: string): void };
}

/** The alert sink of lk issuance; flat fields only (no lk, user_id, link_id or attr_code). */
export interface LinkCodeLogger {
  error?(fields: Readonly<Record<string, unknown>>, message?: string): void;
}

/** B1-08s: how a new link draws its lk; null when it gets none (lk NULL, no draw). */
export interface LinkCodeIssue {
  readonly draw: () => string;
  readonly logger: LinkCodeLogger | undefined;
  /** Draws tried at insert (default 4: the first plus 3 redraws); 1 for a code already in use. */
  readonly attempts?: number;
}

/** Configuration key attr.click_code.<platform> (BR-ATTR-15; default false). */
export function clickCodeKey(platform: 'jd' | 'pdd'): string {
  return `attr.click_code.${platform}`;
}

/** attr.click_code.<platform> is on only for the JSON value true ('on', 'true', 1 are off). */
export function clickCodeOn(value: unknown): boolean {
  return value === true;
}

/**
 * B1-08s (BR-ATTR-15): whether a link registered now gets an lk. Only jd / pdd, only a link with a
 * user (a guest link gets none; a later claim is an UPDATE and never issues one), and only while
 * attr.click_code.<platform> is JSON true. The switch is read through the given reader (inside an
 * open: its pre-read); a failed read throws as it is, never read as off.
 */
export async function linkCodeIssue(
  config: LinkingConfigReader,
  args: { readonly appId: string; readonly platform: string; readonly userId: string | null },
  options: { readonly linkCode?: () => string },
): Promise<LinkCodeIssue | null> {
  const { appId, platform, userId } = args;
  if ((platform !== 'jd' && platform !== 'pdd') || userId === null) return null;
  const value = await config.configValue(appId, clickCodeKey(platform));
  if (!clickCodeOn(value?.value)) return null;
  return { draw: options.linkCode ?? generateLinkCode, logger: alertLoggerOf(options) };
}

/**
 * The options' logger when it can alert errors. Open and convert options carry a logger typed for
 * warnings only (their composition passes the root logger), so it is checked, not assumed.
 */
function alertLoggerOf(options: object): LinkCodeLogger | undefined {
  const logger: unknown = (options as { readonly logger?: unknown }).logger;
  if (typeof logger !== 'object' || logger === null) return undefined;
  return typeof (logger as LinkCodeLogger).error === 'function'
    ? (logger as LinkCodeLogger)
    : undefined;
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
    const issue = await linkCodeIssue(config, { appId, platform, userId: caller.userId }, options);
    const now = clock.now();
    const linkId = newUuidV7(now);
    await db.transaction().execute(async (trx) => {
      await insertLinkRow(
        trx,
        {
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
        },
        issue,
      );
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
  issue: LinkCodeIssue | null = null,
): Promise<void> {
  const { now, caller, linkId, snapshot, values } = pending;
  // B1-06m: opens sharing the card run in their own transactions. A row another open has written
  // but not yet committed makes this insert wait for that transaction: committed → nothing to do;
  // rolled back → this open writes the link (and its register log) itself.
  const args = { now, caller, linkId, snapshot, values };
  const inserted = await insertWithCode(
    executor,
    args,
    issue,
    (lk) =>
      linkInsert(executor, args, lk)
        .onConflict((oc) => oc.column('link_id').doNothing())
        .returningAll()
        .executeTakeFirst(),
    'skip',
  );
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

/**
 * B1-06i: the caller's own link of POST /v1/links/convert, through the module's single links
 * insert inside the convert's transaction, with the register log of the scenes that log
 * registration (BR-ATTR-14). Returns the row as stored.
 */
export async function insertConvertLink(
  executor: Kysely<DB>,
  pending: PendingOpenLink,
  issue: LinkCodeIssue | null = null,
): Promise<Selectable<DB['links']>> {
  const { now, caller, linkId, snapshot, values } = pending;
  const row = await insertLinkRow(executor, { now, caller, linkId, snapshot, values }, issue);
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
  return row;
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
  issue: LinkCodeIssue | null = null,
): Promise<Selectable<DB['links']>> {
  const row = await insertWithCode(
    executor,
    args,
    issue,
    (lk) => linkInsert(executor, args, lk).returningAll().executeTakeFirstOrThrow(),
    'throw',
  );
  if (row === undefined) throw new Error('linking: link id already registered');
  return row;
}

/** BR-ATTR-15: the first draw plus at most 3 redraws on an (app_id, lk) collision. */
const LINK_CODE_ATTEMPTS = 4;

/**
 * B1-08s: a links insert with an lk (BR-ATTR-15). Without an issue the statement is exactly the
 * one given (lk NULL). With one, each draw is inserted with ON CONFLICT DO NOTHING without a
 * conflict target, so a collision never aborts the caller's transaction (a concurrent insert of
 * the same code is decided by the unique key once it commits or rolls back). An empty result is
 * then told apart: the link_id already exists → `onLinkId` ('skip': undefined, the pending open's
 * idempotency; 'throw': as a duplicate primary key always failed) — otherwise the draw collided on
 * (app_id, lk) and a new code is drawn. After 4 collisions the link is registered with lk NULL and
 * one error is logged (its orders match from ② on); registration never fails for want of a code.
 */
async function insertWithCode(
  executor: Kysely<DB>,
  args: LinkRowArgs,
  issue: LinkCodeIssue | null,
  plain: (lk: null) => Promise<Selectable<DB['links']> | undefined>,
  onLinkId: 'skip' | 'throw',
): Promise<Selectable<DB['links']> | undefined> {
  if (issue === null) return plain(null);
  const attempts = issue.attempts ?? LINK_CODE_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lk = issue.draw();
    const row = await linkInsert(executor, args, lk)
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) return row;
    const existing = await executor
      .selectFrom('links')
      .select('link_id')
      .where('link_id', '=', args.linkId)
      .executeTakeFirst();
    if (existing !== undefined) {
      if (onLinkId === 'skip') return undefined;
      throw new Error('linking: link id already registered');
    }
  }
  issue.logger?.error?.(
    {
      event: 'linking.link_code.exhausted',
      app_id: args.caller.appId,
      platform: args.values.platform,
    },
    'linking: link code collided on every draw; link registered without lk',
  );
  return plain(null);
}

/**
 * B1-08s: an lk for a link the open converts before it is written (an open's renewed snapshot,
 * B1-06k): drawn as at insert — at most 4 draws — but each checked with a read of (app_id, lk) on
 * the open's executor, since the conversion carries the code before the row exists. Null after 4
 * taken codes, with the exhausted alert; the insert then tries this code once (attempts 1).
 */
export async function drawFreeLinkCode(
  executor: Kysely<DB>,
  args: { readonly appId: string; readonly platform: string },
  issue: LinkCodeIssue,
): Promise<string | null> {
  for (let attempt = 0; attempt < LINK_CODE_ATTEMPTS; attempt += 1) {
    const lk = issue.draw();
    const taken = await (executor as unknown as Kysely<LinkCodeDB>)
      .selectFrom('links')
      .select('link_id')
      .where('app_id', '=', args.appId)
      .where('lk', '=', lk)
      .executeTakeFirst();
    if (taken === undefined) return lk;
  }
  issue.logger?.error?.(
    { event: 'linking.link_code.exhausted', app_id: args.appId, platform: args.platform },
    'linking: link code collided on every draw; link registered without lk',
  );
  return null;
}

/** The module's single links insert statement (not yet executed); lk is written here only. */
function linkInsert(executor: Kysely<DB>, args: LinkRowArgs, lk: string | null) {
  const { now, caller, linkId, snapshot, values } = args;
  const pidScene = pidSceneOf(values.scene);
  if (
    snapshot.pid_scene !== pidScene ||
    snapshot.platform !== values.platform ||
    snapshot.user_id !== caller.userId
  ) {
    throw new TypeError('linking: identity snapshot does not match the row being registered');
  }
  return (executor as unknown as Kysely<LinkCodeDB>).insertInto('links').values({
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
    lk,
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
