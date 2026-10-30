// B1-15u: the share page outside the app, GET /v1/share-pages/{link_id}, and its token,
// POST /v1/share-pages/{link_id}/tpwd (BR-ATTR-10 细则「中间页的口令按打开环境区分」「分享页与分享赚
// 入口页」, BR-ATTR-05 细则「App 内打开链接的入口」「别人的分享 link 不可用」; contracts getSharePage /
// getShareTpwd). Rule tests: test/spec/linking/share-page/**.
//
// GET, read-only (no link registered, no link_log, no conversion, no database write):
//   1. link_id not a uuid, unknown, of another app, or pid_scene ≠ share → 30144 (one answer, so
//      existence never leaks);
//   2. the sharer's own authorization (BR-ATTR-05 细则「别人的分享 link 不可用」): the sharer is the
//      identity snapshot's user; Taobao needs an active binding (else 30102), Pinduoduo an active
//      filing (else 30111), JD is not checked; data.reason=sharer_auth_invalid, never auth_url /
//      state / auth_jump. The site authorization is never read here, so an outage answers the same;
//   3. the share material (SharePageMaterials); none → 30144 (jump_url is required by the contract);
//   4. the shared card subset (the landing card port, an allowlist), quoted_at, jump_url,
//      open_in_app_url (share.open_in_app.enabled, default on) and tpwd_ticket — issued only when
//      the User-Agent is judged outside WeChat and the link has a token. The token itself never
//      appears in the GET response.
// POST tpwd: every request is first counted in the IP × link_id bucket of the current minute
// (share.tpwd_rate_per_min, default 5; over → 42901 with Retry-After), refused ones included; then
// WeChat / no User-Agent, an unknown or non-share link, an invalid sharer authorization, no token,
// or a ticket that is unknown, of another link or app, expired (600 s on the injected Clock) or
// used up (3 exchanges, counted atomically in Redis) → 20001 data.fields=[ticket].
// Tickets and tokens never reach a log line.
import type { components } from '@couli/contracts-ts';
import type { AppEnv, Clock, HandlerResult } from '../../platform/index.ts';
import type { LinkingConfigReader } from '../ports.ts';
import type { LandingLink, LinkLandingOptions } from './link-landing.ts';

type SharedProductCard = components['schemas']['SharedProductCard'];
type SharePageData = components['schemas']['SharePageData'];
type ShareTpwdData = components['schemas']['ShareTpwdData'];

/** BR-ATTR-10 细则「票据与限频」: a ticket is valid 600 seconds and exchanges at most 3 times. */
export const SHARE_TICKET_TTL_MS = 600_000;
export const SHARE_TICKET_MAX_USES = 3;
/** share.tpwd_rate_per_min: requests per IP × link_id and minute; default 5 (BR-ATTR-10 细则). */
export const SHARE_TPWD_RATE_KEY = 'share.tpwd_rate_per_min';
export const SHARE_TPWD_RATE_DEFAULT = 5;
/** Values outside 1..SHARE_TPWD_RATE_MAX are out of range: the default applies. */
const SHARE_TPWD_RATE_MAX = 1000;
/** The rate-limit window. */
export const SHARE_TPWD_WINDOW_MS = 60_000;
/** BR-ATTR-05 细则「App 内打开链接的入口」: the open-in-app switch, on by default. */
export const SHARE_OPEN_IN_APP_KEY = 'share.open_in_app.enabled';
/** Retry-After of a refusal because the rate-limit store could not answer. */
const STORE_RETRY_AFTER_SEC = 1;

/**
 * The link subdomain carrying the deep links (规划/02 §3.4: `l.<主域>` in prod, `l-stg.couliapp.cn`
 * in staging). Local and test environments use a reserved example host.
 */
const LINK_HOSTS: Readonly<Record<AppEnv, string>> = Object.freeze({
  prod: 'l.couliapp.com',
  staging: 'l-stg.couliapp.cn',
  test: 'l.example.test',
  local: 'l.example.test',
});

/** links.link_id is a uuid column: any other value is an unknown link, never a query. */
const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The User-Agent token of the WeChat in-app browser (also carried by WeCom). */
const WECHAT_UA = /micromessenger/i;

const MSG_NOT_FOUND = '链接不存在';
const MSG_SHARER_INVALID = '分享链接已失效，请联系分享者重新分享';
const MSG_TICKET = '填写内容有误，请检查';
const MSG_RATE = '操作太频繁，请稍后再试';

