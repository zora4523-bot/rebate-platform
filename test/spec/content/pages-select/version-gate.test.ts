import { expect, it } from 'vitest';
import { passesVersionGate } from '../../../../apps/api/src/modules/content/domain/pages/select/index.ts';

const viewer = { loggedIn: false, platform: 'ios', appVersion: '1.0.0' };

it.each([null, undefined, false, 1, 'section', []].map((section) => ({ section })))(
  '[AC-F1-09b#9] rejects non-object section $section before platform bypass',
  ({ section }) => {
    expect(passesVersionGate(section, viewer)).toBe(false);
    expect(passesVersionGate(section, { ...viewer, platform: 'h5' })).toBe(false);
  },
);

it.each(['ios', 'android', 'harmony'])('[AC-F1-09b#10] uses only the %s threshold', (platform) => {
  const request = { ...viewer, platform, appVersion: '2.0.0' };
  expect(
    passesVersionGate(
      {
        min_app_version: { ios: '9.0.0', android: '9.0.0', harmony: '9.0.0', [platform]: '2.0.0' },
      },
      request,
    ),
  ).toBe(true);
  expect(
    passesVersionGate(
      {
        min_app_version: { ios: '1.0.0', android: '1.0.0', harmony: '1.0.0', [platform]: '2.0.1' },
      },
      request,
    ),
  ).toBe(false);
});

it.each(['ios', 'android', 'harmony'])(
  '[AC-F1-09b#11] missing / invalid %s entry cannot fall back to another platform',
  (platform) => {
    const other = platform === 'ios' ? 'android' : 'ios';
    for (const entry of [{}, { [platform]: null }, { [platform]: 1 }, { [platform]: false }]) {
      expect(
        passesVersionGate(
          { min_app_version: { [other]: '1.0.0', ...entry } },
          { ...viewer, platform, appVersion: '9.0.0' },
        ),
      ).toBe(false);
    }
  },
);

it.each(['h5', 'admin', 'unknown', 'IOS', ''])(
  '[AC-F1-09b#12] platform %j bypasses version filtering even with malformed thresholds',
  (platform) => {
    for (const minimum of [{ ios: '99.0.0' }, { ios: '1.0' }, {}, 'bad']) {
      expect(
        passesVersionGate(
          { min_app_version: minimum },
          { ...viewer, platform, appVersion: undefined },
        ),
      ).toBe(true);
    }
  },
);

it.each([
  ['1.9.0', '1.10.0', true],
  ['1.10.0', '1.9.0', false],
  ['1.0.9', '1.0.10', true],
  ['1.0.10', '1.0.9', false],
  ['9.9.9', '10.0.0', true],
  ['10.0.0', '9.99.99', false],
  ['1.0.0', '1.0.0', true],
  ['0.0.0', '0.0.0', true],
  ['2.0.0', '1.99.99', false],
  ['1.2.0', '1.1.99', false],
] as const)(
  '[AC-F1-09b#13] minimum %s vs client %s uses numeric not-lower-than ordering (%s)',
  (minimum, appVersion, expected) => {
    expect(
      passesVersionGate({ min_app_version: { ios: minimum } }, { ...viewer, appVersion }),
    ).toBe(expected);
  },
);

it.each([undefined, '', '1.0', 'v1.0.0', '01.0.0', '1.0.0-beta', '1.0.0+build', ' 1.0.0'])(
  '[AC-F1-09b#14] malformed or missing client version %j fails only sections with a gate',
  (appVersion) => {
    const request = { ...viewer, appVersion };
    expect(passesVersionGate({ min_app_version: { ios: '1.0.0' } }, request)).toBe(false);
    expect(passesVersionGate({}, request)).toBe(true);
    expect(passesVersionGate({ min_app_version: null }, request)).toBe(true);
  },
);

it.each(['1.0', '', 'v1.0.0', '01.0.0', '1.0.0-beta', '1.0.0+build', ' 1.0.0'])(
  '[AC-F1-09b#15] malformed minimum %j returns false without throwing',
  (minimum) => {
    expect(passesVersionGate({ min_app_version: { ios: minimum } }, viewer)).toBe(false);
  },
);

it.each([{}, [], '1.0.0', 1, false].map((minimum) => ({ minimum })))(
  '[AC-F1-09b#16] threshold container without a string entry $minimum fails closed',
  ({ minimum }) => {
    expect(passesVersionGate({ min_app_version: minimum }, viewer)).toBe(false);
  },
);
