// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { defaultReport } from '../../../../apps/h5/src/shared/whitescreen/report.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-F1-01e-REPORT#1] 待接入的 defaultReport 是无网络副作用的空上报口', () => {
  const fetch = vi.fn();
  const beacon = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('navigator', { sendBeacon: beacon });
  const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {});
  expect(() =>
    defaultReport({
      kind: 'whitescreen',
      path: '/rules',
      platform: null,
      version: null,
      elapsed_ms: 3000,
    }),
  ).not.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(beacon).not.toHaveBeenCalled();
  expect(xhr).not.toHaveBeenCalled();
});
