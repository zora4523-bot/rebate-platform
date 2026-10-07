// B1-06k: linking open, second stage — the price re-check (BR-PRICE-12/13/14/20, D33), the open
// link_logs event (BR-ATTR-14) and the open attempt (link_open_attempts, BR-ATTR-21 ①). An
// application-stage boundary, not an HTTP response: amounts keep B1-06d's lossless decimal-string
// representation; the later HTTP adapter owns wire serialization.
// Flow per request: CallerContext → platform idempotency (same key → the first result, nothing
// re-run) → B1-06d owner stage → single flight of the opened link_id (3000 ms from the first
// arrival, inclusive: the price conclusion, errors included, is shared; the card is shared per
// opener; the conversion per identity key) → link_logs (every open, failures too) and, on
// success, link_open_attempts in the same transaction.
// - old is always the opened card's quoted_final_price_fen; amount_unknown only converts.
// - new comes from prices.fetch, assembled through catalog's active_query entry (the quote is
//   catalog's); link.open.requote_after_sec > 0 lets a snapshot younger than N seconds (by its
//   original quoted_at) stand as new, without rebate amounts (no fresh quote exists then).
// - a changed snapshot (final price, coupon amount or coupon IDs, D33) answers with the card's
//   link. Inside the re-check catalog's registrar (B1-06c) only reserves it with the opened
//   link's identity snapshot and scene (a share link keeps the sharer, BR-PRICE-12 2026-10-07);
//   the row is written in the open's transaction with the log and attempt, and never when the
//   snapshot is unchanged or the conversion fails. A share link opened by anyone but the sharer
//   shows no rebate (BR-ATTR-10).
// - off-shelf 30141 > coupon_gone > price_changed; taolijin claimed out 30602; anomalies,
//   price_unavailable, fetch or assembly failures → the requote-failed branch: the identity's
//   conversion cache (≤ link.convert_cache_ttl_sec, at most 900 s) with requote_failed, else 50303.
//   A failed conversion after a good price is 50303 too.
// - conversion and its cache are ports; the cache key is the frozen identity's owner (never the
//   opener or links.user_id), app, platform, product, pid, pid_scene and no_rebate.
// B1-06e: the conversion port may admit first (convert.enabled.<platform> → 50301 before any
// cache or price work), names the jump-plan variant (client × installed) that keys and guards the
// cache, and fails with 50301 (paused) or 50303 (with the unpromoted page used only by an explicit
// no_rebate purchase). A cached jump past its jump.expire_at is never reused. A share link opened
// by anyone but the sharer ignores no_rebate (BR-ATTR-05 ①); no_rebate never renews the snapshot.
// Not here: authorization (30101/30102/30111), taobao (B1-06f).
import type { components, Scene } from '@couli/contracts-ts';
import { scene as SCENES } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';
import type { AssembleCardInput, CatalogCardEntry } from '../../catalog/index.ts';
import { newUuidV7, type Idempotency, type HandlerResult } from '../../platform/index.ts';
import {
  CONVERT_CACHE_TTL_SEC,
  DEFAULT_PRICE_CHANGE_MIN_FEN,
  DEFAULT_PRICE_CHANGE_RATIO_BP,
  DEFAULT_REQUOTE_AFTER_SEC,
  LinkingError,
  MAX_CONVERT_CACHE_TTL_SEC,
  PDD_PRECHECK_SWITCH,
  PRICE_CHANGE_MIN_FEN,
  PRICE_CHANGE_RATIO_BP,
  REQUOTE_AFTER_SEC,
  SINGLE_FLIGHT_MS,
  couponGone,
  couponIdsOf,
  intSetting,
  isSwitchOn,
  priceChanged,
  quoteSnapshotChanged,
} from '../domain/rules.ts';
import type { Caller } from '../ports.ts';
import {
  insertPendingOpenLink,
  openRegistrationScope,
  type OpenRegistrationScope,
  type PendingOpenLink,
} from './link-registration.ts';
import {
  createLinkOpenOwner,
  type LinkOpenOwnerOptions,
  type LinkOpenOwnerResult,
} from './link-open-owner.ts';

