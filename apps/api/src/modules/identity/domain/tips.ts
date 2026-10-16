// One-time tips (规划/04 §3.2 user_tip_reads, §6.1 tips endpoints; BR-ATTR-21, BR-INV-03 细则):
// jump_tip is read per purchase platform, inviter_before_buy is not per platform (stored with the
// empty platform). Pure functions: no Nest, no data access.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import { platform as PLATFORM_CODES, type Schema } from '@couli/contracts-ts';

export type TipKey = Schema<'TipKey'>;
export type PlatformCode = Schema<'PlatformCode'>;

/** The platform column of a tip that is not per platform (inviter_before_buy). */
export const NO_PLATFORM = '';

/** One read record as the read model sees it. */
export interface TipRead {
  readonly tip_key: string;
  readonly platform: string;
  readonly read_at: Date;
}

export type JumpTipBodyCheck =
  | { readonly ok: true; readonly platform: PlatformCode }
  | { readonly ok: false; readonly fields: readonly string[] };

function isPlatformCode(value: unknown): value is PlatformCode {
  return typeof value === 'string' && (PLATFORM_CODES as readonly string[]).includes(value);
}

/**
 * The body of POST /v1/me/tips/jump_tip/read against MarkTipReadRequest (required platform, a
 * PlatformCode, additionalProperties false). The route schema has no body part (the body is
 * optional for inviter_before_buy), so it is checked here; the failing fields follow the route
 * validation's naming: a missing body or a missing platform names `platform`, an unknown key names
 * that key, a body that is not an object names `body`.
 */
export function checkJumpTipBody(body: unknown): JumpTipBodyCheck {
  if (body === undefined || body === null) return { ok: false, fields: ['platform'] };
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: ['body'] };
  const fields: string[] = [];
  if (!Object.hasOwn(body, 'platform')) fields.push('platform');
  for (const key of Object.keys(body)) if (key !== 'platform') fields.push(key);
  const value = (body as { platform?: unknown }).platform;
  if (Object.hasOwn(body, 'platform') && !isPlatformCode(value)) fields.push('platform');
  if (fields.length > 0 || !isPlatformCode(value)) return { ok: false, fields };
  return { ok: true, platform: value };
}

/**
 * GET /v1/me/tips: jump_tip lists only the platforms with a read record (platform code → read_at),
 * inviter_before_buy is its read_at or null. Unknown rows (a tip_key or platform outside the
 * contract) are left out rather than answered against the contract.
 */
export function tipsData(rows: readonly TipRead[]): Schema<'TipsData'> {
  const jumpTip: Record<string, string> = {};
  let inviterBeforeBuy: string | null = null;
  for (const row of rows) {
    if (row.tip_key === 'jump_tip' && isPlatformCode(row.platform)) {
      jumpTip[row.platform] = row.read_at.toISOString();
    } else if (row.tip_key === 'inviter_before_buy' && row.platform === NO_PLATFORM) {
      inviterBeforeBuy = row.read_at.toISOString();
    }
  }
  return { jump_tip: jumpTip, inviter_before_buy: inviterBeforeBuy };
}
