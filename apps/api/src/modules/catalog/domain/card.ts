// Pure card rules (no I/O, no clock reads). Amounts are integer fen (bigint); arithmetic, when
// any, goes through @couli/money. Rules: BR-PRICE-07 (basis by entry_source), BR-PRICE-17
// (disclaimer_keys order), BR-PRICE-21 (cta by state), BR-PRICE-11 (quoted_at / age_sec).
import type { Platform } from '../../union/index.ts';

/** Rebate basis a priced card can carry before the zero-cap check (BR-PRICE-07 / 08). */
export type QuoteBasis = 'normal' | 'price_compare_risk';

/**
 * BR-PRICE-07, no pre-check permission (M-内测 default): only these sources are normal for
 * taobao — home material feed, product pool, taolijin pool, share panel and share landing page.
 * Every other value — parse, search, agent (and its refresh), a detail without a source card,
 * a watch whose origin is unknown, null or an unrecognised name — is price_compare_risk.
 */
const NORMAL_ENTRY_SOURCES: ReadonlySet<string> = new Set([
  'feed',
  'pool',
  'tlj_pool',
  'share_panel',
  'share_landing',
]);

/** MVP shows a compare range only on taobao (BR-PRICE-07); other platforms quote normal. */
export function quoteBasisFor(platform: Platform, entrySource: string | null): QuoteBasis {
  if (platform !== 'taobao') return 'normal';
  return entrySource !== null && NORMAL_ENTRY_SOURCES.has(entrySource)
    ? 'normal'
    : 'price_compare_risk';
}

export type CardBasis = QuoteBasis | 'no_rebate';

/**
 * BR-PRICE-17 / BR-PRICE-03: the price-basis key goes first — price_basis when the card shows a
 * coupon price (coupon_fen > 0), price_basis.general when it only shows the selling price; then
 * rebate_estimate (normal) or rebate_compare (range); no_rebate adds no rebate key.
 */
export function disclaimerKeysFor(basis: CardBasis, couponFen: bigint): string[] {
  const priceKey = couponFen > 0n ? 'price_basis' : 'price_basis.general';
  if (basis === 'normal') return [priceKey, 'rebate_estimate'];
  if (basis === 'price_compare_risk') return [priceKey, 'rebate_compare'];
  return [priceKey];
}

/** BR-PRICE-21 three states: 有券有返 / 无券有返 / 无返利 (button keys per BR-TEXT-12). */
export function ctaKeyFor(basis: CardBasis, couponFen: bigint): string {
  if (basis === 'no_rebate') return 'btn.buy.no_rebate';
  return couponFen > 0n ? 'btn.buy.coupon' : 'btn.buy';
}

/** Server-generated labels (contract ProductCard.benefit_tags); 有券 only when coupon_fen > 0. */
export function benefitTagsFor(couponFen: bigint): string[] {
  return couponFen > 0n ? ['有券'] : [];
}

export type UnionSource = 'taobao_union' | 'jd_union' | 'pdd_union';

/** BR-PRICE-16 price source; only the three union platforms have priced cards. */
export function unionSourceFor(platform: Platform): UnionSource {
  if (platform === 'taobao' || platform === 'jd' || platform === 'pdd') return `${platform}_union`;
  throw new TypeError('card: no union price source for this platform');
}

/** ISO 8601 instant with an explicit offset (Z or ±hh:mm); a local time without zone is refused. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

const PLUS_EIGHT = new Intl.DateTimeFormat('en', {
  timeZone: '+08:00',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Epoch milliseconds of a zoned ISO instant, or a TypeError (BR-PRICE-11 only accepts zoned). */
export function zonedInstantMs(value: string): number {
  const ms = ZONED_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new TypeError('card: quoted_at must be an ISO 8601 instant with an explicit offset');
  }
  return ms;
}

/**
 * BR-PRICE-11: quoted_at is shown in +08:00. The instant itself is never changed: the same
 * moment, re-expressed with the +08:00 offset; milliseconds appear only when non-zero.
 */
export function toPlusEight(epochMs: number): string {
  const parts = PLUS_EIGHT.formatToParts(epochMs);
  const part = (type: Intl.DateTimeFormatPartTypes, width: number): string =>
    parts.find((p) => p.type === type)!.value.padStart(width, '0');
  const millis = ((epochMs % 1000) + 1000) % 1000;
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0')}`;
  return (
    `${part('year', 4)}-${part('month', 2)}-${part('day', 2)}` +
    `T${part('hour', 2)}:${part('minute', 2)}:${part('second', 2)}${fraction}+08:00`
  );
}

/** BR-PRICE-11 age_sec: whole seconds from quoted_at to the response instant, never negative. */
export function ageSeconds(quotedAtMs: number, responseMs: number): number {
  const elapsed = responseMs - quotedAtMs;
  return elapsed <= 0 ? 0 : Math.floor(elapsed / 1000);
}
