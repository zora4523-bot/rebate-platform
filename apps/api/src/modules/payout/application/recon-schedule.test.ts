import { expect, it } from 'vitest';
import {
  previousReconDay,
  reconDayAfter,
  reconDayBefore,
  reconJobKey,
  reconRunAt,
} from './recon-schedule.ts';

const LIKE = new Date('2026-10-19T02:00:00.000Z');

it('[AC-B2-07c#5] 前一自然日按 +08:00 取：UTC 仍是前一天的凌晨也算当天', () => {
  expect(previousReconDay(new Date('2026-10-19T02:00:00.000Z'))).toBe('2026-10-18');
  expect(previousReconDay(new Date('2026-10-18T17:00:00.000Z'))).toBe('2026-10-18');
  expect(previousReconDay(new Date('2026-10-18T15:59:59.000Z'))).toBe('2026-10-17');
});

it('[AC-B2-07c#5] 账单日 D 的运行时刻在 D 结束之后、D+1 结束之前；前后一日跨月正确；键含 app、通道与账单日', () => {
  const runAt = reconRunAt('2026-10-18', LIKE).getTime();
  expect(runAt).toBeGreaterThanOrEqual(Date.parse('2026-10-18T16:00:00.000Z'));
  expect(runAt).toBeLessThan(Date.parse('2026-10-19T16:00:00.000Z'));
  expect(reconDayAfter('2026-10-31', LIKE)).toBe('2026-11-01');
  expect(reconDayBefore('2026-11-01', LIKE)).toBe('2026-10-31');
  expect(reconJobKey('app-1', 'alipay', '2026-10-18')).toBe('recon:app-1:alipay:2026-10-18');
});