export type LinkOpenJump = components['schemas']['JumpPlan'];

/** Only normalized catalog input, never fabricated platform payloads. */
export type LinkOpenPrice =
  | { readonly kind: 'off_shelf' }
  | { readonly kind: 'tlj_empty' }
  | { readonly kind: 'available'; readonly input: AssembleCardInput };

export interface LinkOpenCacheKey {
  readonly appId: string;
  /** The frozen identity's owner, not necessarily the opener or links.user_id. */
  readonly userId: string | null;
  readonly platform: string;
  readonly productKey: string | null;
  readonly rawItemId: string | null;
  readonly pid: string | null;
  readonly pidScene: string;
  readonly noRebate: boolean;
  /** The jump-plan variant (client × installed) when the conversion port names one. */
  readonly variant?: string;
}

export interface LinkOpenCachedJump {
  readonly jump: LinkOpenJump;
  readonly fetchedAt: string;
  /** The jump-plan variant the jump was built for; a mismatch is a miss. */
  readonly variant?: string;
}

export interface LinkOpenConversionInput {
  readonly owner: LinkOpenOwnerResult;
  readonly noRebate: boolean;
  readonly installed: components['schemas']['OpenLinkRequest']['installed'];
  readonly client: LinkOpenRequoteInput['client'];
  readonly idempotencyKey: string;
  readonly traceId: string;
}

/** The conversion port: convert, plus the optional admission and plan variant (B1-06e). */
export interface LinkOpenConversionPort {
  convert(input: LinkOpenConversionInput): Promise<LinkOpenJump>;
  admit?(owner: LinkOpenOwnerResult): Promise<void>;
  variant?(input: Pick<LinkOpenConversionInput, 'client' | 'installed'>): string;
}

export interface LinkOpenRequoteOptions extends LinkOpenOwnerOptions {
  readonly catalog: CatalogCardEntry;
  readonly prices: { fetch(owner: LinkOpenOwnerResult): Promise<LinkOpenPrice> };
  readonly conversion: LinkOpenConversionPort;
  readonly cache: {
    get(key: LinkOpenCacheKey): Promise<LinkOpenCachedJump | null>;
    put(key: LinkOpenCacheKey, value: LinkOpenCachedJump): Promise<void>;
  };
  readonly idempotency: Pick<Idempotency, 'execute'>;
  // TODO(规划/11 §4.5): 拼多多比价预判开关打开的分支 — blocked on CAP-PDD-04。
}

export interface LinkOpenRequoteInput {
  readonly linkId: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
  /** Server-resolved client; not copied from an untrusted body. */
  readonly client: 'ios' | 'android' | 'harmony' | 'h5' | 'web';
  readonly installed?: components['schemas']['OpenLinkRequest']['installed'];
  readonly noRebate?: boolean;
  /** BR-ID-18: only meaningful with no_rebate=true; default auth_declined. */
  readonly noRebateReason?: components['schemas']['OpenLinkRequest']['no_rebate_reason'];
}

export type LinkOpenRequoteResult = Omit<
  components['schemas']['OpenLinkResult'],
  'old_final_price_fen' | 'new_final_price_fen' | 'new_rebate_min_fen' | 'new_rebate_max_fen'
> & {
  readonly old_final_price_fen: string | null;
  readonly new_final_price_fen: string | null;
  readonly new_rebate_min_fen: string | null;
  readonly new_rebate_max_fen: string | null;
};

export type LinkOpenRequoteOutcome =
  | { readonly code: 0; readonly data: LinkOpenRequoteResult }
  | { readonly code: number; readonly data: null };

export interface LinkOpenRequoteService {
  open(input: LinkOpenRequoteInput): Promise<LinkOpenRequoteOutcome>;
}

