import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { EVENT_SUBSCRIPTIONS } from '../../../../apps/api/src/modules/platform/events/types.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/catalog.ts';

it('[AC-B2-05e#41] account.went_negative 路由到专用消费者且只在 worker work 1', () => {
  expect(EVENT_SUBSCRIPTIONS).toContainEqual({
    consumer: 'payout-went-negative',
    events: ['account.went_negative'],
  });
  expect(QUEUE_CATALOG.map((queue) => queue.name)).toContain('evt.payout-went-negative');
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === 'evt.payout-went-negative')).toEqual([
    expect.objectContaining({ concurrency: 1 }),
  ]);
  for (const entry of ['api', 'admin', 'stream', 'payout'] as const) {
    expect(ENTRY_PLAN[entry].some((work) => work.queue === 'evt.payout-went-negative')).toBe(false);
  }
});

it('[AC-B2-05e#42] app.module 使用真实 payout reader 并移除两处 B2-05 占位', () => {
  const source = readFileSync(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url),
    'utf8',
  );
  expect(source).toMatch(/createWithdrawalInFlightReader\s*\(/);
  expect(source).not.toContain('在途提现读 payout 模块 — blocked on B2-05');
  expect(source).not.toContain('未到终态的提现（含封禁冻结）读 payout 模块 — blocked on B2-05');
  expect(source).not.toMatch(/has(?:InFlight|NonTerminal):\s*\(\)\s*=>\s*Promise.resolve\(false\)/);
});
