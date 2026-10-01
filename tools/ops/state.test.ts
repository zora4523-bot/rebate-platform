import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LEASE_MS } from './lock.ts';
import {
  ATTEMPT_LIMITS,
  bumpAttempt,
  claimDir,
  claimTask,
  listStates,
  readState,
  releaseTask,
  stateFile,
  updateState,
} from './state.ts';
import { CLI_TIMEOUT, removeDir, runCli, scratchDir } from './test-helpers.ts';

const T0 = new Date('2026-10-01T04:00:00.000Z');
const later = (ms: number): Date => new Date(T0.getTime() + ms);

let runs = '';

beforeAll(() => {
  runs = join(scratchDir('state'), 'runs');
  process.env.COULI_RUNS = runs;
});
afterAll(() => removeDir(join(runs, '..')));

it('creates the state file on first use and writes it atomically', () => {
  expect(readState('A1-01')).toBeNull();
  const state = updateState('A1-01', { state: 'doing', pid: 4242 }, T0);
  expect(state).toEqual({
    id: 'A1-01',
    state: 'doing',
    attempts: { impl: 0, review: 0 },
    spec_commit: null,
    pid: 4242,
    started_at: T0.toISOString(),
    owner_session: null,
    lease_until: null,
    ask_created_at: null,
    last_error: null,
    updated_at: T0.toISOString(),
  });
  expect(JSON.parse(readFileSync(stateFile('A1-01'), 'utf8'))).toEqual(state);
  // No temporary file is left next to it.
  expect(readdirSync(join(runs, 'state'))).toEqual(['A1-01.json']);
});

it('records when a task entered `ask` and forgets it when the task leaves', () => {
  updateState('A1-02', { state: 'ask' }, T0);
  const again = updateState('A1-02', { last_error: '/x/err.txt' }, later(3600_000));
  expect(again.ask_created_at).toBe(T0.toISOString());
  expect(updateState('A1-02', { state: 'doing' }, later(7200_000)).ask_created_at).toBeNull();
});

it('counts attempts before dispatch and refuses to go past the limits', () => {
  expect(ATTEMPT_LIMITS).toEqual({ impl: 3, review: 2 });
  expect(bumpAttempt('A1-03', 'impl', T0).attempts).toEqual({ impl: 1, review: 0 });
  bumpAttempt('A1-03', 'impl', T0);
  expect(bumpAttempt('A1-03', 'impl', T0).attempts.impl).toBe(3);
  // Persisted: a crash right after the bump still counts the attempt.
  expect(readState('A1-03')?.attempts.impl).toBe(3);
  expect(() => bumpAttempt('A1-03', 'impl', T0)).toThrow(/impl attempts exhausted \(3 of 3/);
  expect(readState('A1-03')?.attempts.impl).toBe(3);
  bumpAttempt('A1-03', 'review', T0);
  bumpAttempt('A1-03', 'review', T0);
  expect(() => bumpAttempt('A1-03', 'review', T0)).toThrow(/review attempts exhausted/);
});

it('lets one session claim a task, with a 20 minute lease that can be renewed', () => {
  const claimed = claimTask('A1-04', { owner: 'session-a', now: T0 });
  expect(claimed.owner_session).toBe('session-a');
  expect(claimed.lease_until).toBe(later(LEASE_MS).toISOString());
  expect(existsSync(claimDir('A1-04'))).toBe(true);
  expect(() => claimTask('A1-04', { owner: 'session-b', now: later(1000) })).toThrow(
    /already claimed by session-a/,
  );
  // Even the same session must renew explicitly.
  expect(() => claimTask('A1-04', { owner: 'session-a', now: later(1000) })).toThrow(
    /already claimed/,
  );
  const renewed = claimTask('A1-04', { owner: 'session-a', renew: true, now: later(600_000) });
  expect(renewed.lease_until).toBe(later(600_000 + LEASE_MS).toISOString());
  expect(() => claimTask('A1-04', { owner: 'session-b', renew: true, now: T0 })).toThrow(
    /no claim held by session-b/,
  );
});

it('hands an expired claim to another session and releases claims', () => {
  claimTask('A1-05', { owner: 'session-a', now: T0 });
  expect(() => claimTask('A1-05', { owner: 'session-b', now: later(LEASE_MS) })).toThrow();
  const taken = claimTask('A1-05', { owner: 'session-b', now: later(LEASE_MS + 1000) });
  expect(taken.owner_session).toBe('session-b');
  expect(() => releaseTask('A1-05', { owner: 'session-a', now: later(LEASE_MS + 2000) })).toThrow(
    /claim is held by session-b/,
  );
  const released = releaseTask('A1-05', { owner: 'session-b', now: later(LEASE_MS + 3000) });
  expect(released).toMatchObject({ owner_session: null, lease_until: null, pid: null });
  expect(existsSync(claimDir('A1-05'))).toBe(false);
  expect(
    claimTask('A1-05', { owner: 'session-a', now: later(LEASE_MS + 4000) }).owner_session,
  ).toBe('session-a');
});

it('lists every state file and rejects a damaged one', () => {
  expect(listStates().map((s) => s.id)).toEqual(['A1-01', 'A1-02', 'A1-03', 'A1-04', 'A1-05']);
  writeFileSync(stateFile('A1-06'), JSON.stringify({ id: 'A1-06', state: 'flying' }));
  expect(() => readState('A1-06')).toThrow(/state must be one of/);
  writeFileSync(stateFile('A1-06'), '{ not json');
  expect(() => listStates()).toThrow(/invalid JSON/);
  removeDir(stateFile('A1-06'));
});

it(
  'follows the exit code convention on the command line',
  () => {
    const env = { COULI_RUNS: runs };
    expect(runCli('state.ts', ['get', 'C1-01'], env).status).toBe(1);
    expect(runCli('state.ts', ['claim', 'C1-01', '--owner', 's1'], env).status).toBe(0);
    const second = runCli('state.ts', ['claim', 'C1-01', '--owner', 's2'], env);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already claimed by s1');
    expect(runCli('state.ts', ['claim', 'C1-01', '--owner', 's1', '--renew'], env).status).toBe(0);
    for (const n of [1, 2, 3]) {
      const res = runCli('state.ts', ['bump-attempt', 'C1-01', 'impl'], env);
      expect(JSON.parse(res.stdout)).toMatchObject({ attempts: { impl: n } });
    }
    expect(runCli('state.ts', ['bump-attempt', 'C1-01', 'impl'], env).status).toBe(1);
    const set = runCli(
      'state.ts',
      ['set', 'C1-01', '--state', 'verify', '--spec-commit', 'abc1234', '--last-error', 'none'],
      env,
    );
    expect(JSON.parse(set.stdout)).toMatchObject({ state: 'verify', spec_commit: 'abc1234' });
    expect(JSON.parse(runCli('state.ts', ['get', 'C1-01'], env).stdout)).toMatchObject({
      id: 'C1-01',
      state: 'verify',
      owner_session: 's1',
      attempts: { impl: 3, review: 0 },
    });
    expect(runCli('state.ts', ['release', 'C1-01', '--owner', 's2'], env).status).toBe(1);
    expect(runCli('state.ts', ['release', 'C1-01', '--owner', 's1'], env).status).toBe(0);
    expect(runCli('state.ts', ['set', 'C1-01', '--state', 'flying'], env).status).toBe(2);
    expect(runCli('state.ts', ['bump-attempt', 'C1-01', 'deploy'], env).status).toBe(2);
    expect(runCli('state.ts', ['get', '../../etc/passwd'], env).status).toBe(2);
  },
  CLI_TIMEOUT,
);
