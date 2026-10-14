// B1-06i: POST /v1/links/convert — only for entries without a link_id (H5 trade.convertAndOpen,
// scene h5; 拍板第二批 TRADE-03). In one request it registers the caller's own H5 link (scene h5 →
// pid_scene self_buy, BR-ATTR-08; identity only from CallerContext, BR-ATTR-05) and then opens it
// through the open's own core and conversion port (link-open-requote.ts, link-open-taobao.ts):
// the same authorization (Taobao B1-06f, Pinduoduo filing B1-06v / B1-06z), re-check, conversion,
// Baichuan instruction and jump cache — no second judgement. The open's idempotency, transaction
// and pre-reads (B1-06m) apply as they are; the log is event=convert (BR-ATTR-14, failures too),
// the attempt is written only on success in the same transaction.
// What to register is resolved before the transaction (no database work on the open's connection):
// - product_key (BR-PROD-11 / BR-PROD-05): the tapped card's item_ref is verified by catalog; a
//   missing, unauthenticated, undecryptable or foreign-app token is ignored, a same-app token of
//   another product is 20001 before anything is registered. catalog's raw-ID order (item_ref ≤
//   1800 s, product_refs ≤ 1800 s, re-resolution) gives the raw ID, then one union detail
//   through the governed adapter gives the quote snapshot.
// - url (BR-PROD-03): the by-URL port (parsing's parseUrl, wired in app.module.ts; parsing never
//   imports linking) resolves and derives the product; an unsupported platform or a recognized
//   link without a derivable key is 30131 and nothing is registered. A Taobao url ends as the
//   Baichuan instruction for the resolved item_id; the pasted link is never passed on (BR-PRICE-21).
// item_ref is never logged and never used for attribution (BR-PROD-11).
import type { components } from '@couli/contracts-ts';
import { ProductKeyInvalid, ProductKeyPlatformUnsupported, splitProductKey } from '@couli/domain';
import type { Catalog, CardRebateQuoter, ItemRefService, ProductRef } from '../../catalog/index.ts';
import { GovernanceError, newUuidV7, type HandlerResult } from '../../platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  isPriceAnomaly,
  isRegisteredPlatform,
  type CallCtx,
  type ItemRef,
  type UnionItemDetail,
} from '../../union/index.ts';
import type { Caller } from '../ports.ts';
import { itemRefOf } from './link-open-conversion.ts';
import { openHttpResult, type LinkOpenInput } from './link-open.ts';
import {
  createLinkOpenRequote,
  type LinkConvertResolution,
  type LinkOpenConvertingService,
} from './link-open-requote.ts';
import { composeTaobaoConversion, type TaobaoLinkOpenOptions } from './link-open-taobao.ts';
import { createWiredConversion } from './link-open-wiring.ts';

/** Implemented structurally by parsing.parseUrl, assembled in AppModule. */
export interface LinkConvertUrlParser {
  parseUrl(
    url: string,
    context: CallCtx,
  ): Promise<{
    readonly item: UnionItemDetail;
    readonly ref: ProductRef;
  }>;
}

export interface LinkConvertInput {
  readonly body: components['schemas']['ConvertLinkRequest'];
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly client: LinkOpenInput['client'];
}

export interface LinkConvertOptions extends TaobaoLinkOpenOptions {
  readonly products: Catalog;
  readonly itemRefs: ItemRefService;
  readonly quoter: CardRebateQuoter;
  readonly urlParser: LinkConvertUrlParser;
}

/** HTTP injection token. The controller takes identity from CallerContext, never body fields. */
export class LinkConvertService {
  convert(input: LinkConvertInput): Promise<HandlerResult> {
    void input;
    return Promise.reject(new Error('linking: convert service is not composed in this process'));
  }
}

type Body = components['schemas']['ConvertLinkRequest'];

/** BR-PROD-10: a convert needs the platform to resolve products, as parsing and detail do. */
const CAPABILITIES = Object.freeze({ parseEnabled: true, searchEnabled: false });
/** BR-PRICE-07 来源判定表: no source card (direct detail) → detail; a pasted link → parse. */
const PRODUCT_ENTRY_SOURCE = 'detail';
const URL_ENTRY_SOURCE = 'parse';

/** The by-URL port's refusal codes (parsing's split, contracts/error-codes.yaml). */
const PARSE_CODES: ReadonlySet<number> = new Set([30131, 30132, 30141, 50301]);

