// B2-03c: the real rebate quoter (catalog's CardRebateQuoter). BR-CALC-20: N from union's
// quoteN, the viewer's own share from @couli/domain quoteRebate (the same splitCommission as
// booking), with the rule version in force at the quote instant (BR-CALC-11) and the viewer's
// level × the caller's order type (BR-CALC-06). The taobao compare range (BR-PRICE-07) redoes the
// whole formula at ⌊rate × compare_rate_ratio_bp⌋; max = 0 is no_rebate without a net price
// (BR-PRICE-08), otherwise est_net_price_fen = final − min (BR-PRICE-09).
//
// Live only (B2-03n removed prepare() and the scoped mode): every quote reads rules, the level
// and configuration in the viewer's app scope; the quoter keeps no state, so concurrent quotes for
// different apps or viewers never answer for each other. The quote instant is taken once, in the
// synchronous part of quote() before any port is read, and the version is selected at that
// instant: the list read afterwards always contains the version in force then, while a version
// that becomes effective (or is revoked) during the reads is never picked from a list that may
// already be stale. An open's pre-reads happen in the wrapped ports app.module.ts passes in, not
// here. Every failure rejects the quote; nothing ever quotes as 0.
//
// Also compiled by the `test` project: erasable syntax only, relative imports with `.ts`.
import type { UserLevel } from '@couli/contracts-ts';
import { quoteRebate } from '@couli/domain';
import { mulDivFloor, subFen } from '@couli/money';
import type { CatalogConfigReader, RebateQuote, Viewer } from '../../catalog/index.ts';
import type { UserLevelReader } from '../../identity/index.ts';
import type { Clock } from '../../platform/index.ts';
import { isRegisteredPlatform, quoteN, type UnionItem } from '../../union/index.ts';
import {
  selectQuoteTerms,
  selectRuleVersion,
  type RuleSetReader,
  type RuleVersion,
} from '../domain/rules.ts';
import { bpConfig, platformsConfig, techFeeConfig } from './quote-config.ts';
import type {
  COMMISSION_QUOTE_CONFIG_KEYS,
  CommissionQuoteContext,
  CommissionRebateQuoter,
} from './types.ts';

export interface CommissionRebateQuoterOptions {
  readonly rules: RuleSetReader;
  readonly levels: UserLevelReader;
  readonly config: CatalogConfigReader;
  readonly clock: Clock;
}

type ConfigKey = COMMISSION_QUOTE_CONFIG_KEYS[number];

const PLATFORMS_KEY: ConfigKey = 'commission.platforms';
const TECH_FEE_KEY: ConfigKey = 'tech_fee_bp';
const COMPARE_RATIO_KEY: ConfigKey = 'rebate.taobao.compare_rate_ratio_bp';
const PDD_SELF_KEY: ConfigKey = 'union.pdd.self_buy_factor_bp';
const PDD_ACCOUNT_KEY: ConfigKey = 'union.pdd.account_level_factor_bp';

const BP = 10000n;
/** BR-CALC-20: a guest (not logged in) quotes at the registration default level. */
const GUEST_LEVEL: UserLevel = 'L1';
const LEVELS: ReadonlySet<unknown> = new Set(['L1', 'L2', 'L3']);

/** Values one quote computes from; config holds only entries that were present. */
interface QuoteInputs {
  /** The instant the rule version is selected at (BR-CALC-11). */
  readonly at: Date;
  readonly versions: readonly RuleVersion[];
  readonly level: UserLevel;
  readonly config: ReadonlyMap<string, unknown>;
}

interface ResolvedContext {
  readonly buyType: 'self' | 'share';
  readonly basis: 'normal' | 'price_compare_risk';
}

/** Without a context: guest-style self purchase with no entry source (taobao → compare risk). */
function resolveContext(item: UnionItem, context?: CommissionQuoteContext): ResolvedContext {
  const buyType: unknown = context === undefined ? 'self' : context.buyType;
  if (buyType !== 'self' && buyType !== 'share') {
    throw new TypeError(`commission quote: unknown order type ${String(buyType)}`);
  }
  const basis: unknown =
    context === undefined
      ? item.platform === 'taobao'
        ? 'price_compare_risk'
        : 'normal'
      : context.rebateBasis;
  if (basis !== 'normal' && basis !== 'price_compare_risk') {
    throw new TypeError(`commission quote: unknown rebate basis ${String(basis)}`);
  }
  if (basis === 'price_compare_risk' && item.platform !== 'taobao') {
    throw new TypeError('commission quote: compare range exists only on taobao (BR-PRICE-07)');
  }
  return { buyType, basis };
}

function checkLevel(level: unknown): UserLevel {
  if (!LEVELS.has(level)) {
    throw new Error('commission quote: viewer level unavailable; not quoting as a guest');
  }
  return level as UserLevel;
}

function checkAppId(appId: unknown): string {
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new TypeError('commission quote: viewer app scope missing');
  }
  return appId;
}

