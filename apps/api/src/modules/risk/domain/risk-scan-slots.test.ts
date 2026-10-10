// Unit tests of the risk-scan time slots (B1-03j §9.3 #2): pure date arithmetic.
import { expect, it } from 'vitest';
import { currentRiskScanSlot, nextRiskScanSlot } from './risk-scan-slots.ts';

it('[B1-03j §9.3 #2] the current slot is the UTC minute and the +08:00 date, with no delay', () => {
  const now = new Date('2026-10-15T07:59:59.999+08:00');
  expect(currentRiskScanSlot('freeze-expiry', now)).toEqual({
    singletonKey: 'freeze-expiry:2026-10-14T23:59',
  });
  expect(currentRiskScanSlot('daily-alerts', now)).toEqual({
    singletonKey: 'daily-alerts:2026-10-15',
  });
});

it('[B1-03j §9.3 #2] the next freeze-expiry slot is the next UTC minute, at least one second away', () => {
  expect(nextRiskScanSlot('freeze-expiry', new Date('2026-10-14T23:59:00Z'))).toEqual({
    singletonKey: 'freeze-expiry:2026-10-15T00:00',
    delaySeconds: 60,
  });
  expect(nextRiskScanSlot('freeze-expiry', new Date('2026-10-14T23:59:59.001Z'))).toEqual({
    singletonKey: 'freeze-expiry:2026-10-15T00:00',
    delaySeconds: 1,
  });
});

it('[B1-03j §9.3 #2] the next daily-alerts slot is 00:05 of the next +08:00 day', () => {
  // 23:30 UTC is 07:30 of the next +08:00 day: the slot after that day is the day after.
  expect(nextRiskScanSlot('daily-alerts', new Date('2026-10-14T23:30:00Z'))).toEqual({
    singletonKey: 'daily-alerts:2026-10-16',
    delaySeconds: 59_700,
  });
  expect(nextRiskScanSlot('daily-alerts', new Date('2028-02-28T16:04:59.500Z'))).toEqual({
    singletonKey: 'daily-alerts:2028-03-01',
    delaySeconds: 86_401,
  });
});