/** What the sharer's conversion of a share link left for the page outside the app. */
export interface SharePageMaterial {
  /** The sharer's converted short link (data.jump_url); never carries the token. */
  readonly jumpUrl: string;
  /** The link's token (淘口令), handed out only by the tpwd exchange; null when it has none. */
  readonly tpwd: string | null;
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Port and Nest injection token: the share material of one share link, resolved inside
 * LinkingModule (the rule tests replace this provider there). null: the link has no material.
 *
 * This class is the fallback (orchestrator ruling D10-424): a Taobao share link whose
 * links.promo_url is a web address → that address as jump_url and no token. Anything else (no
 * promo_url, JD, Pinduoduo) has no material. Nothing is converted and nothing is made up.
 * B1-15w (D10-426): LinkingModule provides infra/share-material-store.ts StoredSharePageMaterials,
 * which reads the link's app.share_materials row written by POST /v1/shares (share_url, tpwd) by
 * (app_id, link_id) and falls back to this class when the link has none.
 * TODO(规划/11 §4.5): 淘宝分享口令 — blocked on 规划/09 2_TB §2.5 口令生成权限（在此之前淘宝分享 link
 * 没有物料行，只有 promo_url 兜底）
 */
export class SharePageMaterials {
  read(link: LandingLink): Promise<SharePageMaterial | null> {
    if (link.platform !== 'taobao') return Promise.resolve(null);
    const url = link.promo_url;
    if (typeof url !== 'string' || url === '' || !isWebUrl(url)) return Promise.resolve(null);
    return Promise.resolve({ jumpUrl: url, tpwd: null });
  }
}

/** Redis-backed tickets and rate-limit buckets (infra/share-page-store.ts). */
export interface ShareTicketStore {
  /** Stores a new ticket of (app, link) valid until expiresAtMs; returns the ticket. */
  issue(appId: string, linkId: string, expiresAtMs: number): Promise<string>;
  /**
   * One exchange of the ticket of (app, link): true when it exists, has not expired at nowMs and
   * this exchange is within maxUses (counted atomically, so concurrent exchanges never exceed it).
   */
  redeem(
    appId: string,
    linkId: string,
    ticket: string,
    nowMs: number,
    maxUses: number,
  ): Promise<boolean>;
  /** Counts one request of (app, link, ip) in the window `window`; returns the count so far. */
  hit(appId: string, linkId: string, ip: string, window: number): Promise<number>;
}

/** The sharer's stored binding (union_bindings), read only. */
export interface ShareSharerBindings {
  /** True when the user has an active binding of the platform in the app. */
  active(appId: string, userId: string, platform: 'taobao' | 'pdd'): Promise<boolean>;
}

interface Warn {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface SharePageOptions {
  readonly clock: Clock;
  readonly appEnv: AppEnv;
  readonly logger: Warn;
  readonly links: LinkLandingOptions['links'];
  readonly cards: LinkLandingOptions['cards'];
  readonly bindings: ShareSharerBindings;
  readonly materials: Pick<SharePageMaterials, 'read'>;
  readonly config: Pick<LinkingConfigReader, 'configValue'>;
  readonly tickets: ShareTicketStore;
}

export interface SharePageInput {
  /** X-App-Id of the request (route schema checked); no device and no token are read. */
  readonly appId: string;
  readonly linkId: string;
  readonly traceId: string;
  /** The User-Agent header; null when absent or empty, which is judged as WeChat. */
  readonly userAgent: string | null;
}

export interface ShareTpwdInput extends SharePageInput {
  readonly ticket: string;
  /** Fastify request.ip: the rate limit is per IP × link_id (share.tpwd_rate_per_min). */
  readonly ip: string;
}

/** A tpwd answer; retryAfterSec is set on 42901 only (the controller writes Retry-After). */
export interface ShareTpwdResult extends HandlerResult {
  readonly retryAfterSec?: number;
}

/**
 * The fields of SharedProductCard (contracts/openapi.yaml), the same allowlist as the landing card:
 * a rebate or Agent field added to the card later can never reach the share page.
 */
const SHARED_CARD_FIELDS = [
  'product_key',
  'item_ref',
  'platform',
  'shop_type',
  'title',
  'image',
  'shop_name',
  'price_fen',
  'coupon_fen',
  'final_price_fen',
  'benefit_tags',
  'is_presale',
  'tlj',
  'link_id',
  'stale',
  'age_sec',
  'source',
  'disclaimer_keys',
  'ad_label',
  'availability',
] as const satisfies readonly (keyof SharedProductCard)[];

function sharedSubset(card: SharedProductCard, linkId: string): SharedProductCard {
  const source = card as unknown as Readonly<Record<string, unknown>>;
  const subset: Record<string, unknown> = {};
  for (const field of SHARED_CARD_FIELDS) {
    if (Object.hasOwn(source, field) && source[field] !== undefined) subset[field] = source[field];
  }
  subset['link_id'] = linkId;
  return subset as unknown as SharedProductCard;
}

/** BR-ATTR-10 细则: no User-Agent (or an empty one) counts as WeChat. */
export function isWeChatAgent(userAgent: string | null): boolean {
  return userAgent === null || userAgent.trim() === '' || WECHAT_UA.test(userAgent);
}

/** BR-ATTR-05 细则「App 内打开链接的入口」: https://<链接子域>/r/LinkLanding?link_id=…, link_id only. */
export function landingDeepLink(appEnv: AppEnv, linkId: string): string {
  return `https://${LINK_HOSTS[appEnv]}/r/LinkLanding?link_id=${encodeURIComponent(linkId)}`;
}

/** Seconds until the window of nowMs closes, at least 1 and at most the window. */
export function retryAfterSec(nowMs: number): number {
  const end = (Math.floor(nowMs / SHARE_TPWD_WINDOW_MS) + 1) * SHARE_TPWD_WINDOW_MS;
  return Math.min(SHARE_TPWD_WINDOW_MS / 1000, Math.max(1, Math.ceil((end - nowMs) / 1000)));
}

/** identity_snapshot.user_id: the sharer of a share link (BR-ATTR-05 ①); null when unreadable. */
function sharerOf(link: LandingLink): string | null {
  const raw = link.identity_snapshot;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const userId = (raw as Record<string, unknown>)['user_id'];
  return typeof userId === 'string' && userId !== '' ? userId : null;
}

function notFound(traceId: string): HandlerResult {
  return { status: 404, envelope: { code: 30144, msg: MSG_NOT_FOUND, trace_id: traceId } };
}

function ticketRefused(traceId: string): ShareTpwdResult {
  return {
    status: 400,
    envelope: { code: 20001, msg: MSG_TICKET, data: { fields: ['ticket'] }, trace_id: traceId },
  };
}

function rateLimited(traceId: string, seconds: number): ShareTpwdResult {
  return {
    status: 429,
    envelope: { code: 42901, msg: MSG_RATE, trace_id: traceId },
    retryAfterSec: seconds,
  };
}

/** The error class only: messages of store errors are not logged. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

const UNION_PLATFORMS: ReadonlySet<string> = new Set(['taobao', 'jd', 'pdd']);

/** A share link of the app with its material, or the refusal of the GET. */
type Resolved =
  | { readonly kind: 'ok'; readonly link: LandingLink; readonly material: SharePageMaterial }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'sharer_invalid'; readonly code: 30102 | 30111 };

export class SharePageService {
  readonly #options: SharePageOptions;

