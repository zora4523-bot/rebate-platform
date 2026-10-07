// linking open, first stage: whom the open serves (B1-06d; BR-ATTR-05 ①～⑤, BR-ATTR-11 default,
// BR-PRICE-12 / G-08 baseline). Identity comes only from CallerContext; every other field of the
// open input is ignored. The stage selects (or claims, or registers) the link that later stages
// authorize and convert; it does no price re-check, attempts, link_logs, authorization, routing or
// conversion (B1-06e/f/k).
// - share link (①): anyone, guests included, opens with the sharer's snapshot; the sharer himself
//   gets a new detail/self_buy link of his own (BR-ATTR-11 default).
// - own link (②): the stored link as it is.
// - guest link (②): the first logged-in opener claims it once — a conditional update of
//   links.user_id (where user_id is null) that also fills the identity snapshot's user_id and
//   attr_code, so the snapshot keeps naming whom the link converts for; no device check, no new
//   link. A lost claim rereads the link and decides again.
// - another user's link (③): a new link for the caller through the module's single links insert,
//   same scene (taolijin falls back to detail/self_buy with the owner-only notice), the original
//   quote snapshot copied as the baseline (amount_unknown stays null, never zero).
// - a guest opening a non-share link (④): 10001; unknown or foreign-app link (⑤): 30144.
import type { components, Scene } from '@couli/contracts-ts';
import { scene as SCENES } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import { isPlatform } from '../../union/index.ts';
import { LinkingError, decideOpenOwner, type OpenOwnerDecision } from '../domain/rules.ts';
import type { Caller } from '../ports.ts';
import {
  attrCodeOf,
  insertLinkRow,
  resolveSnapshot,
  snapshotJson,
  type IdentitySnapshot,
  type LinkingOptions,
} from './link-registration.ts';

/** B1-06d: ownership stage only; registration uses the existing B1-06c dependencies. */
export type LinkOpenOwnerOptions = Omit<LinkingOptions, 'context'>;

type LinkRow = Selectable<DB['links']>;

export interface LinkOpenOwnerResult {
  /** The persisted link selected for subsequent authorization/conversion. */
  readonly link: LinkRow;
  readonly identitySnapshot: IdentitySnapshot;
  readonly new_link_id: components['schemas']['OpenLinkResult']['new_link_id'];
  /**
   * Always the opened card's quote (BR-PRICE-12, G-08), even after registering a link for another
   * owner: the decimal string of quoted_final_price_fen, lossless beyond 2^53; null when the card
   * is amount_unknown (never zero).
   */
  readonly old_final_price_fen: string | null;
  /** Internal message for the later HTTP response, including the taolijin restriction. */
  readonly message: string | null;
}

export interface LinkOpenOwnerService {
  /**
   * CallerContext is the only identity source; unknown/foreign links fail with code 30144.
   * `trx` (B1-06m): the open's transaction, so a claim or a registered link commits or rolls back
   * with the rest of the open; without it the stage writes through the module's db handle.
   */
  open(input: { readonly linkId: string }, trx?: Kysely<DB>): Promise<LinkOpenOwnerResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): LinkingError {
  return new LinkingError(30144, 'link_not_found', []);
}

function stringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`linking: identity snapshot ${field} is malformed`);
  }
  return value;
}

/** The stored identity snapshot; a link without a well-formed one fails closed. */
function readSnapshot(link: LinkRow): IdentitySnapshot {
  const raw = link.identity_snapshot;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('linking: link has no identity snapshot');
  }
  const value = raw as Record<string, unknown>;
  const platform = stringOrNull(value['platform'], 'platform');
  const pidScene = stringOrNull(value['pid_scene'], 'pid_scene');
  if (platform === null || pidScene === null) {
    throw new TypeError('linking: identity snapshot lacks platform or pid_scene');
  }
  return {
    user_id: stringOrNull(value['user_id'], 'user_id'),
    platform,
    pid: stringOrNull(value['pid'], 'pid'),
    pid_scene: pidScene,
    attr_code: stringOrNull(value['attr_code'], 'attr_code'),
    agent_session_id: stringOrNull(value['agent_session_id'], 'agent_session_id'),
  };
}

function storedScene(link: LinkRow): Scene {
  if (!(SCENES as readonly string[]).includes(link.scene)) {
    throw new TypeError('linking: stored link scene is outside the contract enum');
  }
  return link.scene as Scene;
}

