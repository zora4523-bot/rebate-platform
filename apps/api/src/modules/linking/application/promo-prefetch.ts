// B1-06zd (D10-510): our Taobao promotion link. Rule tests: test/spec/linking/promo-url/**.
// - What a conversion gives: taobaoPromotionOf picks the share link (short_url, else
//   coupon_click_url) and links.promo_url (coupon_click_url, else short_url), each https and at most
//   2048 characters as the open's promoOf reads it, and the token or null. The 大淘客 requote is
//   never read (BR-PRICE-12). Used by POST /v1/shares in its transaction, which refuses a conversion
//   without the token (BR-ATTR-10), and by the job below, which writes only the promotion link.
// - The prefetch of self-buy and Agent links registered by a product detail: the registration asks
//   relationOf before its transaction (eligible, convert.taobao_prefetch.enabled on, the user's
//   active binding with a relation_id, the snapshot's slot being the active one of the binding's
//   account, BR-ATTR-07) and freezes that relation_id in identity_snapshot; after the commit
//   enqueue spends one of the App's convert.taobao_prefetch.rate_per_min for the minute (over it
//   the link is skipped, never queued) and sends one job, without holding the detail response. A
//   failed delivery is only logged.
// - The job (queue pool-refresh, worker only; quota purpose pool_refresh, so a user's share goes
//   first) reads only the link's identity_snapshot, gives up unless it agrees with the link and the
//   user's current active relation_id equals the snapshot's, and fills promo_url and
//   promo_url_fetched_at while promo_url is NULL and the link is unexpired. Nothing else is written:
//   row_version stays, so an open's CAS is never interrupted, and at-least-once delivery is settled
//   by the IS NULL. A failure of any step keeps NULL (the open answers openByCode, h5 / web 50301);
//   the queue's retryLimit is 5, so the handler itself stops after one retry (the link lives 15
//   minutes): the second failure is logged and the job ends normally.
// Logs carry flat fields only: never the relation_id, a link or a user identity.
import type { DB } from '@couli/db';
import type { PidScene } from '@couli/contracts-ts';
import type { Kysely } from 'kysely';
import type {
  Clock,
  JobHandler,
  JobQueue,
  ReceivedJob,
  RedisHandle,
} from '../../platform/index.ts';
import {
  UnionIdentity,
  type ConvertResult,
  type UnionPidService,
  type UnionRegistry,
} from '../../union/index.ts';
import { PREFETCH_RATE_KEY, PREFETCH_SWITCH_KEY, isSwitchOn } from '../domain/rules.ts';
import type { LinkingConfigReader } from '../ports.ts';

/** The job name of one prefetch. */
export type PromoPrefetchJobName = 'linking.promo_prefetch';

/**
 * The queue prefetch jobs run on. pool-refresh is reused: test/spec/platform/queue/** pins the
 * catalog queue by queue, so a new queue cannot be added without changing those frozen tests.
 */
export type PromoPrefetchQueueName = 'pool-refresh';

export const PROMO_PREFETCH_JOB: PromoPrefetchJobName = 'linking.promo_prefetch';
export const PROMO_PREFETCH_QUEUE: PromoPrefetchQueueName = 'pool-refresh';

/** The job carries only where the link is: identity is read from its row, never from the job. */
export interface PromoPrefetchPayload {
  readonly app_id: string;
  readonly link_id: string;
}

/** What decides whether a registered link gets a prefetch job. */
export interface PromoPrefetchCandidate {
  readonly platform: string;
  /** 登记来源：详情接口登记时为 detail. */
  readonly entrySource: string | null;
  /** links.user_id: null for a guest card. */
  readonly userId: string | null;
  /** The card's rebate basis (catalog's RebateQuote.rebateBasis). */
  readonly rebateBasis: string;
  /** identity_snapshot.relation_id of the registered link. */
  readonly relationId: string | null;
}

export interface PromoPrefetchHandlerOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly registry: Pick<UnionRegistry, 'get'>;
  readonly logger: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
}

