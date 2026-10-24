// B1-03w rule tests without a database: the three send sites of the risk-scan chain — seed()
// (worker start), handle()'s continuation and heal() (B1-03u) — go through a JobQueue double that
// applies platform/queue's own validateSend, exactly what QueueRuntime.send checks before it
// touches the database. Every send must be accepted under the names `freeze_expiry` /
// `daily_alerts` (orchestrator §9.2 #1), and one slot keeps one readable singletonKey whichever
// site computes it (§9.2 #2). The real runtime and database: ./chain.int.test.ts.
import { afterEach, expect, it } from 'vitest';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  JOB_NAMES,
  emptyDb,
  fixedClock,
  keyPattern,
  linesOf,
  memoryLogger,
  receivedJob,
  scanModule,
  settle,
  validatingQueue,
  type Phase,
  type Sent,
} from './kit.ts';

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function chain(at: string) {
  const clock = await fixedClock(at);
  const { logger, lines } = memoryLogger();
  const queue = validatingQueue();
  const db = emptyDb();
  databases.push(db);
  const { createRiskScan } = await scanModule();
  const scan = createRiskScan({
    db,
    clock,
    riskState: { setRiskState: async () => undefined },
    queue: queue.queue,
    logger,
  });
  return { clock, lines, scan, ...queue };
}

/** Per job name: the key and delay of the sends of `phase`. */
function slots(sends: readonly Sent[], phase: Phase) {
  return Object.fromEntries(
    sends
      .filter((sent) => sent.phase === phase)
      .map((sent) => [sent.name, { key: sent.singletonKey, delay: sent.delaySeconds ?? 0 }]),
  );
}

it('[B1-03w#4] seed、续排、自愈三处发送都过 platform/queue 的 validateSend：任务名恰为 freeze_expiry / daily_alerts，seed 不拒绝、不记 enqueue/heal 失败', async () => {
  const c = await chain('2026-10-15T00:00:23+08:00');
  c.phase('seed');
  const seeded = await settle(c.scan.seed());
  c.phase('heal');
  const healed = await settle(c.scan.heal());
  c.phase('continue');
  const handled: Record<string, string> = {};
  for (const name of JOB_NAMES) handled[name] = await settle(c.scan.handle(receivedJob(name)));
  expect({
    seeded,
    healed,
    handled,
    sends: c.sends.map((sent) => `${sent.phase} ${sent.queue} ${sent.name} ${sent.outcome}`).sort(),
    trx: c.sends.map((sent) => sent.trx),
    failures: linesOf(c.lines, [
      'risk_scan_enqueue_failed',
      'risk_scan_heal_failed',
      'risk_scan_seed_failed',
    ]),
  }).toEqual({
    seeded: 'resolved',
    healed: 'resolved',
    handled: { daily_alerts: 'resolved', freeze_expiry: 'resolved' },
    sends: [
      'continue risk-scan daily_alerts accepted',
      'continue risk-scan freeze_expiry accepted',
      'heal risk-scan daily_alerts accepted',
      'heal risk-scan freeze_expiry accepted',
      'seed risk-scan daily_alerts accepted',
      'seed risk-scan freeze_expiry accepted',
    ],
    trx: [null, null, null, null, null, null],
    failures: [],
  });
});

it('[B1-03w#5] singletonKey 保持可读且同槽同键：seed 取当前槽，续排与自愈在同一时刻算出同一个下一槽键，到点后的 seed 也与之相同', async () => {
  const c = await chain('2026-10-15T00:00:23+08:00');
  c.phase('seed');
  await settle(c.scan.seed());
  c.phase('heal');
  await settle(c.scan.heal());
  c.phase('continue');
  for (const name of JOB_NAMES) await settle(c.scan.handle(receivedJob(name)));
  const seed = slots(c.sends, 'seed');
  const heal = slots(c.sends, 'heal');
  expect(seed).toEqual({
    freeze_expiry: {
      key: expect.stringMatching(keyPattern('freeze_expiry', '2026-10-14T16:00')),
      delay: 0,
    },
    daily_alerts: {
      key: expect.stringMatching(keyPattern('daily_alerts', '2026-10-15')),
      delay: 0,
    },
  });
  expect(heal).toEqual({
    freeze_expiry: {
      key: expect.stringMatching(keyPattern('freeze_expiry', '2026-10-14T16:01')),
      delay: 37,
    },
    daily_alerts: {
      key: expect.stringMatching(keyPattern('daily_alerts', '2026-10-16')),
      delay: 86_677,
    },
  });
  // The continuation of a job finishing now and the heal of now must collide on the exclusive key.
  expect(slots(c.sends, 'continue')).toEqual(heal);
  // One spelling per name: the slot of the next minute / day, seeded when due, is the same key.
  c.sends.length = 0;
  c.phase('seed');
  c.clock.set('2026-10-15T00:01:00+08:00');
  await settle(c.scan.seed());
  c.clock.set('2026-10-16T00:05:00+08:00');
  await settle(c.scan.seed());
  expect(c.sends.map((sent) => [sent.name, sent.singletonKey])).toEqual(
    expect.arrayContaining([
      ['freeze_expiry', heal['freeze_expiry']?.key],
      ['daily_alerts', heal['daily_alerts']?.key],
    ]),
  );
  expect(c.sends.every((sent) => sent.outcome === 'accepted')).toBe(true);
});