/** The keys one quote needs; others (e.g. PDD factors on a taobao quote) are not required. */
function neededKeys(item: UnionItem, ctx: ResolvedContext): ConfigKey[] {
  const keys: ConfigKey[] = [PLATFORMS_KEY, TECH_FEE_KEY];
  if (ctx.basis === 'price_compare_risk') keys.push(COMPARE_RATIO_KEY);
  if (item.platform === 'pdd') keys.push(PDD_SELF_KEY, PDD_ACCOUNT_KEY);
  return keys;
}

function required(config: ReadonlyMap<string, unknown>, key: ConfigKey): unknown {
  if (!config.has(key)) throw new Error(`commission quote: config missing (${key})`);
  return config.get(key);
}

export function createCommissionRebateQuoter(
  options: CommissionRebateQuoterOptions,
): CommissionRebateQuoter {
  const { rules, levels, config, clock } = options;

  async function readConfig(
    appId: string,
    keys: readonly ConfigKey[],
  ): Promise<Map<string, unknown>> {
    const entries = await Promise.all(keys.map((key) => config.configValue(appId, key)));
    const values = new Map<string, unknown>();
    keys.forEach((key, i) => {
      const entry = entries[i];
      if (entry !== null && entry !== undefined) values.set(key, entry.value);
    });
    return values;
  }

  async function readLevel(appId: string, userId: string | null): Promise<UserLevel> {
    if (userId === null) return GUEST_LEVEL;
    return checkLevel(await levels.levelOf({ appId, userId }));
  }

  function compute(item: UnionItem, ctx: ResolvedContext, inputs: QuoteInputs): RebateQuote {
    if (item.price_status === 'anomaly') {
      throw new Error('commission quote: item price is anomalous; not quoting');
    }
    const platforms = platformsConfig(required(inputs.config, PLATFORMS_KEY), PLATFORMS_KEY);
    if (!platforms.includes(item.platform)) {
      throw new Error(`commission quote: platform ${item.platform} is not in commission.platforms`);
    }
    const techFeeBp = techFeeConfig(
      required(inputs.config, TECH_FEE_KEY),
      TECH_FEE_KEY,
      item.platform,
    );
    const pdd =
      item.platform === 'pdd'
        ? {
            selfBuyFactorBp: bpConfig(required(inputs.config, PDD_SELF_KEY), PDD_SELF_KEY),
            accountLevelFactorBp: bpConfig(
              required(inputs.config, PDD_ACCOUNT_KEY),
              PDD_ACCOUNT_KEY,
            ),
          }
        : undefined;
    const compareRatioBp =
      ctx.basis === 'price_compare_risk'
        ? bpConfig(required(inputs.config, COMPARE_RATIO_KEY), COMPARE_RATIO_KEY)
        : undefined;

    const version = selectRuleVersion(inputs.versions, inputs.at);
    const terms = selectQuoteTerms({
      version,
      platforms,
      platform: item.platform,
      level: inputs.level,
      orderType: ctx.buyType,
    });

    const platform = item.platform;
    if (!isRegisteredPlatform(platform)) {
      throw new TypeError(`commission quote: no union quote for platform ${platform}`);
    }
    const ownShare = (commissionRateBp: bigint): bigint =>
      quoteRebate({
        n_quote_fen: quoteN({
          platform,
          finalPriceFen: item.final_price_fen,
          commissionRateBp,
          orderType: ctx.buyType,
          techFeeBp,
          ...(pdd === undefined ? {} : { pdd }),
        }),
        reserve_bp: terms.reserve_bp,
        r_own_bp: terms.r_own_bp,
      });

    const max = ownShare(item.commission_rate_bp);
    const min =
      compareRatioBp === undefined
        ? max
        : ownShare(mulDivFloor(item.commission_rate_bp, compareRatioBp, BP));
    if (max === 0n) {
      return { rebateMinFen: 0n, rebateMaxFen: 0n, estNetPriceFen: null, rebateBasis: 'no_rebate' };
    }
    return {
      rebateMinFen: min,
      rebateMaxFen: max,
      estNetPriceFen: subFen(item.final_price_fen, min, { nonNegative: true }),
      rebateBasis: ctx.basis,
    };
  }

  async function liveInputs(
    item: UnionItem,
    ctx: ResolvedContext,
    viewer: Viewer,
  ): Promise<QuoteInputs> {
    const appId = checkAppId(viewer.appId);
    // Read the clock before any port, never during or after the reads (see the header).
    const at = clock.now();
    const [versions, level, values] = await Promise.all([
      rules.publishedVersions(appId),
      readLevel(appId, viewer.userId),
      readConfig(appId, neededKeys(item, ctx)),
    ]);
    return { at, versions, level, config: values };
  }

  async function quote(
    item: UnionItem,
    viewer: Viewer,
    context?: CommissionQuoteContext,
  ): Promise<RebateQuote> {
    const ctx = resolveContext(item, context);
    return compute(item, ctx, await liveInputs(item, ctx, viewer));
  }

  return { quote };
}