type LinkRow = Selectable<DB['links']>;
type Availability = components['schemas']['Availability'];

/** The re-check's price conclusion, shared by every open of the link inside the flight window. */
type PriceConclusion =
  | { readonly kind: 'off_shelf' }
  | { readonly kind: 'tlj_empty' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'fresh' }
  | { readonly kind: 'available'; readonly input: AssembleCardInput };

/** The re-quoted card of one opener: amounts from the item, rebates and link from catalog. */
type CardConclusion =
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'card';
      readonly finalFen: bigint;
      readonly couponFen: bigint;
      readonly couponIds: string | null;
      readonly rebateMinFen: string | null;
      readonly rebateMaxFen: string | null;
      readonly linkId: string;
      /** The renewed snapshot's link, held until an open commits it (null: already written). */
      readonly pending: PendingOpenLink | null;
      /** Serializes the commits of the opens sharing this card, so the link is written once. */
      tail: Promise<void>;
      readonly quotedAt: string;
    };

type Converted =
  | { readonly kind: 'ok'; readonly jump: LinkOpenJump; readonly cacheHit: boolean }
  | { readonly kind: 'failed'; readonly code: number; readonly noRebateUrl: string | null };

/** A failed conversion's code: 50301 when the port paused it, otherwise 50303. */
function conversionFailure(error: unknown): Extract<Converted, { kind: 'failed' }> {
  const code = (error as { code?: unknown } | null)?.code;
  const url = (error as { noRebateUrl?: unknown } | null)?.noRebateUrl;
  return {
    kind: 'failed',
    code: code === 50301 ? 50301 : 50303,
    noRebateUrl: code === 50303 && typeof url === 'string' && url !== '' ? url : null,
  };
}

interface Flight {
  readonly arrivedAtMs: number;
  /** Started by the first priced open of the window (amount_unknown never fetches). */
  price: Promise<PriceConclusion> | null;
  readonly cards: Map<string, Promise<CardConclusion>>;
  readonly conversions: Map<string, Promise<Converted>>;
}

interface Settled {
  readonly code: number;
  /** The link the log and attempt are written for. */
  readonly linkId: string;
  /** Present when linkId is a renewed snapshot not yet written; it commits with the log. */
  readonly card?: Extract<CardConclusion, { kind: 'card' }>;
  readonly quotedPriceFen: bigint | null;
  readonly cacheHit: boolean;
  readonly data: Omit<LinkOpenRequoteResult, 'attempt_id'> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  50301: 'convert_paused',
  30141: 'off_shelf',
  30602: 'tlj_claimed_out',
  50303: 'requote_failed',
};

const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  20001: 400,
  30141: 422,
  30144: 404,
  30602: 422,
  50301: 503,
  50303: 503,
};

function fenString(value: number | null): string | null {
  return value === null ? null : BigInt(value).toString();
}

/** The re-check's quote instant as the union item gives it (catalog already validated it). */
function instantOf(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError('linking: re-check quoted_at is not an instant');
  }
  return value;
}

/** The stored scene of the opened link (B1-06d already checked it against the enum). */
function storedSceneOf(link: LinkRow): Scene {
  if (!(SCENES as readonly string[]).includes(link.scene)) {
    throw new TypeError('linking: stored link scene is outside the contract enum');
  }
  return link.scene as Scene;
}

/**
 * BR-ATTR-05 ① / BR-ATTR-10: a share link opened by anyone but the sharer converts with the
 * sharer's identity and the buyer earns nothing from it, so the opener's quote is not shown.
 */
function rebatesShown(
  caller: Caller,
  owner: LinkOpenOwnerResult,
  min: string | null,
  max: string | null,
): { readonly min: string | null; readonly max: string | null } {
  const { identitySnapshot } = owner;
  const sharedByOther =
    identitySnapshot.pid_scene === 'share' && identitySnapshot.user_id !== caller.userId;
  return sharedByOther ? { min: '0', max: '0' } : { min, max };
}

