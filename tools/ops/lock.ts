// Atomic directory locks under couli-runs (规划/11 §2.2).
//
// `mkdir` either creates the directory or fails with EEXIST, which makes it an
// atomic test-and-set on a local file system.
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../lib/fsx.ts';
import { runsDir } from '../lib/paths.ts';

export const LEASE_MS = 20 * 60_000;

export type LockOwner = { session: string; pid: number };

export type LockHolder = {
  pid: number;
  session: string;
  acquired_at: string;
  heartbeat_at: string;
};

export type LockStatus =
  { held: false } | { held: true; holder: LockHolder | null; heartbeat_at: string; stale: boolean };

export type AcquireResult =
  { acquired: true; takeover: boolean } | { acquired: false; status: LockStatus };

function holderFile(dir: string): string {
  return join(dir, 'holder.json');
}

function readHolder(dir: string): LockHolder | null {
  try {
    const raw = JSON.parse(readFileSync(holderFile(dir), 'utf8')) as Partial<LockHolder>;
    if (
      typeof raw.pid === 'number' &&
      typeof raw.session === 'string' &&
      typeof raw.acquired_at === 'string' &&
      typeof raw.heartbeat_at === 'string'
    ) {
      return raw as LockHolder;
    }
    return null;
  } catch {
    return null;
  }
}

/** Creates `dir` atomically; false when it already exists. */
export function mkdirExclusive(dir: string): boolean {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function lockStatus(dir: string, now: Date): LockStatus {
  let mtime: Date;
  try {
    mtime = statSync(dir).mtime;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { held: false };
    throw err;
  }
  const holder = readHolder(dir);
  // A holder that crashed between mkdir and the first write leaves no file:
  // the directory mtime then stands in for the heartbeat.
  const heartbeat = holder ? holder.heartbeat_at : mtime.toISOString();
  const stale = now.getTime() - Date.parse(heartbeat) > LEASE_MS;
  return { held: true, holder, heartbeat_at: heartbeat, stale };
}

/** How long a contender may sit between "saw a stale lock" and "replaced it". */
const TAKEOVER_GATE_MS = 60_000;

/**
 * Takes the lock. The holder is identified by its session name; the pid is
 * recorded for the reader. A lock whose heartbeat is older than 20 minutes is
 * taken over; a fresh one is respected even when its process is gone
 * (规划/11 §2.2: only the heartbeat decides).
 *
 * Removing a stale lock happens under a second directory lock (`<dir>.takeover`)
 * so that two contenders cannot both replace it. A holder that was paused for
 * longer than the lease finds out on its next heartbeat (it returns false) and
 * must stop.
 */
export function acquireLock(dir: string, who: LockOwner, now: Date): AcquireResult {
  let takeover = false;
  if (!mkdirExclusive(dir)) {
    const seen = lockStatus(dir, now);
    if (seen.held && !seen.stale) return { acquired: false, status: seen };
    const gate = `${dir}.takeover`;
    if (!mkdirExclusive(gate)) {
      // Another contender is replacing the lock, or crashed while doing so.
      try {
        if (now.getTime() - statSync(gate).mtime.getTime() > TAKEOVER_GATE_MS) {
          rmSync(gate, { recursive: true, force: true });
        }
      } catch {
        // The gate vanished: the next attempt sorts it out.
      }
      return { acquired: false, status: lockStatus(dir, now) };
    }
    try {
      const again = lockStatus(dir, now);
      if (again.held && !again.stale) return { acquired: false, status: again };
      if (again.held) {
        rmSync(dir, { recursive: true, force: true });
        takeover = true;
      }
      if (!mkdirExclusive(dir)) return { acquired: false, status: lockStatus(dir, now) };
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  }
  const stamp = now.toISOString();
  const holder: LockHolder = { ...who, acquired_at: stamp, heartbeat_at: stamp };
  writeFileAtomic(holderFile(dir), `${JSON.stringify(holder, null, 2)}\n`);
  return { acquired: true, takeover };
}

/**
 * Runs `fn` while holding the takeover gate of `dir`, so that a heartbeat or a release cannot
 * interleave with a contender replacing a stale lock (read holder → compare → write/remove is
 * not atomic by itself). A gate held by somebody else means a takeover is in progress: the
 * caller's lock is stale, and `onBusy` is returned.
 */
function underGate<T>(dir: string, now: Date, onBusy: T, fn: () => T): T {
  const gate = `${dir}.takeover`;
  if (!mkdirExclusive(gate)) {
    try {
      if (now.getTime() - statSync(gate).mtime.getTime() > TAKEOVER_GATE_MS) {
        rmSync(gate, { recursive: true, force: true });
      }
    } catch {
      // The gate vanished: the next attempt sorts it out.
    }
    return onBusy;
  }
  try {
    return fn();
  } finally {
    rmSync(gate, { recursive: true, force: true });
  }
}

/**
 * Renews the heartbeat; false when the lock is not (or no longer) ours, or when our own lease
 * has already expired (a holder that was paused for longer than the lease must stop, because
 * a contender may take the lock over at any moment).
 */
export function heartbeatLock(dir: string, who: LockOwner, now: Date): boolean {
  return underGate(dir, now, false, () => {
    const holder = readHolder(dir);
    if (!holder || holder.session !== who.session) return false;
    if (now.getTime() - Date.parse(holder.heartbeat_at) > LEASE_MS) return false;
    const next: LockHolder = { ...holder, pid: who.pid, heartbeat_at: now.toISOString() };
    writeFileAtomic(holderFile(dir), `${JSON.stringify(next, null, 2)}\n`);
    return true;
  });
}

/** Releases the lock; false when it is held by somebody else (or being taken over). */
export function releaseLock(
  dir: string,
  who: Pick<LockOwner, 'session'>,
  now: Date = new Date(),
): boolean {
  return underGate(dir, now, false, () => {
    const holder = readHolder(dir);
    if (!holder || holder.session !== who.session) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  });
}

export function orchestratorLockDir(): string {
  return join(runsDir(), 'lock', 'orchestrator');
}

export function acquireOrchestratorLock(who: LockOwner, now: Date = new Date()): AcquireResult {
  return acquireLock(orchestratorLockDir(), who, now);
}

export function heartbeatOrchestratorLock(who: LockOwner, now: Date = new Date()): boolean {
  return heartbeatLock(orchestratorLockDir(), who, now);
}

export function releaseOrchestratorLock(who: Pick<LockOwner, 'session'>): boolean {
  return releaseLock(orchestratorLockDir(), who);
}

export function orchestratorLockStatus(now: Date = new Date()): LockStatus {
  return lockStatus(orchestratorLockDir(), now);
}
