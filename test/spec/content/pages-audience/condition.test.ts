// F1-09g §9.2–9.3. Each test includes a newly supported positive match so the existing
// deferred-facts implementation fails by assertion, including the compatibility matrix.
import { expect, it } from 'vitest';
import type { AudienceFacts } from '../../../../apps/api/src/modules/content/application/page-audience.ts';
import {
  matchesCondition,
  selectSections,
  type PageViewer,
} from '../../../../apps/api/src/modules/content/domain/pages/select/index.ts';

const KEYS = [
  ['has_parent', 'hasParent'],
  ['union_authorized', 'unionAuthorized'],
  ['has_order', 'hasOrder'],
] as const;

// Structural extension keeps the existing PageViewer callers intact during the red phase.
function viewer(
  audience?: AudienceFacts,
  loggedIn = true,
): PageViewer & {
  audience?: AudienceFacts;
} {
  return {
    loggedIn,
    platform: 'ios',
    appVersion: '2.0.0',
    ...(audience === undefined ? {} : { audience }),
  };
}

it.each(KEYS)('[AC-F1-09g#1] %s 的三态全表、缺失事实和非法条件值', (key, fact) => {
  for (const state of [true, false, null, undefined]) {
    const audience =
      state === undefined
        ? undefined
        : { hasParent: null, unionAuthorized: null, hasOrder: null, [fact]: state };
    for (const [condition, expected] of [
      ['any', true],
      ['yes', state === true],
      ['no', state === false],
      ['Yes', false],
      [true, false],
      [1, false],
      [null, false],
      ['', false],
    ] as const) {
      expect
        .soft(
          matchesCondition({ condition: { [key]: condition } }, viewer(audience)),
          `${key}=${String(condition)}, fact=${String(state)}`,
        )
        .toBe(expected);
    }
  }
});

it('[AC-F1-09g#2] 多键全部命中、login 独立、未知键拒绝且保留原顺序', () => {
  const audience = { hasParent: true, unionAuthorized: false, hasOrder: true };
  const all = {
    id: 'all',
    condition: {
      login: 'yes',
      has_parent: 'yes',
      union_authorized: 'no',
      has_order: 'yes',
    },
  };
  const order = { id: 'order', condition: { has_order: 'yes' } };
  const denied = [
    { condition: { ...all.condition, has_parent: 'no' } },
    { condition: { ...all.condition, union_authorized: 'yes' } },
    { condition: { ...all.condition, has_order: 'no' } },
    { condition: { ...all.condition, login: 'no' } },
    { condition: { ...all.condition, member: 'any' } },
    { condition: { ...all.condition, login: 'Yes' } },
    { condition: { ...all.condition, login: true } },
  ];
  expect.soft(matchesCondition(all, viewer(audience))).toBe(true);
  expect.soft(matchesCondition(all, viewer(audience, false))).toBe(false);
  for (const section of denied) {
    expect.soft(matchesCondition(section, viewer(audience))).toBe(false);
  }
  expect.soft(selectSections([order, ...denied, all], viewer(audience))).toEqual([order, all]);
  expect
    .soft(selectSections([{ ...order, min_app_version: { ios: '2.0.1' } }, all], viewer(audience)))
    .toEqual([all]);
});