function refused(
  code: number,
  productKey: string | null,
  fields?: readonly string[],
): LinkConvertResolution {
  return {
    kind: 'refused',
    code,
    productKey,
    ...(fields === undefined ? {} : { data: { fields: [...fields] } }),
  };
}

/**
 * A governed upstream call (catalog / parsing / union) that timed out, ran out of quota or met an
 * open breaker: the dependency is unavailable, so no price can be confirmed (50303, BR-PRICE-13).
 * invalid_policy is a configuration fault and stays one.
 */
function isGovernedDependencyDown(error: unknown): boolean {
  return (
    error instanceof GovernanceError &&
    (error.code === 'timeout' || error.code === 'quota_exceeded' || error.code === 'circuit_open')
  );
}

/**
 * A union detail failure → convert code: off shelf 30141 (BR-PRICE-14); the union refusing the
 * raw ID itself 30143 (BR-PROD-05 引用失效); a dependency failure — union or governance timeout,
 * quota, breaker — 50303 (no price can be confirmed, BR-PRICE-13). Anything else is a fault.
 */
export function detailFailure(error: unknown, productKey: string): LinkConvertResolution {
  if (isGovernedDependencyDown(error)) return refused(50303, productKey);
  if (
    (error instanceof UnionError && error.code === 'item_unavailable') ||
    (error instanceof DemoUnionError && error.code === 'demo_delisted')
  ) {
    return refused(30141, productKey);
  }
  if (
    error instanceof UnionError &&
    (error.code === 'upstream_rejected' ||
      error.code === 'invalid_dto' ||
      error.code === 'link_unrecognized')
  ) {
    return refused(30143, productKey);
  }
  if (error instanceof UnionError || error instanceof DemoUnionError) {
    return refused(50303, productKey);
  }
  const code = (error as { code?: unknown } | null)?.code;
  // catalog's raw-ID order (CatalogError) and governance refusals with a contract code.
  if (code === 30141 || code === 30143) return refused(code, productKey);
  if (code === 50401) return refused(50303, productKey);
  return { kind: 'fault', error };
}

/**
 * A by-URL parse failure → convert code. BR-PROD-03: unsupported, or recognized without a
 * concrete derivable product → 30131; delisted 30141. parsing's 50301 is only ever a union
 * dependency failure (upstream down, throttled, governor timeout / quota / breaker), so for the
 * convert it is the same 50303 as the by-product path; a governance error that escapes the port
 * unmapped is too. Anything else is a fault.
 */
export function parseFailure(error: unknown): LinkConvertResolution {
  if (isGovernedDependencyDown(error)) return refused(50303, null);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number' && PARSE_CODES.has(code)) {
    if (code === 30132) return refused(30131, null);
    if (code === 50301) return refused(50303, null);
    return refused(code, null);
  }
  return { kind: 'fault', error };
}

class ComposedLinkConvert extends LinkConvertService {
  readonly #options: LinkConvertOptions;
  readonly #core: LinkOpenConvertingService;

  constructor(options: LinkConvertOptions, core: LinkOpenConvertingService) {
    super();
    this.#options = options;
    this.#core = core;
  }