/** The per-minute budget of an App, shared by the entries that register links. */
export interface PromoPrefetchLimiter {
  /** Takes one of `limit` for the App's minute; false when none is left. */
  take(appId: string, minute: number, limit: number): Promise<boolean>;
}

export interface PromoPrefetchOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: LinkingConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly queue: Pick<JobQueue, 'send'>;
  readonly limiter: PromoPrefetchLimiter;
  readonly logger: PromoPrefetchHandlerOptions['logger'];
}

/** The registration's side of the prefetch; only a registration given this one offers its links. */
export interface PromoPrefetch {
  /** The relation_id a link registered now freezes for its job; null: no job for this link. */
  relationOf(
    appId: string,
    candidate: Omit<PromoPrefetchCandidate, 'relationId'>,
    slot: { readonly pid: string | null; readonly pidScene: PidScene },
  ): Promise<string | null>;
  /** After the commit; returns at once and never rejects. */
  enqueue(appId: string, linkId: string): void;
}

/** A user's active Taobao binding, usable for a conversion. */
export interface ActiveTaobaoRelation {
  readonly relationId: string;
  readonly unionAccountId: string;
}

/** What one conversion gives a Taobao link. */
export interface TaobaoPromotion {
  readonly shareUrl: string;
  readonly promoUrl: string;
  readonly tpwd: string | null;
}