/** BR-ATTR-05 ①: a share link opened by anyone but the sharer keeps the sharer's attribution. */
function effectiveNoRebate(caller: Caller, owner: LinkOpenOwnerResult, requested?: boolean) {
  const { identitySnapshot } = owner;
  const sharedByOther =
    identitySnapshot.pid_scene === 'share' && identitySnapshot.user_id !== caller.userId;
  return requested === true && !sharedByOther;
}

function openerKey(caller: Caller): string {
  return caller.userId !== null ? `u:${caller.userId}` : `d:${caller.deviceId ?? ''}`;
}

export function createLinkOpenRequote(options: LinkOpenRequoteOptions): LinkOpenRequoteService {
  const { db, clock, callerContext, config, catalog, prices, conversion, cache, idempotency } =
    options;
  const owners = createLinkOpenOwner(options);
  const flights = new Map<string, Flight>();

  async function setting(appId: string, key: string, fallback: number): Promise<number> {
    const value = await config.configValue(appId, key);
    return intSetting(value?.value, fallback);
  }

  function variantOf(input: LinkOpenRequoteInput): string | undefined {
    return conversion.variant?.({ client: input.client, installed: input.installed ?? 'unknown' });
  }

  function cacheKeyOf(owner: LinkOpenOwnerResult, input: LinkOpenRequoteInput): LinkOpenCacheKey {
    const { link, identitySnapshot } = owner;
    const noRebate = input.noRebate === true;
    const variant = variantOf(input);
    return {
      appId: link.app_id,
      userId: identitySnapshot.user_id,
      platform: link.platform,
      productKey: link.product_key,
      rawItemId: link.raw_item_id,
      pid: identitySnapshot.pid,
      pidScene: identitySnapshot.pid_scene,
      noRebate,
      ...(variant === undefined ? {} : { variant }),
    };
  }

  /**
   * A cached jump of exactly this identity and plan variant, no older than the configured TTL
   * (≤ 900 s) and still before its jump.expire_at (BR-ATTR-05 ②: the URL's usable period).
   */
  async function cached(appId: string, key: LinkOpenCacheKey): Promise<LinkOpenJump | null> {
    const ttlSec = Math.min(
      await setting(appId, CONVERT_CACHE_TTL_SEC, MAX_CONVERT_CACHE_TTL_SEC),
      MAX_CONVERT_CACHE_TTL_SEC,
    );
    const entry = await cache.get(key);
    if (entry === null) return null;
    const fetchedMs = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(fetchedMs)) return null;
    if ((entry.variant ?? undefined) !== key.variant) return null;
    const nowMs = clock.now().getTime();
    const expireMs = Date.parse(entry.jump.expire_at);
    if (!Number.isFinite(expireMs) || nowMs >= expireMs) return null;
    const age = nowMs - fetchedMs;
    return age >= 0 && age <= ttlSec * 1000 ? entry.jump : null;
  }

  /** Cache first, else a real-time conversion that refreshes the cache; null when it failed. */
  async function convertFor(
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
  ): Promise<Converted> {
    const noRebate = input.noRebate === true;
    const key = cacheKeyOf(owner, input);
    const hit = await cached(owner.link.app_id, key);
    if (hit !== null) return { kind: 'ok', jump: hit, cacheHit: true };
    let jump: LinkOpenJump;
    try {
      jump = await conversion.convert({
        owner,
        noRebate,
        installed: input.installed ?? 'unknown',
        client: input.client,
        idempotencyKey: input.idempotencyKey,
        traceId: input.traceId,
      });
    } catch (error) {
      return conversionFailure(error);
    }
    const variant = key.variant;
    await cache.put(key, {
      jump,
      fetchedAt: clock.now().toISOString(),
      ...(variant === undefined ? {} : { variant }),
    });
    return { kind: 'ok', jump, cacheHit: false };
  }

  /** BR-PRICE-20 and the fetch: one conclusion per flight, failures folded into 'failed'. */
  async function concludePrice(owner: LinkOpenOwnerResult): Promise<PriceConclusion> {
    const after = await setting(owner.link.app_id, REQUOTE_AFTER_SEC, DEFAULT_REQUOTE_AFTER_SEC);
    const quotedAt = owner.link.quoted_at;
    if (after > 0 && quotedAt !== null) {
      const age = clock.now().getTime() - quotedAt.getTime();
      if (age >= 0 && age <= after * 1000) return { kind: 'fresh' };
    }
    let price: LinkOpenPrice;
    try {
      price = await prices.fetch(owner);
    } catch {
      return { kind: 'failed' };
    }
    if (price.kind === 'available') return { kind: 'available', input: price.input };
    return price;
  }

  /** catalog's active-query entry: anomalies and assembly failures fail closed. */
  async function concludeCard(
    owner: LinkOpenOwnerResult,
    input: AssembleCardInput,
  ): Promise<CardConclusion> {
    // TODO(规划/11 §4.5): 拼多多比价预判开关打开的分支（以本次转链身份取预判，结果只对本次点击有效，
    // no_rebate 与他人打开分享链接不取） — blocked on CAP-PDD-04。开关打开时暂按关闭处理。
    if (owner.link.platform === 'pdd') {
      const precheck = await config.configValue(owner.link.app_id, PDD_PRECHECK_SWITCH);
      void isSwitchOn(precheck?.value);
    }
    const { link, identitySnapshot } = owner;
    const scope: OpenRegistrationScope = {
      owner: { appId: link.app_id, userId: identitySnapshot.user_id, deviceId: link.device_id },
      snapshot: identitySnapshot,
      scene: storedSceneOf(link),
      subScene: link.sub_scene,
      agentCardId: link.agent_card_id,
      pending: null,
    };
    let result;
    try {
      result = await openRegistrationScope.run(scope, () =>
        catalog.assemble({
          ...input,
          entrySource: link.entry_source,
          scene: 'active_query',
        }),
      );
    } catch {
      return { kind: 'failed' };
    }
    if (result.kind !== 'card') return { kind: 'failed' };
    const pending = scope.pending?.linkId === result.card.link_id ? scope.pending : null;
    const { item } = input;
    return {
      kind: 'card',
      finalFen: item.final_price_fen,
      couponFen: item.coupon_fen,
      couponIds: couponIdsOf(item.coupon_ids),
      rebateMinFen: fenString(result.card.rebate_min_fen),
      rebateMaxFen: fenString(result.card.rebate_max_fen),
      linkId: result.card.link_id,
      pending,
      tail: Promise.resolve(),
      quotedAt: instantOf(item.quoted_at),
    };
  }

  function flightFor(owner: LinkOpenOwnerResult, linkId: string, nowMs: number): Flight {
    for (const [key, flight] of flights) {
      if (nowMs - flight.arrivedAtMs > SINGLE_FLIGHT_MS) flights.delete(key);
    }
    const key = `${owner.link.app_id}\u0000${linkId}`;
    const current = flights.get(key);
    if (current !== undefined && nowMs - current.arrivedAtMs <= SINGLE_FLIGHT_MS) return current;
    const flight: Flight = {
      arrivedAtMs: nowMs,
      price: null,
      cards: new Map(),
      conversions: new Map(),
    };
    flights.set(key, flight);
    return flight;
  }

  function sharedConversion(
    flight: Flight,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
  ): Promise<Converted> {
    const key = JSON.stringify(cacheKeyOf(owner, input));
    let pending = flight.conversions.get(key);
    if (pending === undefined) {
      pending = convertFor(owner, input);
      flight.conversions.set(key, pending);
    }
    return pending;
  }

  function failure(code: number, owner: LinkOpenOwnerResult): Settled {
    return {
      code,
      linkId: owner.link.link_id,
      quotedPriceFen: owner.link.quoted_final_price_fen,
      cacheHit: false,
      data: null,
    };
  }

  /**
   * A failed conversion: 50301 / 50303 for the open, except an explicit no_rebate purchase whose
   * conversion failed, which jumps to the unpromoted product page (BR-PRICE-08) — never cached.
   */
  function conversionFallback(
    converted: Extract<Converted, { kind: 'failed' }>,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
  ): LinkOpenJump | null {
    if (converted.code !== 50303 || input.noRebate !== true || converted.noRebateUrl === null) {
      return null;
    }
    return {
      primary: { type: 'h5', value: converted.noRebateUrl },
      fallbacks: [],
      expire_at: owner.link.expire_at.toISOString(),
    };
  }

  /** BR-PRICE-13 failure branch: this identity's fresh cache with requote_failed, else 50303. */
  async function requoteFailed(
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
  ): Promise<Settled> {
    const jump = await cached(owner.link.app_id, cacheKeyOf(owner, input));
    if (jump === null) return failure(50303, owner);
    return {
      code: 0,
      linkId: owner.link.link_id,
      quotedPriceFen: owner.link.quoted_final_price_fen,
      cacheHit: true,
      data: {
        jump,
        price_changed: false,
        old_final_price_fen: owner.old_final_price_fen,
        new_final_price_fen: null,
        new_link_id: owner.new_link_id,
        requote_failed: true,
        new_rebate_min_fen: null,
        new_rebate_max_fen: null,
        no_rebate_cause: null,
        availability: 'ok',
        quoted_at: null,
      },
    };
  }

  async function settle(
    caller: Caller,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    nowMs: number,
  ): Promise<Settled> {
    const flight = flightFor(owner, input.linkId, nowMs);
    const link: LinkRow = owner.link;

    // BR-PROD-10: a paused platform answers 50301 before any cache or price work.
    if (conversion.admit !== undefined) {
      try {
        await conversion.admit(owner);
      } catch (error) {
        return failure(conversionFailure(error).code === 50301 ? 50301 : 50303, owner);
      }
    }

    // BR-PRICE-13: amount_unknown has no snapshot; it only converts.
    if (owner.old_final_price_fen === null) {
      const converted = await sharedConversion(flight, owner, input);
      if (converted.kind === 'failed') return failure(converted.code, owner);
      return {
        code: 0,
        linkId: link.link_id,
        quotedPriceFen: null,
        cacheHit: converted.cacheHit,
        data: {
          jump: converted.jump,
          price_changed: false,
          old_final_price_fen: null,
          new_final_price_fen: null,
          new_link_id: owner.new_link_id,
          requote_failed: false,
          new_rebate_min_fen: null,
          new_rebate_max_fen: null,
          no_rebate_cause: null,
          availability: 'ok',
          quoted_at: null,
        },
      };
    }
    const oldFen = BigInt(owner.old_final_price_fen);

    flight.price ??= concludePrice(owner);
    const price = await flight.price;
    switch (price.kind) {
      case 'off_shelf':
        return failure(30141, owner);
      case 'tlj_empty':
        return failure(30602, owner);
      case 'failed':
        return requoteFailed(owner, input);
      case 'fresh': {
        // BR-PRICE-20: the snapshot stands as new; conversion is still real time.
        const converted = await sharedConversion(flight, owner, input);
        const fallback =
          converted.kind === 'failed' ? conversionFallback(converted, owner, input) : null;
        if (converted.kind === 'failed' && fallback === null) return failure(converted.code, owner);
        return {
          code: 0,
          linkId: link.link_id,
          quotedPriceFen: link.quoted_final_price_fen,
          cacheHit: converted.kind === 'ok' && converted.cacheHit,
          data: {
            jump: converted.kind === 'ok' ? converted.jump : fallback!,
            price_changed: false,
            old_final_price_fen: owner.old_final_price_fen,
            new_final_price_fen: owner.old_final_price_fen,
            new_link_id: owner.new_link_id,
            requote_failed: false,
            new_rebate_min_fen: input.noRebate === true ? '0' : null,
            new_rebate_max_fen: input.noRebate === true ? '0' : null,
            no_rebate_cause: null,
            availability: 'ok',
            quoted_at: link.quoted_at === null ? null : link.quoted_at.toISOString(),
          },
        };
      }
      case 'available':
        break;
    }

    // Rebates follow the opener's quote; the renewed link follows the opened link's identity.
    const cardKey = JSON.stringify([
      openerKey(caller),
      owner.identitySnapshot,
      link.scene,
      link.sub_scene,
      link.agent_card_id,
    ]);
    let pendingCard = flight.cards.get(cardKey);
    if (pendingCard === undefined) {
      pendingCard = concludeCard(owner, price.input);
      flight.cards.set(cardKey, pendingCard);
    }
    const card = await pendingCard;
    if (card.kind === 'failed') return requoteFailed(owner, input);

    const snapshot = {
      finalFen: oldFen,
      couponFen: link.quoted_coupon_fen,
      couponIds: couponIdsOf(link.quoted_coupon_id),
    };
    const current = {
      finalFen: card.finalFen,
      couponFen: card.couponFen,
      couponIds: card.couponIds,
    };
    const minFen = await setting(link.app_id, PRICE_CHANGE_MIN_FEN, DEFAULT_PRICE_CHANGE_MIN_FEN);
    const ratioBp = Math.min(
      await setting(link.app_id, PRICE_CHANGE_RATIO_BP, DEFAULT_PRICE_CHANGE_RATIO_BP),
      10000,
    );
    const changed = priceChanged(oldFen, card.finalFen, BigInt(minFen), BigInt(ratioBp));
    const availability: Availability = couponGone(snapshot, current) ? 'coupon_gone' : 'ok';
    // BR-PRICE-08: a no_rebate purchase never writes a quote snapshot, so it never renews.
    const renewed = input.noRebate !== true && quoteSnapshotChanged(snapshot, current);

    const converted = await sharedConversion(flight, owner, input);
    const fallback =
      converted.kind === 'failed' ? conversionFallback(converted, owner, input) : null;
    if (converted.kind === 'failed' && fallback === null) return failure(converted.code, owner);
    const effective = renewed ? card.linkId : link.link_id;
    const rebates =
      input.noRebate === true
        ? { min: '0', max: '0' }
        : rebatesShown(caller, owner, card.rebateMinFen, card.rebateMaxFen);
    return {
      code: 0,
      linkId: effective,
      ...(renewed && card.pending !== null ? { card } : {}),
      quotedPriceFen: renewed ? card.finalFen : link.quoted_final_price_fen,
      cacheHit: converted.kind === 'ok' && converted.cacheHit,
      data: {
        jump: converted.kind === 'ok' ? converted.jump : fallback!,
        price_changed: changed,
        old_final_price_fen: owner.old_final_price_fen,
        new_final_price_fen: card.finalFen.toString(),
        new_link_id: renewed ? card.linkId : owner.new_link_id,
        requote_failed: false,
        new_rebate_min_fen: rebates.min,
        new_rebate_max_fen: rebates.max,
        no_rebate_cause: null,
        availability,
        quoted_at: card.quotedAt,
      },
    };
  }

  /** BR-ATTR-14 open log, and on success the attempt, in one transaction. */
  async function record(
    caller: Caller,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    settled: Settled,
    startMs: number,
  ): Promise<string | null> {
    const now = clock.now();
    const { link, identitySnapshot } = owner;
    const attemptId = settled.code === 0 ? newUuidV7(now) : null;
    const card = settled.code === 0 ? settled.card : undefined;
    const commit = () =>
      db.transaction().execute(async (trx) => {
        if (card?.pending != null) await insertPendingOpenLink(trx, card.pending);
        await trx
          .insertInto('link_logs')
          .values({
            app_id: link.app_id,
            link_id: settled.linkId,
            event: 'open',
            user_id: identitySnapshot.user_id,
            opener_user_id: caller.userId,
            platform: link.platform,
            product_key: link.product_key,
            raw_item_id: link.raw_item_id,
            scene: link.scene,
            pid_scene: identitySnapshot.pid_scene,
            pid: identitySnapshot.pid,
            client: input.client,
            cache_hit: settled.cacheHit,
            expired: startMs > link.expire_at.getTime(),
            quoted_price_fen: settled.quotedPriceFen,
            no_rebate: input.noRebate === true,
            no_rebate_reason:
              input.noRebate === true ? (input.noRebateReason ?? 'auth_declined') : null,
            agent_session_id: identitySnapshot.agent_session_id,
            result_code: settled.code,
            latency_ms: Math.max(0, now.getTime() - startMs),
            created_at: now,
          })
          .execute();
        if (attemptId !== null) {
          await trx
            .insertInto('link_open_attempts')
            .values({
              attempt_id: attemptId,
              app_id: link.app_id,
              link_id: settled.linkId,
              user_id: caller.userId,
              opened_at: now,
              created_at: now,
              updated_at: now,
            })
            .execute();
        }
      });
    if (card === undefined) {
      await commit();
    } else {
      const run = card.tail.then(commit);
      card.tail = run.then(
        () => undefined,
        () => undefined,
      );
      await run;
    }
    return attemptId;
  }

  async function handle(caller: Caller, request: LinkOpenRequoteInput): Promise<HandlerResult> {
    const start = clock.now().getTime();
    const envelope = (code: number, data: unknown = null): HandlerResult => ({
      status: STATUS[code] ?? 500,
      envelope: { code, msg: MESSAGES[code] ?? 'error', data, trace_id: request.traceId },
    });
    let owner: LinkOpenOwnerResult;
    try {
      owner = await owners.open({ linkId: request.linkId });
    } catch (error) {
      if (error instanceof LinkingError) return envelope(error.code);
      throw error;
    }
    // BR-ATTR-05 ①: the request's no_rebate is ignored on another user's share link.
    const noRebate = effectiveNoRebate(caller, owner, request.noRebate);
    const { noRebate: _requested, noRebateReason: _reason, ...rest } = request;
    void _requested;
    void _reason;
    const input: LinkOpenRequoteInput = {
      ...rest,
      noRebate,
      ...(noRebate && request.noRebateReason !== undefined
        ? { noRebateReason: request.noRebateReason }
        : {}),
    };
    const settled = await settle(caller, owner, input, start);
    const attemptId = await record(caller, owner, input, settled, start);
    if (settled.code !== 0 || settled.data === null || attemptId === null) {
      return envelope(settled.code);
    }
    return envelope(0, { attempt_id: attemptId, ...settled.data });
  }

  async function open(input: LinkOpenRequoteInput): Promise<LinkOpenRequoteOutcome> {
    // An unknown link ID is 30144 (B1-06d) and never reaches the idempotency path.
    if (typeof input.linkId !== 'string' || !UUID.test(input.linkId)) {
      return { code: 30144, data: null };
    }
    const caller = await callerContext.current();
    const response = await idempotency.execute(
      {
        appId: caller.appId,
        actor: { userId: caller.userId, deviceId: caller.deviceId, phoneHmac: null },
        method: 'POST',
        path: `/v1/links/${input.linkId}/open`,
        key: input.idempotencyKey,
        body: { installed: input.installed ?? 'unknown', no_rebate: input.noRebate === true },
        traceId: input.traceId,
      },
      () => handle(caller, input),
    );
    // Handler and replay alike: the stored body is the result, so a replay equals the first.
    const parsed = JSON.parse(response.body) as { code: number; data?: unknown };
    if (parsed.code === 0 && parsed.data !== null && parsed.data !== undefined) {
      return { code: 0, data: parsed.data as LinkOpenRequoteResult };
    }
    return { code: parsed.code, data: null };
  }

  return { open };
}
