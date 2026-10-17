import { expect, it } from 'vitest';
import { matchesCondition } from '../../../../apps/api/src/modules/content/domain/pages/select/index.ts';

const viewer = { loggedIn: false, platform: 'ios', appVersion: undefined };

it.each([
  ['any', false, true],
  ['any', true, true],
  ['yes', false, false],
  ['yes', true, true],
  ['no', false, true],
  ['no', true, false],
] as const)('[AC-F1-09b#17] login=%s with loggedIn=%s yields %s', (login, loggedIn, expected) => {
  expect(matchesCondition({ condition: { login } }, { ...viewer, loggedIn })).toBe(expected);
});

it.each([{}, { condition: null }, { condition: {} }])(
  '[AC-F1-09b#18] absent / null / empty condition %j matches both audiences',
  (section) => {
    expect(matchesCondition(section, viewer)).toBe(true);
    expect(matchesCondition(section, { ...viewer, loggedIn: true })).toBe(true);
  },
);

// R5 deliberately defers fact lookup to F1-09g: neither login state proves these facts.
it.each(['has_parent', 'union_authorized', 'has_order'])(
  '[AC-F1-09b#19] deferred fact %s accepts only any, regardless of login',
  (key) => {
    for (const loggedIn of [false, true]) {
      const request = { ...viewer, loggedIn };
      expect(matchesCondition({ condition: { [key]: 'any' } }, request)).toBe(true);
      for (const value of ['yes', 'no', 'unknown', '', true, false, null, 0, {}, []]) {
        expect(matchesCondition({ condition: { [key]: value } }, request)).toBe(false);
      }
    }
  },
);

it.each(['unknown', 'YES', '', true, false, null, 0, {}, []].map((login) => ({ login })))(
  '[AC-F1-09b#20] unknown login value $login fails closed',
  ({ login }) => {
    expect(matchesCondition({ condition: { login } }, viewer)).toBe(false);
    expect(matchesCondition({ condition: { login } }, { ...viewer, loggedIn: true })).toBe(false);
  },
);

it.each(['new_user', 'active', 'user_id', 'unknown'])(
  '[AC-F1-09b#21] unknown key %s fails even when set to any',
  (key) => {
    expect(matchesCondition({ condition: { login: 'any', [key]: 'any' } }, viewer)).toBe(false);
  },
);

it.each([[], ['any'], 'any', false, 1].map((condition) => ({ condition })))(
  '[AC-F1-09b#22] condition must be an object, not $condition',
  ({ condition }) => {
    expect(matchesCondition({ condition }, viewer)).toBe(false);
  },
);

it('[AC-F1-09b#23] every key must match, independent of key order', () => {
  const allAny = { has_parent: 'any', union_authorized: 'any', has_order: 'any' };
  expect(matchesCondition({ condition: { login: 'no', ...allAny } }, viewer)).toBe(true);
  expect(matchesCondition({ condition: { ...allAny, login: 'yes' } }, viewer)).toBe(false);
  expect(
    matchesCondition({ condition: { login: 'any', ...allAny, has_order: 'no' } }, viewer),
  ).toBe(false);
  expect(matchesCondition({ condition: { has_order: 'no', login: 'any' } }, viewer)).toBe(false);
  expect(matchesCondition({ condition: { unknown: 'any', login: 'any' } }, viewer)).toBe(false);
});
