import { existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  acquireLock,
  acquireOrchestratorLock,
  heartbeatLock,
  heartbeatOrchestratorLock,
  LEASE_MS,
  lockStatus,
  mkdirExclusive,
  orchestratorLockDir,
  orchestratorLockStatus,
  releaseLock,
  releaseOrchestratorLock,
} from './lock.ts';
import { removeDir, scratchDir } from './test-helpers.ts';

const T0 = new Date('2026-10-01T04:00:00.000Z');
const later = (ms: number): Date => new Date(T0.getTime() + ms);
const A = { session: 'session-a', pid: 101 };
const B = { session: 'session-b', pid: 202 };

let base = '';
let dir = '';
let n = 0;

beforeAll(() => {
  base = scratchDir('lock');
  process.env.COULI_RUNS = join(base, 'runs');
});
beforeEach(() => {
  n += 1;
  dir = join(base, `lock-${n}`);
});
afterAll(() => removeDir(base));

it('gives the lock to exactly one session', () => {
  expect(acquireLock(dir, A, T0)).toEqual({ acquired: true, takeover: false });
  const second = acquireLock(dir, B, later(1000));
  expect(second.acquired).toBe(false);
  expect(lockStatus(dir, later(1000))).toMatchObject({
    held: true,
    stale: false,
    holder: { session: 'session-a', pid: 101, acquired_at: T0.toISOString() },
  });
});

it('respects a fresh heartbeat and takes over only after 20 minutes of silence', () => {
  acquireLock(dir, A, T0);
  expect(acquireLock(dir, B, later(LEASE_MS)).acquired).toBe(false);
  // The holder renews just before the lease ends.
  expect(heartbeatLock(dir, A, later(LEASE_MS - 1000))).toBe(true);
  expect(acquireLock(dir, B, later(2 * LEASE_MS - 2000)).acquired).toBe(false);
  expect(acquireLock(dir, B, later(2 * LEASE_MS))).toEqual({ acquired: true, takeover: true });
  // The previous holder finds out on its next heartbeat and must stop.
  expect(heartbeatLock(dir, A, later(2 * LEASE_MS + 1))).toBe(false);
  expect(releaseLock(dir, A)).toBe(false);
  expect(lockStatus(dir, later(2 * LEASE_MS + 1))).toMatchObject({
    holder: { session: 'session-b' },
  });
});

it('releases only for the holder and can be taken again afterwards', () => {
  acquireLock(dir, A, T0);
  expect(releaseLock(dir, B)).toBe(false);
  expect(releaseLock(dir, A)).toBe(true);
  expect(lockStatus(dir, T0)).toEqual({ held: false });
  expect(acquireLock(dir, B, T0).acquired).toBe(true);
});

it('treats a lock directory without a holder file by its age', () => {
  expect(mkdirExclusive(dir)).toBe(true);
  expect(mkdirExclusive(dir)).toBe(false);
  const made = new Date();
  expect(lockStatus(dir, made)).toMatchObject({ held: true, holder: null, stale: false });
  expect(acquireLock(dir, A, made).acquired).toBe(false);
  // Crashed between mkdir and the first write, long ago.
  const old = new Date(made.getTime() - LEASE_MS - 60_000);
  utimesSync(dir, old, old);
  expect(acquireLock(dir, A, made)).toEqual({ acquired: true, takeover: true });
});

it('does not take over while another contender is replacing the lock', () => {
  const now = new Date();
  acquireLock(dir, A, new Date(now.getTime() - 2 * LEASE_MS));
  expect(mkdirExclusive(`${dir}.takeover`)).toBe(true);
  expect(acquireLock(dir, B, now).acquired).toBe(false);
  expect(existsSync(`${dir}.takeover`)).toBe(true);
  // A contender that crashed in the middle leaves the gate behind; it expires after a minute.
  expect(acquireLock(dir, B, new Date(now.getTime() + 61_000)).acquired).toBe(false);
  expect(existsSync(`${dir}.takeover`)).toBe(false);
  expect(acquireLock(dir, B, new Date(now.getTime() + 62_000))).toEqual({
    acquired: true,
    takeover: true,
  });
});

it('keeps the orchestrator lock in couli-runs/lock/orchestrator', () => {
  expect(orchestratorLockDir()).toBe(join(base, 'runs', 'lock', 'orchestrator'));
  expect(orchestratorLockStatus(T0)).toEqual({ held: false });
  expect(acquireOrchestratorLock(A, T0).acquired).toBe(true);
  expect(acquireOrchestratorLock(B, later(60_000)).acquired).toBe(false);
  expect(heartbeatOrchestratorLock(A, later(LEASE_MS))).toBe(true);
  expect(orchestratorLockStatus(later(LEASE_MS + 1000))).toMatchObject({
    held: true,
    stale: false,
    heartbeat_at: later(LEASE_MS).toISOString(),
  });
  expect(releaseOrchestratorLock(B)).toBe(false);
  expect(releaseOrchestratorLock(A)).toBe(true);
  expect(existsSync(orchestratorLockDir())).toBe(false);
});

it('heartbeat and release go through the takeover gate and never revive an expired lease', () => {
  acquireLock(dir, A, T0);
  // A paused holder whose lease has run out may not renew: a contender can take over now.
  expect(heartbeatLock(dir, A, later(LEASE_MS + 1))).toBe(false);
  expect(lockStatus(dir, later(LEASE_MS + 1))).toMatchObject({ stale: true });
  // While a contender holds the gate, neither a heartbeat nor a release of the old holder
  // can interleave with the replacement.
  expect(mkdirExclusive(`${dir}.takeover`)).toBe(true);
  expect(heartbeatLock(dir, A, later(1000))).toBe(false);
  expect(releaseLock(dir, A, later(1000))).toBe(false);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(`${dir}.takeover`)).toBe(true);
  // Gate gone: the holder's own heartbeat (inside the lease) and release work again, and the
  // gate is left clean.
  rmSync(`${dir}.takeover`, { recursive: true, force: true });
  expect(releaseLock(dir, B, later(1000))).toBe(false);
  const b = acquireLock(dir, B, later(2 * LEASE_MS));
  expect(b).toEqual({ acquired: true, takeover: true });
  expect(releaseLock(dir, A, later(2 * LEASE_MS))).toBe(false);
  expect(heartbeatLock(dir, B, later(2 * LEASE_MS + 5))).toBe(true);
  expect(releaseLock(dir, B, later(2 * LEASE_MS + 6))).toBe(true);
  expect(existsSync(`${dir}.takeover`)).toBe(false);
});
