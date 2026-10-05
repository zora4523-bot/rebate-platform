import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { fixture, snapshot } from './fixture.ts';

function child(url: string, name: string, adminId: string, appId: string) {
  const process = fork(new URL('./concurrent-child.ts', import.meta.url), [], {
    execArgv: ['--conditions=couli-src'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  process.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  process.stderr!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const received = new Map<string, unknown>();
  const waiting = new Map<string, (message: unknown) => void>();
  process.on('message', (value: unknown) => {
    const message = value as { kind: string };
    received.set(message.kind, value);
    waiting.get(message.kind)?.(value);
  });
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  const failed = new Promise<never>((_resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('bootstrap child did not complete within 20s')),
      20_000,
    );
    timeout.unref();
    process.once('exit', () => clearTimeout(timeout));
    process.once('error', reject);
    process.once('exit', (code) =>
      reject(new Error(`bootstrap child exited (${String(code)}): ${output}`)),
    );
    process.on('message', (value: unknown) => {
      const message = value as { kind: string; message?: string };
      if (message.kind === 'failure') reject(new Error(message.message));
    });
  });
  // Keep asynchronous child failures handled even while the parent is observing the other child.
  void failed.catch(() => undefined);
  const wait = (kind: string) =>
    Promise.race([
      received.has(kind)
        ? Promise.resolve(received.get(kind))
        : new Promise<unknown>((resolve) => waiting.set(kind, resolve)),
      failed,
    ]);
  process.send({ url, name, adminId, appId });
  return {
    wait,
    received: (kind: string) => received.get(kind),
    send: (message: string) => process.send(message),
    stop: async () => {
      if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
      await exited;
    },
  };
}

it.each([
  ['couli', 'a'],
  ['couli', 'b'],
  ['couli_two', 'a'],
  ['couli_two', 'b'],
] as const)(
  '[AC-F1-06c-BOOTSTRAP#11] independent processes in app %s with %s inserting first create only one global super and audit',
  async (secondApp, leader) => {
    // No connections except disposable couli_app URLs supplied by the integration global setup.
    const database = await createTestDatabase();
    const url = database.urlFor('couli_app');
    const db = createDb({ connectionString: url });
    const children: ReturnType<typeof child>[] = [];
    try {
      // Make the skeleton fail directly as NotImplemented, before child IPC/DB-lock assertions.
      const f = await fixture(db);
      f.create();
      const first = child(url, 'bootstrap-race-a', '019a0000-0000-7000-8000-000000000101', 'couli');
      const second = child(
        url,
        'bootstrap-race-b',
        '019a0000-0000-7000-8000-000000000102',
        secondApp,
      );
      children.push(first, second);
      await Promise.all([first.wait('ready'), second.wait('ready')]);
      const [winner, contender] = leader === 'a' ? [first, second] : [second, first];
      const winnerId =
        leader === 'a'
          ? '019a0000-0000-7000-8000-000000000101'
          : '019a0000-0000-7000-8000-000000000102';
      const contenderName = leader === 'a' ? 'bootstrap-race-b' : 'bootstrap-race-a';
      winner.send('run');
      await winner.wait('prompt');
      winner.send('confirm');
      const held = (await winner.wait('in-tx')) as {
        adminId: string;
        transaction: boolean;
        pid: number;
      };
      expect(held.adminId).toBe(winnerId);
      expect(held.transaction).toBe(true);
      expect(Number.isInteger(held.pid)).toBe(true);
      expect(await snapshot(db)).toEqual({ users: [], permissions: [], audits: [] });

      // A cannot commit until explicitly released below. B must now actually contend
      // with A's uncommitted insert, in either input-before-lock or lock-before-input designs.
      contender.send('run');
      contender.send('confirm');
      let blockedOrRefused = false;
      for (let poll = 0; poll < 500; poll += 1) {
        expect(contender.received('in-tx')).toBeUndefined();
        const earlyResult = contender.received('result') as { exitCode: number } | undefined;
        if (earlyResult !== undefined) {
          expect(Number.isInteger(earlyResult.exitCode)).toBe(true);
          expect(earlyResult.exitCode).toBeGreaterThan(0);
          blockedOrRefused = true;
          break;
        }
        const activity = await sql<{ waiting: boolean }>`
          select exists (
            select 1 from pg_stat_activity
            where datname = current_database()
              and application_name = ${contenderName}
              and wait_event_type = 'Lock'
              and ${held.pid} = any(pg_blocking_pids(pid))
          ) as waiting
        `.execute(db);
        if (activity.rows[0]!.waiting) {
          blockedOrRefused = true;
          break;
        }
        await delay(10);
      }
      expect(blockedOrRefused).toBe(true);
      expect(contender.received('in-tx')).toBeUndefined();
      expect(await snapshot(db)).toEqual({ users: [], permissions: [], audits: [] });
      winner.send('commit');
      // A lock with no post-lock existence check must fail by assertion, not hang at B's gate.
      const outcome = (await Promise.race([contender.wait('result'), contender.wait('in-tx')])) as {
        kind: string;
        exitCode?: number;
      };
      expect(outcome.kind).toBe('result');
      expect(Number.isInteger(outcome.exitCode)).toBe(true);
      expect(outcome.exitCode).toBeGreaterThan(0);
      expect(await winner.wait('result')).toEqual({ kind: 'result', exitCode: 0 });
      expect(contender.received('in-tx')).toBeUndefined();
      const state = await snapshot(db);
      expect(state.users).toHaveLength(1);
      expect(state.users[0]!.id).toBe(winnerId);
      expect(state.users[0]!.is_super).toBe(true);
      expect(state.users[0]!.totp_bound_at).not.toBeNull();
      expect(state.audits).toHaveLength(1);
      expect(state.audits[0]!.admin_id).toBe(state.users[0]!.id);
      expect(state.audits[0]!.app_id).toBe(state.users[0]!.app_id);
      expect(state.permissions).toEqual([]);
    } finally {
      await Promise.all(children.map((process) => process.stop()));
      await destroyDb(db);
      await database.drop();
    }
  },
);
