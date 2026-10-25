// B1-01zzk: option `limits` of createQueueRuntime (contract sections 9 and 12 of
// apps/api/src/modules/platform/queue/index.ts). Valid limits are accepted by every entry (only
// the worker applies them); invalid ones throw QueueError('invalid_option') synchronously, after
// the catalog check; creating a runtime still opens no connection. The db handle points at
// 127.0.0.1:1 where nothing listens, and the tests count socket connection attempts (must stay 0).
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  createDbHandles,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createQueueRuntime } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { envFor, urlsOf, watchSocketConnects } from '../db/kit.ts';
import { memoryLogger, spec, thrown, thrownProblems, type Entry } from '../queue/kit.ts';
import { LIMIT_CATALOG, LIMIT_PLAN } from './kit.ts';

function handlesFor(entry: Entry, label: string): DbHandles {
  const { logger } = memoryLogger(entry);
  return createDbHandles(loadConnectionConfig(entry, envFor(entry, urlsOf(label).env)), {
    logger,
  });
}

it('[B1-01zzk 配置覆盖; 其他入口不受影响] createQueueRuntime 接受合法的 limits（五个入口都接受，生产目录与计划亦然）；不合法的 limits 同步抛 invalid_option（固定文案、无 cause），目录错误仍先报 invalid_catalog；全程不连库', async () => {
  const sockets = watchSocketConnects();
  try {
    const all: Entry[] = ['api', 'stream', 'admin', 'worker', 'payout'];
    const handles = Object.fromEntries(
      all.map((entry) => [entry, handlesFor(entry, `limits.${entry}`)]),
    ) as Record<Entry, DbHandles>;
    const { logger } = memoryLogger('worker');
    const create = (entry: Entry, limits: unknown, extra: Record<string, unknown> = {}) =>
      thrown(() =>
        createQueueRuntime({
          entry,
          db: handles[entry].db,
          logger,
          catalog: LIMIT_CATALOG,
          plan: LIMIT_PLAN,
          limits,
          ...extra,
        } as never),
      );
    const valid = { concurrency: { 'c-a': 1, 'c-c': 2 }, dbBudget: 3 };
    const seen: Record<string, string> = {};
    for (const entry of all) seen[`valid on ${entry}`] = create(entry, valid);
    seen['no override, default budget'] = create('worker', { concurrency: {}, dbBudget: null });
    seen['budget 1'] = create('worker', { concurrency: {}, dbBudget: 1 });
    seen['budget 7'] = create('worker', { concurrency: {}, dbBudget: 7 });
    seen['production catalog and plan'] = thrown(() =>
      createQueueRuntime({
        entry: 'worker',
        db: handles.worker.db,
        logger,
        limits: { concurrency: { notify: 1, export: 1, pay: 2 }, dbBudget: 5 },
      } as never),
    );
    seen['c-a above its plan 4'] = create('worker', { concurrency: { 'c-a': 5 }, dbBudget: null });
    seen['c-pay (payout only)'] = create('worker', { concurrency: { 'c-pay': 1 }, dbBudget: 3 });
    seen['dead letter queue'] = create('worker', { concurrency: { 'test-dead': 1 }, dbBudget: 3 });
    seen['budget 0'] = create('worker', { concurrency: {}, dbBudget: 0 });
    seen['budget 8'] = create('worker', { concurrency: {}, dbBudget: 8 });
    seen['extra key'] = create('worker', { concurrency: {}, dbBudget: 3, ratio: 0.7 });
    seen['limits null'] = create('worker', null);
    seen['payout: budget 0'] = create('payout', { concurrency: {}, dbBudget: 0 });
    seen['bad catalog first'] = create(
      'worker',
      { concurrency: { 'c-a': 5 }, dbBudget: 0 },
      { catalog: [...LIMIT_CATALOG, spec('c-a')] },
    );
    const shape = thrownProblems(
      () =>
        createQueueRuntime({
          entry: 'worker',
          db: handles.worker.db,
          logger,
          catalog: LIMIT_CATALOG,
          plan: LIMIT_PLAN,
          limits: { concurrency: {}, dbBudget: 8 },
        } as never),
      'invalid_option',
    );
    for (const entry of all) await handles[entry].close();
    expect(seen).toStrictEqual({
      'valid on api': 'returned',
      'valid on stream': 'returned',
      'valid on admin': 'returned',
      'valid on worker': 'returned',
      'valid on payout': 'returned',
      'no override, default budget': 'returned',
      'budget 1': 'returned',
      'budget 7': 'returned',
      'production catalog and plan': 'returned',
      'c-a above its plan 4': 'QueueError invalid_option',
      'c-pay (payout only)': 'QueueError invalid_option',
      'dead letter queue': 'QueueError invalid_option',
      'budget 0': 'QueueError invalid_option',
      'budget 8': 'QueueError invalid_option',
      'extra key': 'QueueError invalid_option',
      'limits null': 'QueueError invalid_option',
      'payout: budget 0': 'QueueError invalid_option',
      'bad catalog first': 'QueueError invalid_catalog',
    });
    expect(shape).toStrictEqual([]);
    expect(sockets.count()).toBe(0);
  } finally {
    sockets.restore();
  }
});
