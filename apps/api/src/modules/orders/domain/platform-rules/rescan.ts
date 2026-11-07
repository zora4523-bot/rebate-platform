// B1-04zm: the platform differences of the order rescan (规划/02 §7.1; D10-543), apart from
// PlatformRules: these are defaults of order_sync.rescan.<platform>.enabled / .days, not rules of the
// platform. Only the listed platforms ever rescan; any other code has no entry.
import type { OrderQueryOpt, RegisteredPlatform } from '../../../union/index.ts';

export interface RescanDefaults {
  readonly enabled: boolean;
  readonly days: number;
}

/**
 * B1-04zzr (FU-TB-RESCAN-TIERS, D10-798): the query_kind of a rescan stream. 'rescan' is the single
 * tier of jd / pdd and Taobao's day tier (the existing cursor row); 'rescan_hour' / 'rescan_week'
 * are Taobao's hour and week tiers, each a stream with its own cursor.
 */
export type RescanQueryKind = 'rescan' | 'rescan_hour' | 'rescan_week';

/** B1-04zzr: which order time a rescan tier filters on (OrderQueryOpt.timeBasis). */
export type RescanTimeBasis = Extract<NonNullable<OrderQueryOpt['timeBasis']>, 'pay' | 'update'>;

/** B1-04zzr: one rescan tier of a platform that rescans in tiers. */
export interface RescanTier {
  readonly queryKind: RescanQueryKind;
  /** How far back a round starts, by default (the day tier's .days key overrides it). */
  readonly depthMs: number;
  /** How long one round over the depth should take. */
  readonly periodMs: number;
  readonly timeBasis: RescanTimeBasis;
  /** On when its enabled key is unset. */
  readonly enabled: boolean;
}

/**
 * B1-04zzr: the tiers of a platform that rescans in tiers (Taobao: day, hour, week); null for a
 * single-tier platform (jd, pdd, which keep rescanDefaults) and for any other code.
 */
export function rescanTiers(platform: string): readonly RescanTier[] | null {
  void platform;
  throw new Error('NotImplemented: rescanTiers');
}

const RESCAN_DEFAULTS: Readonly<Partial<Record<RegisteredPlatform, RescanDefaults>>> =
  Object.freeze({
    jd: Object.freeze({ enabled: true, days: 30 }),
    // 02 §7.1 淘宝回扫三档先只做单档 30 天（D10-588 ③，三档见 FU-TB-RESCAN-TIERS）。
    taobao: Object.freeze({ enabled: true, days: 30 }),
    pdd: Object.freeze({ enabled: false, days: 90 }),
  });

/** The defaults of a platform that may rescan; null for any other code. */
export function rescanDefaults(platform: string): RescanDefaults | null {
  if (!Object.hasOwn(RESCAN_DEFAULTS, platform)) return null;
  return RESCAN_DEFAULTS[platform as RegisteredPlatform] ?? null;
}
