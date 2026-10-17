import { describe, expect, it } from 'vitest';
import { h5Bucket } from '../../client-config.ts';
import {
  matchesCondition,
  passesVersionGate,
  pickPageVersion,
  selectSections,
  type PageViewer,
} from './index.ts';

const ios: PageViewer = { loggedIn: false, platform: 'ios', appVersion: '1.2.3' };

function deviceIn(appId: string, predicate: (bucket: number) => boolean): string {
  for (let index = 0; index < 100_000; index += 1) {
    const id = `unit_${index}`;
    if (predicate(h5Bucket(appId, id))) return id;
  }
  throw new Error('no device found');
}

describe('pickPageVersion', () => {
  const page = { currentVersion: 3, grayVersion: 4, grayPercent: 50 };

  it('[AC-F1-09b] gray bucket below grayPercent×100 gets the gray version', () => {
    const deviceId = deviceIn('a', (bucket) => bucket === 4999);
    expect(pickPageVersion({ appId: 'a', deviceId, page })).toBe(4);
  });

  it('[AC-F1-09b] bucket at grayPercent×100 gets the current version', () => {
    const deviceId = deviceIn('a', (bucket) => bucket === 5000);
    expect(pickPageVersion({ appId: 'a', deviceId, page })).toBe(3);
  });

  it('[AC-F1-09b] no device id and no gray version give the current version', () => {
    expect(
      pickPageVersion({ appId: 'a', deviceId: null, page: { ...page, grayPercent: 100 } }),
    ).toBe(3);
    expect(pickPageVersion({ appId: 'a', deviceId: '', page: { ...page, grayPercent: 100 } })).toBe(
      3,
    );
    expect(
      pickPageVersion({
        appId: 'a',
        deviceId: 'd',
        page: { ...page, grayVersion: null, grayPercent: 100 },
      }),
    ).toBe(3);
  });

  it('[AC-F1-09b] empty current version outside gray is null', () => {
    expect(
      pickPageVersion({
        appId: 'a',
        deviceId: 'd',
        page: { currentVersion: null, grayVersion: 4, grayPercent: 0 },
      }),
    ).toBeNull();
  });
});

describe('passesVersionGate', () => {
  it('[AC-F1-09b] not-lower-than on the own platform key only', () => {
    expect(passesVersionGate({ min_app_version: { ios: '1.2.3' } }, ios)).toBe(true);
    expect(passesVersionGate({ min_app_version: { ios: '1.2.4' } }, ios)).toBe(false);
    expect(passesVersionGate({ min_app_version: { android: '1.0.0' } }, ios)).toBe(false);
  });

  it('[AC-F1-09b] ungated platforms and absent gates pass; broken values fail closed', () => {
    expect(passesVersionGate({ min_app_version: 'bad' }, { ...ios, platform: 'h5' })).toBe(true);
    expect(passesVersionGate({}, { ...ios, appVersion: undefined })).toBe(true);
    expect(passesVersionGate({ min_app_version: { ios: '1.0' } }, ios)).toBe(false);
    expect(
      passesVersionGate({ min_app_version: { ios: '1.0.0' } }, { ...ios, appVersion: 'v1' }),
    ).toBe(false);
    expect(passesVersionGate({ min_app_version: [] }, ios)).toBe(false);
    expect(passesVersionGate([], ios)).toBe(false);
  });

  it('[AC-F1-09b] inherited keys are not thresholds', () => {
    const gate = Object.create({ ios: '1.0.0' }) as object;
    expect(passesVersionGate({ min_app_version: gate }, ios)).toBe(false);
  });
});

describe('matchesCondition', () => {
  it('[AC-F1-09b] login yes / no / any and deferred facts', () => {
    expect(matchesCondition({ condition: { login: 'no' } }, ios)).toBe(true);
    expect(matchesCondition({ condition: { login: 'yes' } }, ios)).toBe(false);
    expect(matchesCondition({ condition: { login: 'yes' } }, { ...ios, loggedIn: true })).toBe(
      true,
    );
    expect(matchesCondition({ condition: { has_order: 'any', login: 'any' } }, ios)).toBe(true);
    expect(matchesCondition({ condition: { has_order: 'no' } }, ios)).toBe(false);
    expect(matchesCondition({ condition: { other: 'any' } }, ios)).toBe(false);
    expect(matchesCondition({ condition: ['any'] }, ios)).toBe(false);
    expect(matchesCondition({ condition: null }, ios)).toBe(true);
  });
});

describe('selectSections', () => {
  it('[AC-F1-09b] keeps order and identity of passing sections', () => {
    const a = { id: 'a' };
    const b = { id: 'b', condition: { login: 'yes' } };
    const c = { id: 'c', min_app_version: { ios: '1.0.0' } };
    const result = selectSections([a, b, null, c], ios);
    expect(result).toEqual([a, c]);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(c);
  });
});
