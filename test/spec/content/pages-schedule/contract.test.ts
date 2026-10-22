import { expect, it } from 'vitest';
import {
  QUEUE_CATALOG,
  ENTRY_PLAN,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { contract } from './kit.ts';

it('[AC-F1-09p#27] 撤销操作正式启用，content.page 不要求二次认证', async () => {
  const doc = await contract();
  const operation = doc.paths['/admin/v1/pages/{page_key}/schedule']!['delete']!;
  expect(operation.operationId).toBe('adminCancelPageConfigSchedule');
  expect(operation).not.toHaveProperty('x-implementation', 'planned');
  expect(operation).toHaveProperty('x-auth', 'admin');
});

it('[AC-F1-09p#28] page-schedule 位于 pool-refresh 后且 poster 前，仅 worker 并发 1 消费', () => {
  const index = QUEUE_CATALOG.findIndex((q) => q.name === 'pool-refresh');
  const defaults = QUEUE_CATALOG[index]!;
  expect(QUEUE_CATALOG[index + 1]).toEqual({ ...defaults, name: 'page-schedule' });
  expect(QUEUE_CATALOG[index + 2]?.name).toBe('poster');
  const worker = ENTRY_PLAN.worker;
  const position = worker.findIndex((q) => q.queue === 'pool-refresh');
  expect(worker[position + 1]).toEqual({
    queue: 'page-schedule',
    concurrency: 1,
    pollingIntervalSeconds: 2,
  });
  expect(worker[position + 2]?.queue).toBe('poster');
  for (const entry of ['api', 'admin', 'stream', 'payout'] as const) {
    expect(ENTRY_PLAN[entry].some((q) => q.queue === 'page-schedule')).toBe(false);
  }
});
