// B2-07c (编排裁定 D10-408; 规划/02 §11 队列拆分): the R2 reconciliation runs on its own worker queue
// payout-recon (couli_app), registered as B2-06f registered payout-review: exclusive (one queued or
// active run per (app, channel, bill day) singletonKey: a rerun or a second seed merges), the
// directory defaults, its own dead letter queue; the worker works it with concurrency 1; no other
// entry (payout's couli_payout least of all) consumes it. Unit tests: no database, no port.
// Top-level it() only (规划/11 §4.3).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';

const DEFAULT = {
  retryLimit: 5,
  retryDelaySeconds: 10,
  retryBackoff: true,
  retryDelayMaxSeconds: 600,
  expireInSeconds: 900,
  retentionSeconds: 1_209_600,
  deleteAfterSeconds: 604_800,
} as const;

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

it('[AC-B2-07c#1] 队列目录：payout-recon 恰一条，exclusive、目录默认值、死信 payout-recon.dead，紧跟 payout-review；死信队列设置同其他 <q>.dead', () => {
  expect(QUEUE_CATALOG.filter((queue) => queue.name === 'payout-recon')).toStrictEqual([
    { name: 'payout-recon', policy: 'exclusive', ...DEFAULT, deadLetter: 'payout-recon.dead' },
  ]);
  const at = QUEUE_CATALOG.findIndex((queue) => queue.name === 'payout-recon');
  expect(QUEUE_CATALOG[at - 1]?.name).toBe('payout-review');
  expect(QUEUE_CATALOG.filter((queue) => queue.name === 'payout-recon.dead')).toStrictEqual([
    {
      name: 'payout-recon.dead',
      policy: 'standard',
      retryLimit: 0,
      retryDelaySeconds: 1,
      retryBackoff: false,
      retryDelayMaxSeconds: null,
      expireInSeconds: 900,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
      deadLetter: null,
    },
  ]);
});

it('[AC-B2-07c#1] 入口计划：只有 worker 消费 payout-recon，并发 1、轮询 2 秒，紧跟 payout-review；api / stream / admin / payout 都不消费', () => {
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === 'payout-recon')).toStrictEqual([
    { queue: 'payout-recon', concurrency: 1, pollingIntervalSeconds: 2 },
  ]);
  const at = ENTRY_PLAN.worker.findIndex((work) => work.queue === 'payout-recon');
  expect(ENTRY_PLAN.worker[at - 1]?.queue).toBe('payout-review');
  expect(
    (['api', 'stream', 'admin', 'payout'] as const).flatMap((entry) =>
      ENTRY_PLAN[entry].filter((work) => work.queue === 'payout-recon').map(() => entry),
    ),
  ).toStrictEqual([]);
});

it('[AC-B2-07c#1] 装配（源码）：worker 侧装配调用 createPayoutReconJob 注册 payout-recon 的处理器，并调用 seedPayoutRecon 起每日链；payout 进程的运行时不碰它', () => {
  const worker = [
    source('../../../../apps/api/src/app.module.ts'),
    source('../../../../apps/api/src/modules/payout/payout.module.ts'),
  ].join('\n');
  expect(worker).toMatch(/\bcreatePayoutReconJob\s*\(/);
  expect(worker).toMatch(/\bseedPayoutRecon\s*\(/);
  const payoutRuntime = source('../../../../apps/api/src/modules/payout/payout-runtime.ts');
  expect(payoutRuntime).not.toMatch(/\bcreatePayoutReconJob\b|payout-recon/);
});