export function createLinkOpenOwner(options: LinkOpenOwnerOptions): LinkOpenOwnerService {
  const { db, clock, callerContext, attrCodes, pids } = options;

  async function load(
    executor: Kysely<DB>,
    caller: Caller,
    linkId: string,
  ): Promise<LinkRow | undefined> {
    return executor
      .selectFrom('links')
      .selectAll()
      .where('app_id', '=', caller.appId)
      .where('link_id', '=', linkId)
      .executeTakeFirst();
  }

  /** ②: claim a guest link once; undefined when another opener claimed it first. */
  async function claim(
    executor: Kysely<DB>,
    caller: Caller & { readonly userId: string },
    link: LinkRow,
    snapshot: IdentitySnapshot,
  ): Promise<{ readonly link: LinkRow; readonly snapshot: IdentitySnapshot } | undefined> {
    const claimed: IdentitySnapshot = {
      ...snapshot,
      user_id: caller.userId,
      attr_code: await attrCodeOf(attrCodes, caller.appId, caller.userId),
    };
    const row = await executor
      .updateTable('links')
      .set({
        user_id: caller.userId,
        identity_snapshot: snapshotJson(claimed),
        row_version: sql<number>`row_version + 1`,
        updated_at: clock.now(),
      })
      .where('app_id', '=', caller.appId)
      .where('link_id', '=', link.link_id)
      .where('user_id', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : { link: row, snapshot: claimed };
  }

  /** ③ and BR-ATTR-11: a new link for the caller, the opened card's quote as its baseline. */
  async function registerFor(
    executor: Kysely<DB>,
    caller: Caller,
    original: LinkRow,
    scene: Scene,
  ): Promise<{ readonly link: LinkRow; readonly snapshot: IdentitySnapshot }> {
    const platform: unknown = original.platform;
    if (!isPlatform(platform)) {
      throw new TypeError('linking: stored link names an unknown platform');
    }
    // The original's Agent session and card belong to its owner; the new link carries neither.
    const snapshot = await resolveSnapshot({
      caller,
      attrCodes,
      pids,
      platform,
      scene,
      agentSessionId: null,
    });
    const now = clock.now();
    const row = await insertLinkRow(executor, {
      now,
      caller,
      linkId: newUuidV7(now),
      snapshot,
      values: {
        platform,
        productKey: original.product_key,
        rawItemId: original.raw_item_id,
        rawFetchedAt: original.raw_fetched_at,
        scene,
        subScene: scene === original.scene ? original.sub_scene : null,
        entrySource: original.entry_source,
        quotedFinalPriceFen: original.quoted_final_price_fen,
        quotedCouponFen: original.quoted_coupon_fen,
        quotedCouponId: original.quoted_coupon_id,
        quotedAt: original.quoted_at,
        agentCardId: null,
      },
    });
    return { link: row, snapshot };
  }

  async function open(
    input: { readonly linkId: string },
    trx?: Kysely<DB>,
  ): Promise<LinkOpenOwnerResult> {
    const executor = trx ?? db;
    // Server-side identity only: app, user and device come from CallerContext, never the input.
    const caller = await callerContext.current();
    const linkId: unknown = input.linkId;
    if (typeof linkId !== 'string' || !UUID.test(linkId)) throw notFound();
    let link = await load(executor, caller, linkId);
    if (link === undefined) throw notFound();
    // The baseline is the opened card's quote, whatever link the caller ends up with (G-08).
    const quoted = link.quoted_final_price_fen;
    const baseline = quoted === null ? null : quoted.toString();

    // A lost claim decides once more on the reread row; a second claim is never attempted.
    for (let pass = 0; pass < 2; pass += 1) {
      const snapshot = readSnapshot(link);
      const decision: OpenOwnerDecision = decideOpenOwner({
        pidScene: link.pid_scene,
        scene: storedScene(link),
        snapshotUserId: snapshot.user_id,
        rowUserId: link.user_id,
        callerUserId: caller.userId,
      });
      switch (decision.kind) {
        case 'use':
          return {
            link,
            identitySnapshot: snapshot,
            new_link_id: null,
            old_final_price_fen: baseline,
            message: null,
          };
        case 'login':
          throw new LinkingError(10001, 'login_required', []);
        case 'register': {
          const fresh = await registerFor(executor, caller, link, decision.scene);
          return {
            link: fresh.link,
            identitySnapshot: fresh.snapshot,
            new_link_id: fresh.link.link_id,
            old_final_price_fen: baseline,
            message: decision.message,
          };
        }
        case 'claim': {
          if (pass > 0 || caller.userId === null) break;
          const claimed = await claim(
            executor,
            { ...caller, userId: caller.userId },
            link,
            snapshot,
          );
          if (claimed !== undefined) {
            return {
              link: claimed.link,
              identitySnapshot: claimed.snapshot,
              new_link_id: null,
              old_final_price_fen: baseline,
              message: null,
            };
          }
          const reread = await load(executor, caller, linkId);
          if (reread === undefined) throw notFound();
          link = reread;
          continue;
        }
      }
      break;
    }
    throw new Error('linking: guest link claim did not settle');
  }

  return { open };
}