  constructor(options: SharePageOptions) {
    this.#options = options;
  }

  async get(input: SharePageInput): Promise<HandlerResult> {
    const resolved = await this.#resolve(input.appId, input.linkId);
    if (resolved.kind === 'not_found') return notFound(input.traceId);
    if (resolved.kind === 'sharer_invalid') {
      return {
        status: 422,
        envelope: {
          code: resolved.code,
          msg: MSG_SHARER_INVALID,
          data: { reason: 'sharer_auth_invalid' },
          trace_id: input.traceId,
        },
      };
    }
    const { link, material } = resolved;
    const { cards, clock, appEnv } = this.#options;
    const card = await cards.read(link);
    const openInApp = await this.#openInAppEnabled(link.app_id);
    const ticket =
      material.tpwd !== null && !isWeChatAgent(input.userAgent)
        ? await this.#issueTicket(link, clock.now().getTime())
        : null;
    const data: SharePageData = {
      product_card: sharedSubset(card, link.link_id),
      // From the link's quote snapshot, never from a refreshed card (BR-PRICE-11).
      quoted_at: link.quoted_at === null ? null : link.quoted_at.toISOString(),
      jump_url: material.jumpUrl,
      tpwd_ticket: ticket,
      open_in_app_url: openInApp ? landingDeepLink(appEnv, link.link_id) : null,
    };
    return { status: 200, envelope: { code: 0, msg: '', data, trace_id: input.traceId } };
  }

