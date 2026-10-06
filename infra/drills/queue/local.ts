import { execFile, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { boss, pool, QUEUE, type SqlPool } from './dependencies.ts';
import {
  assertLocalTarget,
  type DrillExecutor,
  type DrillJobView,
  type DrillTarget,
} from './drill.ts';

const exec = promisify(execFile);
const composeFile = fileURLToPath(new URL('../../local/compose.yaml', import.meta.url));
const migrationFile = new URL('../../../db/migrations/0002_pgboss-schema-v42.sql', import.meta.url);

/** Local defaults are independent of DATABASE_URL / PG_ADMIN_URL / REDIS_URL. */
export function localTarget(): DrillTarget {
  const env = process.env['APP_ENV'] ?? 'local';
  if (env !== 'local' && env !== 'test') throw new Error('Only local/test drills are allowed');
  const url = new URL('postgres://postgres@127.0.0.1:54329/postgres');
  url.password = process.env['COULI_DB_LOCAL_PASSWORD'] || 'couli_local';
  const pgUrl = env === 'test' ? process.env['TEST_PG_ADMIN_URL'] : url.href;
  if (!pgUrl) throw new Error('TEST_PG_ADMIN_URL is required for test drills');
  const target = { pgUrl, redisUrl: 'redis://127.0.0.1:63790' };
  assertLocalTarget(target);
  return target;
}

interface Worker {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** A whole disposable database isolates supervision and DDL from all application queues. */
export class LocalExecutor implements DrillExecutor {
  readonly database = `qa05b_${randomUUID().replaceAll('-', '')}`;
  readonly workerName = `${this.database}_worker`;
  readonly target: DrillTarget;
  readonly withRedis: boolean;
  private admin: SqlPool | undefined;
  private db: SqlPool | undefined;
  private producer: ReturnType<typeof boss> | undefined;
  private worker: Worker | undefined;
  private created = false;
  private firstWorker = true;
  private redisMayBeDown = false;
  private dockerHost: string | undefined;
  private locked = false;
  private cancelled = false;

  constructor(target: DrillTarget, withRedis: boolean) {
    assertLocalTarget(target);
    this.target = target;
    this.withRedis = withRedis;
  }

  private databaseUrl(): string {
    const url = new URL(this.target.pgUrl);
    url.pathname = `/${this.database}`;
    return url.href;
  }

  cancel(): void {
    this.cancelled = true;
  }

  private assertActive(): void {
    if (this.cancelled) throw new Error('Drill cancelled');
  }

  private async compose(args: string[]): Promise<string> {
    if (this.dockerHost === undefined) {
      const { stdout } = await exec(
        'docker',
        ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        {
          timeout: 10_000,
        },
      );
      const host = stdout.trim();
      if (!host.startsWith('unix://')) throw new Error('Docker must use a local Unix socket');
      this.dockerHost = host;
    }
    const env = { ...process.env };
    delete env['DOCKER_CONTEXT'];
    delete env['DOCKER_HOST'];
    delete env['DOCKER_TLS_VERIFY'];
    delete env['DOCKER_CERT_PATH'];
    const { stdout } = await exec(
      'docker',
      [
        '--host',
        this.dockerHost,
        'compose',
        '--env-file',
        '/dev/null',
        '-f',
        composeFile,
        '-p',
        'couli-local',
        ...args,
      ],
      { timeout: 30_000, env },
    );
    return stdout.trim();
  }

  async reset(): Promise<void> {
    this.assertActive();
    if (this.admin !== undefined) throw new Error('Executor is single-use');
    this.admin = pool(this.target.pgUrl, `${this.database}_admin`, 1);
    // One session for the advisory lock, held until dispose, serializes local Redis drills.
    // Other scenarios use isolated databases and can run concurrently.
    if (this.withRedis) {
      if (
        (process.env['APP_ENV'] ?? 'local') !== 'local' ||
        new URL(this.target.pgUrl).port !== '54329'
      ) {
        throw new Error('Redis drill requires the local compose stack');
      }
      const lock = await this.admin.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(51005, 2) AS locked',
      );
      if (!lock.rows[0]?.locked) throw new Error('Another Redis drill is running');
      this.locked = true;
      if ((await this.compose(['exec', '-T', 'redis', 'redis-cli', 'ping'])) !== 'PONG') {
        throw new Error('Redis must already be running');
      }
    }
    // Identifier consists only of a fixed prefix and random hex, never user input.
    await this.admin.query(`CREATE DATABASE "${this.database}" TEMPLATE template0`);
    this.created = true;
    this.db = pool(this.databaseUrl(), `${this.database}_observer`);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Use the committed schema migration; running producers/consumers always migrate:false.
      await client.query(await readFile(migrationFile, 'utf8'));
      await client.query(`
        CREATE SCHEMA app;
        CREATE TABLE app.drill_events (id uuid PRIMARY KEY);
        CREATE TABLE app.drill_deliveries (event_id uuid PRIMARY KEY, attempts integer NOT NULL);
        CREATE TABLE app.drill_processed (
          consumer text NOT NULL, event_id uuid NOT NULL, PRIMARY KEY (consumer, event_id)
        );
        CREATE TABLE app.drill_effects (event_id uuid NOT NULL);
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    this.producer = boss(this.databaseUrl(), `${this.database}_producer`, true);
    await this.producer.start();
    await this.producer.createQueue(QUEUE, {
      retryLimit: 5,
      retryDelay: 1,
      retryBackoff: false,
      expireInSeconds: 30,
      retentionSeconds: 3_600,
      deleteAfterSeconds: 3_600,
    });
    // Warm metadata before any transaction, so send cannot acquire a second connection.
    await this.producer.findJobs(QUEUE, { id: '00000000-0000-0000-0000-000000000000' });
  }

  async enqueue(ids: readonly string[]): Promise<void> {
    this.assertActive();
    if (!this.db || !this.producer) throw new Error('Executor not initialized');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      for (const id of ids) {
        await client.query('INSERT INTO app.drill_events(id) VALUES ($1)', [id]);
        const accepted = await this.producer.send(
          QUEUE,
          { eventId: id },
          {
            id,
            db: { executeSql: (text, values) => client.query(text, values) },
          },
        );
        if (accepted !== id) throw new Error('Enqueue did not accept the event');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async startWorker(): Promise<void> {
    this.assertActive();
    if (this.worker !== undefined) throw new Error('Worker already started');
    const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [], {
      // Do not forward environment secrets, arbitrary Node loaders, inspectors, or raw errors.
      env: { PATH: process.env['PATH'], APP_ENV: 'test' },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', () => resolve({ code: 1, signal: null }));
      },
    );
    this.worker = { child, exited };
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', (message: unknown) => {
        if (message === 'ready') resolve();
        else reject(new Error('Invalid worker startup'));
      });
      void exited.then(() => reject(new Error('Worker exited before ready')));
    });
    child.send(
      { pgUrl: this.databaseUrl(), applicationName: this.workerName, holdFirst: this.firstWorker },
      (error) => {
        if (error) child.kill('SIGKILL');
      },
    );
    this.firstWorker = false;
    await bounded(ready, 15_000);
  }

  async stopWorker(mode: 'graceful' | 'kill'): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      this.worker = undefined;
      throw new Error('Worker exited unexpectedly');
    }
    if (mode === 'kill') worker.child.kill('SIGKILL');
    else
      worker.child.send('stop', (error) => {
        if (error) worker.child.kill('SIGKILL');
      });
    try {
      const status = await bounded(worker.exited, 15_000);
      if (mode === 'kill' && status.signal !== 'SIGKILL') {
        throw new Error('Worker was not killed');
      }
      if (mode === 'graceful' && (status.code !== 0 || status.signal !== null)) {
        throw new Error('Worker did not stop gracefully');
      }
    } catch (error) {
      worker.child.kill('SIGKILL');
      await bounded(worker.exited, 5_000);
      throw error;
    } finally {
      this.worker = undefined;
    }
  }

  async disconnectQueue(): Promise<void> {
    this.assertActive();
    if (!this.db || !this.worker) throw new Error('Worker not started');
    const result = await this.db.query<{ terminated: boolean }>(
      `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
       WHERE datname = $1 AND application_name = $2 AND pid <> pg_backend_pid()`,
      [this.database, this.workerName],
    );
    if (!result.rows.some((row) => row.terminated))
      throw new Error('No worker connections terminated');
    this.worker.child.send('release', (error) => {
      if (error) this.worker?.child.kill('SIGKILL');
    });
  }

  async stopRedis(): Promise<void> {
    this.assertActive();
    if (!this.withRedis) throw new Error('Redis interruption not enabled');
    this.redisMayBeDown = true;
    await this.compose(['stop', '-t', '10', 'redis']);
    this.worker?.child.send('release', (error) => {
      if (error) this.worker?.child.kill('SIGKILL');
    });
  }

  async startRedis(): Promise<void> {
    if (!this.redisMayBeDown) return;
    await this.compose(['start', '--wait', '--wait-timeout', '20', 'redis']);
    if ((await this.compose(['exec', '-T', 'redis', 'redis-cli', 'ping'])) !== 'PONG') {
      throw new Error('Redis did not recover');
    }
    this.redisMayBeDown = false;
  }

  async snapshot() {
    this.assertActive();
    if (!this.db) throw new Error('Executor not initialized');
    const result = await this.db.query<DrillJobView>(
      `
      WITH ids AS (
        SELECT id FROM app.drill_events UNION SELECT id FROM pgboss.job WHERE name = $1
        UNION SELECT event_id FROM app.drill_effects UNION SELECT event_id FROM app.drill_deliveries
      ) SELECT ids.id, COALESCE(j.state::text, 'absent') AS state,
          COALESCE(d.attempts, 0)::integer AS deliveries,
          (SELECT count(*)::integer FROM app.drill_effects e WHERE e.event_id = ids.id) AS effects
        FROM ids LEFT JOIN pgboss.job j ON j.id = ids.id AND j.name = $1
        LEFT JOIN app.drill_deliveries d ON d.event_id = ids.id ORDER BY ids.id
    `,
      [QUEUE],
    );
    return { jobs: result.rows };
  }

  /** Attempt every cleanup even if another resource fails; the caller records any failure. */
  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(() => this.stopWorker('graceful'));
    await attempt(() => this.startRedis());
    await attempt(async () => this.producer?.stop({ graceful: false }));
    await attempt(async () => this.db?.end());
    if (this.created) {
      await attempt(async () => this.admin?.query(`DROP DATABASE "${this.database}" WITH (FORCE)`));
    }
    if (this.locked) {
      await attempt(async () => this.admin?.query('SELECT pg_advisory_unlock(51005, 2)'));
    }
    await attempt(async () => this.admin?.end());
    if (failures.length > 0) throw new Error('Drill cleanup failed');
  }
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Drill operation timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
