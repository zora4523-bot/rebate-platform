import { expect, it } from 'vitest';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/catalog.ts';

it('[AC-B1-34e#26] export exists once after risk-scan in the catalog with B1-34c standard defaults', () => {
  expect(QUEUE_CATALOG.filter((queue) => queue.name === 'export')).toEqual([
    {
      name: 'export',
      policy: 'standard',
      retryLimit: 5,
      retryDelaySeconds: 10,
      retryBackoff: true,
      retryDelayMaxSeconds: 600,
      expireInSeconds: 900,
      retentionSeconds: 1_209_600,
      deleteAfterSeconds: 604_800,
      deadLetter: 'dead-letter',
    },
  ]);
  const index = QUEUE_CATALOG.findIndex((queue) => queue.name === 'export');
  expect(QUEUE_CATALOG[index - 1]?.name).toBe('risk-scan');
  expect(QUEUE_CATALOG[index + 1]?.name).toBe('dead-letter');
});

it('[AC-B1-34e#27] only worker consumes export, between agent-trace and risk-scan, concurrency one', () => {
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === 'export')).toEqual([
    { queue: 'export', concurrency: 1, pollingIntervalSeconds: 2 },
  ]);
  const index = ENTRY_PLAN.worker.findIndex((work) => work.queue === 'export');
  expect(ENTRY_PLAN.worker[index - 1]?.queue).toBe('agent-trace');
  expect(ENTRY_PLAN.worker[index + 1]?.queue).toBe('risk-scan');
  for (const entry of ['api', 'admin', 'stream', 'payout'] as const) {
    expect(ENTRY_PLAN[entry].some((work) => work.queue === 'export')).toBe(false);
  }
});
