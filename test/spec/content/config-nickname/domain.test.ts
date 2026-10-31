// F1-02zzq §9.3 ① ②: whatever config_items holds, the assembled Config carries nickname
// {1, 16, 3} (BR-ID-39 / 05 B1-20) and no nickname-like key is ever reported. Independent oracle
// from ./nickname-kit.ts; never derived from content's own constants. Property runs and seed come
// only from @couli/testing (PROP_RUNS / PROP_SEED); each property returns a boolean.
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  buildClientConfig,
  type ClientConfig,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';
import { getLinkPatterns } from '../../../../apps/api/src/modules/platform/index.ts';
import { NICKNAME, NICKNAME_LOOKALIKES, REQUIRED } from './nickname-kit.ts';

// platform's table, typed as the public module hands it over (content-public.module.ts).
const linkPatterns = getLinkPatterns() as NonNullable<ClientConfig['link_patterns']>;

const PLATFORMS = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const;

const OTHER_KEYS = [
  'texts',
  'display',
  'features.flags',
  'h5_release.canary',
  'invite.backfill_hours',
  'agent.enabled',
  'agent.whitelist_only',
  'claim.window_hours',
  'config.lkg_max_age_sec',
  'growth.invite_reward.enabled',
  'growth.invite_reward.amount_fen',
  'growth.invite_reward.eligibility_days',
];

const keyArb = fc.oneof(
  fc.constantFrom(...Object.keys(NICKNAME_LOOKALIKES), ...OTHER_KEYS),
  fc.string({ maxLength: 24 }),
);
// Required keys always keep their valid value, so every generated configuration assembles.
const valuesArb = fc
  .array(fc.tuple(keyArb, fc.jsonValue({ maxDepth: 2 })), { maxLength: 16 })
  .map(
    (entries) =>
      new Map<string, unknown>([
        ...entries.filter(([key]) => !Object.hasOwn(REQUIRED, key)),
        ...Object.entries(REQUIRED),
      ]),
  );

const inputArb = fc.record({
  values: valuesArb,
  appId: fc.string({ minLength: 1, maxLength: 32 }),
  userId: fc.option(fc.uuid(), { nil: null }),
  deviceId: fc.option(fc.uuid(), { nil: null }),
  rankPlatforms: fc.subarray([...PLATFORMS]),
  budget: fc.option(fc.nat({ max: 1_000_000_000 }), { nil: undefined }),
});

/** Exactly the three keys of NICKNAME, each the same JSON integer; nothing else. */
function isExactNickname(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const keys = Object.keys(actual).sort();
  const expected = Object.keys(NICKNAME).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, i) => key === expected[i]) &&
    Object.entries(NICKNAME).every(
      ([key, want]) => Number.isInteger(actual[key]) && actual[key] === want,
    )
  );
}

// The timeout grows with PROP_RUNS (10 000 locally, 100 000 in the long run).
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

it(
  '[AC-F1-02zzq#5] 任意 config_items 与调用者：nickname 恒为 {1, 16, 3} 整数，近似键从不上报',
  () => {
    expect(() =>
      fc.assert(
        fc.property(inputArb, (input) => {
          const reported: string[] = [];
          const report = {
            missing: (key: string) => void reported.push(key),
            invalid: (key: string) => void reported.push(key),
          };
          const config = buildClientConfig({
            values: input.values,
            viewer: { appId: input.appId, userId: input.userId },
            deviceId: input.deviceId,
            linkPatterns,
            rankPlatforms: input.rankPlatforms,
            ...(input.budget === undefined ? {} : { inviteRewardBudgetFen: input.budget }),
            report,
          });
          return (
            config !== undefined &&
            isExactNickname(config.nickname) &&
            reported.every((key) => !key.includes('nickname'))
          );
        }),
        propParams(),
      ),
    ).not.toThrow();
  },
  PROPERTY_TIMEOUT_MS,
);

it(
  '[AC-F1-02zzq#5] 同名键 nickname 写入合法形状的其他取值也不覆盖常量',
  () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.record({
            min_len: fc.integer({ min: 1, max: 2_147_483_647 }),
            max_len: fc.integer({ min: 1, max: 2_147_483_647 }),
            monthly_limit: fc.integer({ min: 1, max: 2_147_483_647 }),
          }),
          (poison) => {
            const config = buildClientConfig({
              values: new Map<string, unknown>([...Object.entries(REQUIRED), ['nickname', poison]]),
              viewer: { appId: 'f102zzq_domain', userId: null },
              deviceId: null,
              linkPatterns,
              rankPlatforms: [],
              report: { missing: () => undefined, invalid: () => undefined },
            });
            return config !== undefined && isExactNickname(config.nickname);
          },
        ),
        propParams(),
      ),
    ).not.toThrow();
  },
  PROPERTY_TIMEOUT_MS,
);
