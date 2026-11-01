// B1-08za rule tests: the shared paths, the table reader and the per-platform values pinned from
// the per-platform branches of apps/api/src/modules/orders before the refactor (behaviour
// unchanged).
import { expect } from 'vitest';
import {
  PLATFORM_RULES,
  platformRules,
  type ClaimAuthRule,
  type ItemIdField,
  type PlatformRules,
} from '../../../../apps/api/src/modules/orders/domain/platform-rules/index.ts';
import {
  REGISTERED_PLATFORMS,
  type RegisteredPlatform,
  type UnionOrderAttrParams,
} from '../../../../apps/api/src/modules/union/domain/types.ts';

export { REGISTERED_PLATFORMS };
export type { RegisteredPlatform };

export const ROOT = new URL('../../../../', import.meta.url);
export const ORDERS_URL = new URL('apps/api/src/modules/orders/', ROOT);
export const RULES_URL = new URL('domain/platform-rules/', ORDERS_URL);

/** Every key of PlatformRules (the ten items of the ledger title). */
export const RULE_KEYS = [
  'attribution',
  'parseLinkCode',
  'sceneParamFallback',
  'serviceFeeDeducted',
  'taolijinPidScene',
  'orderNoStripHyphens',
  'claimAuth',
  'pushesProductKey',
  'syncWindowCapMs',
  'itemIdField',
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

/** The data-valued keys, pinned per platform; the function-valued ones are pinned by inputs. */
export interface PinnedRules {
  readonly attribution: 'attr_code' | 'relation_id';
  readonly sceneParamFallback: boolean;
  readonly serviceFeeDeducted: boolean;
  readonly taolijinPidScene: boolean;
  readonly orderNoStripHyphens: boolean;
  readonly claimAuth: ClaimAuthRule;
  readonly pushesProductKey: boolean;
  readonly syncWindowCapMs: number | null;
  readonly itemIdField: ItemIdField;
}

export const PINNED: Readonly<Record<RegisteredPlatform, PinnedRules>> = {
  jd: {
    attribution: 'attr_code',
    sceneParamFallback: false,
    serviceFeeDeducted: false,
    taolijinPidScene: false,
    orderNoStripHyphens: false,
    claimAuth: null,
    pushesProductKey: false,
    syncWindowCapMs: 60 * 60_000,
    itemIdField: 'itemId',
  },
  pdd: {
    attribution: 'attr_code',
    sceneParamFallback: true,
    serviceFeeDeducted: true,
    taolijinPidScene: false,
    orderNoStripHyphens: true,
    claimAuth: 'filing',
    pushesProductKey: true,
    syncWindowCapMs: 30 * 60_000,
    itemIdField: 'goods_sign',
  },
  taobao: {
    attribution: 'relation_id',
    sceneParamFallback: false,
    serviceFeeDeducted: false,
    taolijinPidScene: true,
    orderNoStripHyphens: false,
    claimAuth: 'relation_id',
    pushesProductKey: true,
    syncWindowCapMs: null,
    itemIdField: 'item_id',
  },
};

/**
 * The table entry of `platform`, read through both entry points: platformRules() must hand out the
 * very object PLATFORM_RULES holds.
 */
export function rulesOf(platform: RegisteredPlatform): PlatformRules {
  const rules = platformRules(platform);
  expect(rules).toBe(PLATFORM_RULES[platform]);
  return rules;
}

/** The registered platforms whose pinned value of `key` passes `test`, in name order. */
export function platformsWhere<K extends keyof PinnedRules>(
  key: K,
  test: (value: PinnedRules[K]) => boolean,
): RegisteredPlatform[] {
  return [...REGISTERED_PLATFORMS].filter((platform) => test(PINNED[platform][key])).sort();
}

/** The attr_code the table yields: the parser of an attr_code platform, null for relation_id. */
export function tableAttrCode(rules: PlatformRules, params: UnionOrderAttrParams): string | null {
  return rules.attribution.kind === 'attr_code' ? rules.attribution.parseAttrCode(params) : null;
}

export function params(patch: Partial<UnionOrderAttrParams> = {}): UnionOrderAttrParams {
  return { relation_id: null, custom_parameters: null, sub_union_id: null, ...patch };
}

/**
 * Representative order parameters: every platform's own field set in turn, valid and invalid, and
 * every field filled with another platform's valid value (no platform borrows another's field).
 */
export const PARAM_SAMPLES: readonly UnionOrderAttrParams[] = [
  params(),
  params({ sub_union_id: 'n_abcd1234' }),
  params({ sub_union_id: 'n_abcd1234_lk01' }),
  params({ sub_union_id: 'n_abcd1234_' }),
  params({ sub_union_id: 'n_abcd1234\n' }),
  params({ sub_union_id: 'n_ABCD1234' }),
  params({ sub_union_id: `n_abcd1234_${'a'.repeat(17)}` }),
  params({ custom_parameters: '{"app":"n","uid":"wxyz5678","lk":"a1b2c3","sc":"share"}' }),
  params({ custom_parameters: '{"app":"n","uid":12345678}' }),
  params({ custom_parameters: '{"app":"x","uid":"wxyz5678"}' }),
  params({ custom_parameters: '{"lk":"A1"}' }),
  params({ custom_parameters: '[]' }),
  params({ custom_parameters: '{' }),
  params({ relation_id: 'relation-1' }),
  params({
    relation_id: 'relation-1',
    sub_union_id: 'n_abcd1234_lk01',
    custom_parameters: '{"app":"n","uid":"wxyz5678","lk":"a1b2c3"}',
  }),
];