  async tpwd(input: ShareTpwdInput): Promise<ShareTpwdResult> {
    const { clock, tickets, logger } = this.#options;
    const nowMs = clock.now().getTime();
    // Every request counts, refused ones included (BR-ATTR-10 细则「票据与限频」).
    const limit = await this.#ratePerMinute(input.appId);
    let count: number;
    try {
      count = await tickets.hit(
        input.appId,
        input.linkId,
        input.ip,
        Math.floor(nowMs / SHARE_TPWD_WINDOW_MS),
      );
    } catch (error) {
      // The limit cannot be judged: refuse rather than hand out tokens unmetered.
      logger.warn(
        { event: 'linking.share_page.rate_store_unavailable', reason: reasonOf(error) },
        'linking: share page rate-limit store unavailable',
      );
      return rateLimited(input.traceId, STORE_RETRY_AFTER_SEC);
    }
    if (count > limit) return rateLimited(input.traceId, retryAfterSec(nowMs));
    if (isWeChatAgent(input.userAgent)) return ticketRefused(input.traceId);

    const resolved = await this.#resolve(input.appId, input.linkId);
    if (resolved.kind !== 'ok') return ticketRefused(input.traceId);
    const tpwd = resolved.material.tpwd;
    if (tpwd === null) return ticketRefused(input.traceId);
    let granted: boolean;
    try {
      granted = await tickets.redeem(
        input.appId,
        resolved.link.link_id,
        input.ticket,
        nowMs,
        SHARE_TICKET_MAX_USES,
      );
    } catch (error) {
      logger.warn(
        { event: 'linking.share_page.ticket_store_unavailable', reason: reasonOf(error) },
        'linking: share page ticket store unavailable',
      );
      return ticketRefused(input.traceId);
    }
    if (!granted) return ticketRefused(input.traceId);
    const data: ShareTpwdData = { tpwd };
    return { status: 200, envelope: { code: 0, msg: '', data, trace_id: input.traceId } };
  }

  /** Steps 1–3 of the header, shared by GET and the exchange (which re-checks the link). */
  async #resolve(appId: string, linkId: string): Promise<Resolved> {
    const { links, bindings, materials } = this.#options;
    if (typeof linkId !== 'string' || !LINK_ID.test(linkId)) return { kind: 'not_found' };
    const link = await links.find(appId, linkId);
    if (link === null || link.app_id !== appId || link.link_id !== linkId) {
      return { kind: 'not_found' };
    }
    if (link.pid_scene !== 'share' || !UNION_PLATFORMS.has(link.platform)) {
      return { kind: 'not_found' };
    }
    if (link.platform === 'taobao' || link.platform === 'pdd') {
      const sharer = sharerOf(link);
      // A share link without a sharer has no binding: invalid like any other.
      const valid = sharer !== null && (await bindings.active(appId, sharer, link.platform));
      if (!valid) {
        return { kind: 'sharer_invalid', code: link.platform === 'taobao' ? 30102 : 30111 };
      }
    }
    const found = await materials.read(link);
    if (found === null || typeof found.jumpUrl !== 'string' || found.jumpUrl === '') {
      return { kind: 'not_found' };
    }
    const tpwd = typeof found.tpwd === 'string' && found.tpwd !== '' ? found.tpwd : null;
    return { kind: 'ok', link, material: { jumpUrl: found.jumpUrl, tpwd } };
  }

  /** A Redis fault leaves the page without a ticket (the copy button is not shown). */
  async #issueTicket(link: LandingLink, nowMs: number): Promise<string | null> {
    try {
      return await this.#options.tickets.issue(
        link.app_id,
        link.link_id,
        nowMs + SHARE_TICKET_TTL_MS,
      );
    } catch (error) {
      this.#options.logger.warn(
        { event: 'linking.share_page.ticket_store_unavailable', reason: reasonOf(error) },
        'linking: share page ticket not issued',
      );
      return null;
    }
  }

  /** share.open_in_app.enabled: off only when set to false; unreadable keeps the default (on). */
  async #openInAppEnabled(appId: string): Promise<boolean> {
    try {
      const found = await this.#options.config.configValue(appId, SHARE_OPEN_IN_APP_KEY);
      return found?.value !== false;
    } catch {
      return true;
    }
  }

  /** share.tpwd_rate_per_min: a whole number in 1..1000, else (or unreadable) the default 5. */
  async #ratePerMinute(appId: string): Promise<number> {
    let value: unknown;
    try {
      const found = await this.#options.config.configValue(appId, SHARE_TPWD_RATE_KEY);
      value = found === null ? undefined : found.value;
    } catch {
      return SHARE_TPWD_RATE_DEFAULT;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return SHARE_TPWD_RATE_DEFAULT;
    }
    return value >= 1 && value <= SHARE_TPWD_RATE_MAX ? value : SHARE_TPWD_RATE_DEFAULT;
  }
}

export function createSharePage(options: SharePageOptions): SharePageService {
  return new SharePageService(options);
}