const PLATFORM = 'taobao';
const DEFAULT_RATE_PER_MIN = 60;
const MINUTE_MS = 60_000;
/** Longer than one window, so a window's key outlives it on every clock. */
const WINDOW_TTL_SEC = 120;
const LIMITER_NAMESPACE = 'linking-promo-prefetch';
const URL_MAX = 2048;
/** The first delivery and one retry. */
const MAX_ATTEMPTS = 2;
/** promoPrefetchEligible's relation while the rest is judged, before the binding is read. */
const UNREAD_RELATION = 'unread';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TAKE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return count
`;

/** Whether a registered link gets a prefetch job (the switch and the rate are read apart). */
export function promoPrefetchEligible(candidate: PromoPrefetchCandidate): boolean {
  const { platform, entrySource, userId, rebateBasis, relationId } = candidate;
  return (
    platform === PLATFORM &&
    entrySource === 'detail' &&
    userId !== null &&
    rebateBasis !== 'no_rebate' &&
    relationId !== null &&
    relationId !== ''
  );
}

/** convert.taobao_prefetch.rate_per_min as read from configuration: absent or invalid → 60. */
export function promoPrefetchRatePerMin(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : DEFAULT_RATE_PER_MIN;
}

/** Fastify's route of the product detail: favorites assemble their cards through the same code. */
export function isProductDetailRoute(request: unknown): boolean {
  const route = (request as { readonly routeOptions?: { readonly url?: unknown } } | undefined)
    ?.routeOptions;
  return route?.url === '/v1/products/:product_key';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** As the open's promoOf: an https URI of at most 2048 characters. */
function promotionUrl(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value.length > URL_MAX) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.host !== '' ? value : null;
  } catch {
    return null;
  }
}

/** Null when the conversion carries no usable promotion link: never the plain `url`. */
export function taobaoPromotionOf(result: ConvertResult): TaobaoPromotion | null {
  if (result.kind !== 'url') return null;
  const short = promotionUrl(result.short_url);
  const coupon = promotionUrl(result.coupon_click_url);
  const shareUrl = short ?? coupon;
  const promoUrl = coupon ?? short;
  if (shareUrl === null || promoUrl === null) return null;
  return { shareUrl, promoUrl, tpwd: nonBlank(result.tpwd) ? result.tpwd : null };
}

/**
 * The conversion identity of our Taobao promotion link (BR-ATTR-05/06): the snapshot's slot and
 * relation_id; the user claim is the attr_code, never a user_id.
 */
export class TaobaoPromotionIdentity extends UnionIdentity {
  constructor(input: {
    readonly appId: string;
    readonly promotionSlot: string;
    readonly relationId: string;
    readonly attrCode: string;
  }) {
    super({
      appId: input.appId,
      userId: input.attrCode,
      platform: PLATFORM,
      promotionSlot: input.promotionSlot,
      relationId: input.relationId,
    });
    Object.freeze(this);
  }
}

/** The user's active Taobao binding with a usable relation_id, or null. */
export async function activeTaobaoRelation(
  db: Kysely<DB>,
  appId: string,
  userId: string,
): Promise<ActiveTaobaoRelation | null> {
  const row = await db
    .selectFrom('union_bindings')
    .select(['relation_id', 'union_account_id'])
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', PLATFORM)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (row === undefined || !nonBlank(row.relation_id)) return null;
  return { relationId: row.relation_id, unionAccountId: row.union_account_id };
}

/** links.promo_url can be written once: only while NULL, only before the link's expire_at. */
export async function writePromoUrl(
  executor: Kysely<DB>,
  row: {
    readonly appId: string;
    readonly linkId: string;
    readonly promoUrl: string;
    readonly at: Date;
  },
): Promise<void> {
  await executor
    .updateTable('links')
    .set({ promo_url: row.promoUrl, promo_url_fetched_at: row.at })
    .where('app_id', '=', row.appId)
    .where('link_id', '=', row.linkId)
    .where('promo_url', 'is', null)
    .where('expire_at', '>', row.at)
    .execute();
}

/** One Redis counter per App and minute; without Redis no budget can be held, so none is given. */
export function createPromoPrefetchLimiter(redis: RedisHandle | undefined): PromoPrefetchLimiter {
  return {
    async take(appId, minute, limit) {
      if (redis === undefined) return false;
      const count = await redis.namespace(LIMITER_NAMESPACE).eval(TAKE_SCRIPT, {
        keys: [`${appId}:${String(minute)}`],
        args: [],
        ttlSeconds: WINDOW_TTL_SEC,
      });
      return typeof count === 'number' && count <= limit;
    },
  };
}

export function createPromoPrefetch(options: PromoPrefetchOptions): PromoPrefetch {
  const { db, clock, config, pids, queue, limiter, logger } = options;

  async function send(appId: string, linkId: string, minute: number): Promise<void> {
    const rate = await config.configValue(appId, PREFETCH_RATE_KEY);
    if (!(await limiter.take(appId, minute, promoPrefetchRatePerMin(rate?.value)))) return;
    const payload: PromoPrefetchPayload = { app_id: appId, link_id: linkId };
    // The queue is standard: a singletonKey dedups nothing there, the link's own id does.
    await queue.send(
      PROMO_PREFETCH_QUEUE,
      PROMO_PREFETCH_JOB,
      { ...payload },
      {
        trx: null,
        id: linkId,
      },
    );
  }

  return {
    async relationOf(appId, candidate, slot) {
      const { userId } = candidate;
      if (userId === null || slot.pid === null) return null;
      if (!promoPrefetchEligible({ ...candidate, relationId: UNREAD_RELATION })) return null;
      try {
        const enabled = await config.configValue(appId, PREFETCH_SWITCH_KEY);
        if (!isSwitchOn(enabled?.value)) return null;
        const relation = await activeTaobaoRelation(db, appId, userId);
        if (relation === null) return null;
        const active = await pids.getActivePid({
          appId,
          platform: PLATFORM,
          pidScene: slot.pidScene,
          purpose: 'convert',
          unionAccountId: relation.unionAccountId,
        });
        return active?.pid === slot.pid ? relation.relationId : null;
      } catch (error) {
        logger.warn(
          {
            event: 'linking.promo_prefetch.read_failed',
            app_id: appId,
            error_name: errorName(error),
          },
          'linking: promotion link prefetch not offered',
        );
        return null;
      }
    },
    enqueue(appId, linkId) {
      // Read now: the window is the registration's, however late the send runs.
      const minute = Math.floor(clock.now().getTime() / MINUTE_MS);
      void send(appId, linkId, minute).catch((error: unknown) => {
        logger.warn(
          {
            event: 'linking.promo_prefetch.enqueue_failed',
            app_id: appId,
            error_name: errorName(error),
          },
          'linking: promotion link prefetch not enqueued',
        );
      });
    },
  };
}

interface PrefetchLink {
  readonly user_id: string | null;
  readonly platform: string;
  readonly pid: string | null;
  readonly pid_scene: string | null;
  readonly raw_item_id: string | null;
  readonly identity_snapshot: unknown;
}

/** The conversion's facts when the link's snapshot agrees with the link; null otherwise. */
function snapshotIdentity(appId: string, link: PrefetchLink) {
  const snapshot = (link.identity_snapshot ?? {}) as Readonly<Record<string, unknown>>;
  const { user_id: userId, pid, relation_id: relationId, attr_code: attrCode } = snapshot;
  if (link.platform !== PLATFORM || snapshot['platform'] !== PLATFORM) return null;
  if (link.pid_scene === null || snapshot['pid_scene'] !== link.pid_scene) return null;
  if (!nonBlank(link.raw_item_id)) return null;
  if (!nonBlank(userId) || userId !== link.user_id) return null;
  if (!nonBlank(pid) || pid !== link.pid) return null;
  if (!nonBlank(relationId) || !nonBlank(attrCode)) return null;
  return {
    userId,
    relationId,
    rawItemId: link.raw_item_id,
    identity: new TaobaoPromotionIdentity({ appId, promotionSlot: pid, relationId, attrCode }),
  };
}

/** The worker's handler of one prefetch job. */
export function createPromoPrefetchHandler(options: PromoPrefetchHandlerOptions): JobHandler {
  const { db, clock, registry, logger } = options;

  function giveUp(appId: unknown, reason: string): void {
    logger.warn(
      { event: 'linking.promo_prefetch.given_up', app_id: String(appId), reason },
      'linking: promotion link prefetch given up',
    );
  }

  async function prefetch(job: ReceivedJob, appId: string, linkId: string): Promise<void> {
    const link = await db
      .selectFrom('links')
      .select([
        'user_id',
        'platform',
        'pid',
        'pid_scene',
        'raw_item_id',
        'identity_snapshot',
        'promo_url',
        'expire_at',
      ])
      .where('app_id', '=', appId)
      .where('link_id', '=', linkId)
      .executeTakeFirst();
    if (link === undefined) {
      giveUp(appId, 'no_link');
      return;
    }
    // Already filled (a share, an earlier delivery) or past W_link: nothing to do.
    if (link.promo_url !== null || !(clock.now() < link.expire_at)) return;
    const facts = snapshotIdentity(appId, link);
    if (facts === null) {
      giveUp(appId, 'snapshot_mismatch');
      return;
    }
    const relation = await activeTaobaoRelation(db, appId, facts.userId);
    if (relation?.relationId !== facts.relationId) {
      giveUp(appId, 'binding_changed');
      return;
    }

    const result = await registry.get(PLATFORM).convert(
      {
        item: { platform: PLATFORM, item_id: facts.rawItemId },
        idempotencyKey: `promo-prefetch:${linkId}`,
      },
      facts.identity,
      { appId, requestId: job.id, purpose: 'pool_refresh' },
    );
    const promotion = taobaoPromotionOf(result);
    if (promotion === null) {
      giveUp(appId, 'no_promotion_link');
      return;
    }
    await writePromoUrl(db, { appId, linkId, promoUrl: promotion.promoUrl, at: clock.now() });
  }

  return async (job) => {
    const { app_id: appId, link_id: linkId } = job.payload;
    if (!nonBlank(appId) || typeof linkId !== 'string' || !UUID.test(linkId)) {
      giveUp(appId, 'bad_payload');
      return;
    }
    try {
      await prefetch(job, appId, linkId);
    } catch (error) {
      logger.warn(
        {
          event: 'linking.promo_prefetch.failed',
          app_id: appId,
          attempt: job.attempt,
          error_name: errorName(error),
        },
        'linking: promotion link prefetch failed',
      );
      // A fresh error: the original's message never reaches the queue's job record.
      if (job.attempt < MAX_ATTEMPTS) throw new Error('linking: promotion link prefetch failed');
    }
  };
}
