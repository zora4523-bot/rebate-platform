// B2-05n (D10-475 ②; 规划/02 §11 队列拆分与事件清单): the overdue check runs on its own worker queue
// payout-overdue — exclusive (one queued or active job per slot singletonKey: a heal or a rerun of
// the same slot merges), the directory defaults, its own dead letter queue, right after ledger-check;
// the worker works it with concurrency 1 and no other entry consumes it (payout's couli_payout least
// of all: only couli_app may write review_overdue_at, B2-05m). The event withdrawal.review_overdue
// is registered once, last (02 §11 末尾), and nothing in the platform routes it yet (notification's
// subscription is identity's task). Unit tests: no database, no port. Top-level it() only.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  EVENT_NAMES,
  EVENT_SUBSCRIPTIONS,
} from '../../../../apps/api/src/modules/platform/events/index.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { EVENT, QUEUE } from './kit.ts';

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

it('[B2-05n 队列目录] payout-overdue 恰一条，exclusive、目录默认值、死信 payout-overdue.dead，紧跟 ledger-check；死信队列设置同其他 <q>.dead', () => {
  expect(QUEUE_CATALOG.filter((queue) => queue.name === QUEUE)).toStrictEqual([
    { name: QUEUE, policy: 'exclusive', ...DEFAULT, deadLetter: 'payout-overdue.dead' },
  ]);
  const at = QUEUE_CATALOG.findIndex((queue) => queue.name === QUEUE);
  expect(QUEUE_CATALOG[at - 1]?.name).toBe('ledger-check');
  expect(QUEUE_CATALOG.filter((queue) => queue.name === 'payout-overdue.dead')).toStrictEqual([
    {
      name: 'payout-overdue.dead',
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

it('[B2-05n 入口计划] 只有 worker 消费 payout-overdue，并发 1、轮询 2 秒，紧跟 ledger-check；api / stream / admin / payout 都不消费', () => {
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === QUEUE)).toStrictEqual([
    { queue: QUEUE, concurrency: 1, pollingIntervalSeconds: 2 },
  ]);
  const at = ENTRY_PLAN.worker.findIndex((work) => work.queue === QUEUE);
  expect(ENTRY_PLAN.worker[at - 1]?.queue).toBe('ledger-check');
  expect(
    (['api', 'stream', 'admin', 'payout'] as const).flatMap((entry) =>
      ENTRY_PLAN[entry].filter((work) => work.queue === QUEUE).map(() => entry),
    ),
  ).toStrictEqual([]);
});

it('[02 §11 事件清单; D10-475 ②(a)] withdrawal.review_overdue 恰登记一次、在清单末尾；平台路由表里没有它的订阅（通知由 identity 线接 WD_OVERDUE 时订阅）', () => {
  expect(EVENT_NAMES.filter((name) => name === EVENT)).toHaveLength(1);
  expect(EVENT_NAMES.at(-1)).toBe(EVENT);
  expect(EVENT_SUBSCRIPTIONS.filter((item) => item.events.includes(EVENT))).toStrictEqual([]);
});

it('[B2-05n 装配（源码）] worker 侧装配调用 createReviewOverdueCheck / createReviewOverdueJob 注册 payout-overdue 并调用 seedReviewOverdue 起链；payout 进程的运行时与 forPayout 不碰它；检查的源码不读墙钟、不读 process.env、不用 console', () => {
  const payoutModule = source('../../../../apps/api/src/modules/payout/payout.module.ts');
  expect(payoutModule).toMatch(/\bcreateReviewOverdueCheck\s*\(/);
  expect(payoutModule).toMatch(/\bcreateReviewOverdueJob\s*\(/);
  expect(payoutModule).toMatch(/\bseedReviewOverdue\s*\(/);
  const forPayout = payoutModule.slice(payoutModule.indexOf('static forPayout('));
  expect(forPayout.slice(0, forPayout.indexOf('static forRoot('))).not.toMatch(
    /ReviewOverdue|payout-overdue/,
  );
  const runtime = source('../../../../apps/api/src/modules/payout/payout-runtime.ts');
  expect(runtime).not.toMatch(/ReviewOverdue|payout-overdue/);
  for (const path of [
    '../../../../apps/api/src/modules/payout/application/review-overdue.ts',
    '../../../../apps/api/src/modules/payout/jobs/review-overdue-job.ts',
  ]) {
    const code = source(path)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code, path).not.toMatch(
      /\bDate\.now\s*\(|\bnew\s+Date\s*\(|\bprocess\.env\b|\bconsole\./,
    );
  }
});
