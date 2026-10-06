// Only launched by local.ts, with credentials over IPC (never command-line arguments).
import { boss, pool, QUEUE } from './dependencies.ts';
import { assertLocalTarget } from './drill.ts';

interface WorkerConfig {
  pgUrl: string;
  applicationName: string;
  holdFirst: boolean;
}

async function work(config: WorkerConfig): Promise<void> {
  assertLocalTarget({ pgUrl: config.pgUrl, redisUrl: 'redis://127.0.0.1:63790' });
  if (!/^qa05b_[a-f0-9]{32}$/.test(new URL(config.pgUrl).pathname.slice(1))) {
    throw new Error('Not a drill database');
  }
  const db = pool(config.pgUrl, config.applicationName);
  const queue = boss(config.pgUrl, config.applicationName, false);
  let stopping: Promise<void> | undefined;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = config.holdFirst;
  const stop = () => {
    release();
    stopping ??= (async () => {
      await queue.stop({ graceful: true, timeout: 10_000 });
      await db.end();
      if (process.connected) process.disconnect();
    })();
    void stopping.catch(() => process.exit(1));
  };
  process.on('message', (message: unknown) => {
    if (message === 'release') release();
    if (message === 'stop') stop();
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('disconnect', stop);
  await queue.start();
  await queue.work(QUEUE, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) {
      await db.query(
        `INSERT INTO app.drill_deliveries(event_id, attempts) VALUES ($1, 1)
         ON CONFLICT (event_id) DO UPDATE SET attempts = app.drill_deliveries.attempts + 1`,
        [job.id],
      );
      // The unique consumer/event key and its business effect commit atomically. The effect
      // table deliberately has NO uniqueness on event_id, so a broken dedup is observable.
      await db.query(
        `WITH accepted AS (
           INSERT INTO app.drill_processed(consumer, event_id) VALUES ('qa05b', $1)
           ON CONFLICT (consumer, event_id) DO NOTHING RETURNING event_id
         ) INSERT INTO app.drill_effects(event_id) SELECT event_id FROM accepted`,
        [job.id],
      );
      if (first) {
        first = false;
        // Parent observes the committed effect via snapshot before injecting the fault.
        // This process dies here in worker-kill, leaving a genuine unacknowledged PG job.
        await barrier;
      }
    }
  });
  process.send?.('ready');
}

if (!process.send) throw new Error('Queue drill worker requires an IPC parent');
process.once('message', (message: WorkerConfig) => {
  void work(message).catch(() => process.exit(1));
});