  override async convert(input: LinkConvertInput): Promise<HandlerResult> {
    const body: Body = input.body;
    const outcome = await this.#core.convert({
      platform: body.platform,
      idempotencyKey: input.idempotencyKey,
      traceId: input.traceId,
      client: input.client,
      installed: body.installed ?? 'unknown',
      ...(body.spm === undefined ? {} : { spm: body.spm }),
      // The whole contract body, installed defaulted: the same key with any other body is 20901.
      body: { ...body, installed: body.installed ?? 'unknown' },
      resolve: (caller) => this.#resolve(caller, body),
    });
    // A replay answers the stored response as it was, the first request's trace_id included.
    return openHttpResult(outcome, outcome.traceId ?? input.traceId);
  }

  async #resolve(caller: Caller, body: Body): Promise<LinkConvertResolution> {
    const context: CallCtx = {
      appId: caller.appId,
      requestId: newUuidV7(this.#options.clock.now()),
      purpose: 'online',
    };
    if (typeof body.url === 'string' && body.product_key === undefined) {
      return this.#byUrl(body, body.url, context);
    }
    if (typeof body.product_key === 'string' && body.url === undefined) {
      return this.#byProduct(caller, body, body.product_key, context);
    }
    // The route schema already refuses both or neither; a direct caller gets the same answer.
    return refused(20001, null, ['product_key', 'url']);
  }

  async #byProduct(
    caller: Caller,
    body: Body,
    productKey: string,
    context: CallCtx,
  ): Promise<LinkConvertResolution> {
    const { products, itemRefs, registry } = this.#options;
    const appId = caller.appId;
    let platform: string;
    try {
      const rows = await products.listPlatforms();
      platform = splitProductKey(
        productKey,
        rows.map((row) => ({
          platform: row.code,
          keyPrefix: row.key_prefix,
          parseEnabled: true,
          searchEnabled: true,
        })),
        body.platform,
      ).platform;
    } catch (error) {
      if (error instanceof ProductKeyInvalid) return refused(20001, productKey, ['product_key']);
      if (error instanceof ProductKeyPlatformUnsupported) return refused(30131, productKey);
      return { kind: 'fault', error };
    }
    // BR-PROD-03: only platforms with a union adapter have product keys to convert.
    if (!isRegisteredPlatform(platform)) return refused(30131, productKey);

    // BR-PROD-11: unusable tokens are ignored (null); a same-app token of another product is 20001.
    let token;
    try {
      token = itemRefs.verify({ itemRef: body.item_ref ?? null, appId, productKey });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 20001) {
        return refused(20001, productKey, ['item_ref']);
      }
      return { kind: 'fault', error };
    }

    let rawItemId: string;
    let canonical: string;
    try {
      const taken = await products.takeRawItemId({
        appId,
        platform,
        productKey,
        requestRef: token,
        fallbackEnabled: false,
        capabilities: CAPABILITIES,
        // TODO(规划/11 §4.5): 按 product_key 重新解析原串（BR-PROD-05 第③步）— blocked on
        // 联盟按键反查接口（CAP-TB / CAP-JD / CAP-PDD 实测）；在此之前按「引用失效」30143 处理。
        reparse: () => Promise.resolve({ kind: 'ref_expired' }),
      });
      rawItemId = taken.rawItemId;
      canonical = await products.resolveProductKey(productKey);
    } catch (error) {
      return detailFailure(error, productKey);
    }

    const ref: ItemRef =
      platform === 'taobao' ? { platform, item_id: rawItemId } : itemRefOf(platform, rawItemId);
    let item: UnionItemDetail;
    try {
      item = await registry.get(platform).getItem(ref, context);
    } catch (error) {
      return detailFailure(error, productKey);
    }
    if (item.platform !== platform) return refused(30143, productKey);
    // D33: a price anomaly never gets a link.
    if (isPriceAnomaly(item)) return refused(50303, productKey);
    return {
      kind: 'target',
      target: {
        platform,
        productKey: canonical,
        rawItemId,
        rawFetchedAt: item.quoted_at,
        item,
        shopId: null,
        entrySource: PRODUCT_ENTRY_SOURCE,
      },
    };
  }

  async #byUrl(body: Body, url: string, context: CallCtx): Promise<LinkConvertResolution> {
    let parsed: Awaited<ReturnType<LinkConvertUrlParser['parseUrl']>>;
    try {
      parsed = await this.#options.urlParser.parseUrl(url, context);
    } catch (error) {
      return parseFailure(error);
    }
    const { item, ref } = parsed;
    if (ref.platform !== body.platform || item.platform !== ref.platform) {
      return refused(20001, ref.productKey, ['platform']);
    }
    if (!isRegisteredPlatform(ref.platform)) return refused(30131, ref.productKey);
    if (isPriceAnomaly(item)) return refused(50303, ref.productKey);
    return {
      kind: 'target',
      target: {
        platform: ref.platform,
        productKey: ref.productKey,
        rawItemId: ref.rawItemId,
        rawFetchedAt: ref.rawFetchedAt,
        item,
        shopId: ref.shopId,
        entrySource: URL_ENTRY_SOURCE,
      },
    };
  }
}

export function createLinkConvert(options: LinkConvertOptions): LinkConvertService {
  // The open's own composition (createWiredLinkOpen): wired jd / pdd conversion with admission,
  // the Taobao port with its authorization and the Pinduoduo filing check.
  const wired = createWiredConversion(options);
  const conversion = composeTaobaoConversion(options, wired);
  const core = createLinkOpenRequote({ ...options, cache: wired.cache, conversion });
  return new ComposedLinkConvert(options, core);
}
