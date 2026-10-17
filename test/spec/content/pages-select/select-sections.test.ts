import { expect, it } from 'vitest';
import { selectSections } from '../../../../apps/api/src/modules/content/domain/pages/select/index.ts';

const viewer = Object.freeze({ loggedIn: false, platform: 'ios', appVersion: '1.0.0' });

it('[AC-F1-09b#24] combines both gates while preserving order, duplicates and original content', () => {
  const first = Object.freeze({
    id: 'first',
    type: 'future_client_type',
    condition: Object.freeze({ login: 'no' }),
    min_app_version: Object.freeze({ ios: '1.0.0' }),
    payload: Object.freeze({ title: 'preserve', extra: Object.freeze([1, 2]) }),
  });
  const second = Object.freeze({ id: 'second', condition: Object.freeze({ has_parent: 'any' }) });
  const sections = Object.freeze([
    Object.freeze({ id: 'login_rejected', condition: Object.freeze({ login: 'yes' }) }),
    first,
    Object.freeze({ id: 'version_rejected', min_app_version: Object.freeze({ ios: '1.0.1' }) }),
    Object.freeze({
      id: 'both_rejected',
      condition: Object.freeze({ login: 'yes' }),
      min_app_version: Object.freeze({ ios: '2.0.0' }),
    }),
    second,
    null,
    [],
    'invalid',
    first,
  ]);
  const snapshot: unknown = structuredClone(sections);
  const result = selectSections(sections, viewer);
  expect(result).toEqual([first, second, first]);
  expect(sections).toEqual(snapshot);
  expect(viewer).toEqual({ loggedIn: false, platform: 'ios', appVersion: '1.0.0' });
});

it('[AC-F1-09b#25] empty input and fully rejected input yield an empty array', () => {
  expect(selectSections([], viewer)).toEqual([]);
  expect(
    selectSections(
      [null, { condition: { has_parent: 'yes' } }, { min_app_version: { android: '1.0.0' } }],
      viewer,
    ),
  ).toEqual([]);
});

it('[AC-F1-09b#26] selection uses the caller platform and login state independently', () => {
  const guest = { id: 'guest', condition: { login: 'no' } };
  const member = { id: 'member', condition: { login: 'yes' } };
  const ios = { id: 'ios', min_app_version: { ios: '1.0.0' } };
  const android = { id: 'android', min_app_version: { android: '2.0.0' } };
  const sections = [guest, member, ios, android];
  expect(selectSections(sections, viewer)).toEqual([guest, ios]);
  expect(
    selectSections(sections, { loggedIn: true, platform: 'android', appVersion: '2.0.0' }),
  ).toEqual([member, android]);
  expect(
    selectSections(sections, { loggedIn: true, platform: 'h5', appVersion: undefined }),
  ).toEqual([member, ios, android]);
});
