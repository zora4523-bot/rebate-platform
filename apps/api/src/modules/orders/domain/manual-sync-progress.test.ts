// B1-09i: when a manual request ends after one of its job rows ended (money review r1).
import { expect, it } from 'vitest';
import { manualSyncRequestAfterJob } from './manual-sync.ts';

it('[AC-B1-09i#u7] 本窗 done 且仍有排队或执行中的窗口：请求保持 running', () => {
  expect(manualSyncRequestAfterJob('done', 1)).toBe('running');
  expect(manualSyncRequestAfterJob('done', 11)).toBe('running');
});

it('[AC-B1-09i#u8] 本窗 done 且没有未完成窗口：请求 done', () => {
  expect(manualSyncRequestAfterJob('done', 0)).toBe('done');
});

it('[AC-B1-09i#u9] 任何一窗 failed：请求 failed，不论还有多少未完成窗口', () => {
  expect(manualSyncRequestAfterJob('failed', 0)).toBe('failed');
  expect(manualSyncRequestAfterJob('failed', 5)).toBe('failed');
});
