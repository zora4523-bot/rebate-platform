// Unit tests of the risk scans (B1-03j §10) on a scripted pg transport: real Kysely statements,
// no database, no listen. The rule tests (test/spec/risk/freeze-expiry) cover the selection
// rules against PostgreSQL; these pin per-user isolation, the worker seed helper and dispatch.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type JobQueue } from '../../platform/index.ts';
import { createRiskScan, seedRiskScan, type RiskScan } from './risk-scan.ts';
import { RiskStateConflictError, type RiskStateService } from './risk-state.ts';

const A = { app_id: 'couli', user_id: '019a0000-0000-7000-8000-000000000001' };
const B = { app_id: 'couli', user_id: '019a0000-0000-7000-8000-000000000002' };

function scripted(candidates: readonly (typeof A)[], recheck: (userId: string) => boolean) {
  const statements: string[] = [];
  const client = {
    release() {},
    async query(text: string, values?: readonly unknown[]) {
      statements.push(text);
      if (/^select\b/i.test(text) && text.includes('user_risk_state')) {
        if (/for update/i.test(text)) {
          const userId = (values ?? []).find((v) => v === A.user_id || v === B.user_id);
          const rows = typeof userId === 'string' && recheck(userId) ? [{ row_version: 7 }] : [];
          return { command: 'SELECT', rowCount: rows.length, rows };
        }
        // Candidates once (the batch is shorter than the limit, so there is no second query).
        return { command: 'SELECT', rowCount: candidates.length, rows: [...candidates] };
      }
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const send = vi.fn<JobQueue['send']>(async () => 'job');
  const setRiskState = vi.fn<RiskStateService['setRiskState']>(async () => undefined);
  const riskState = { setRiskState } as unknown as RiskStateService;
  const clock = new FixedClock('2026-10-15T00:00:00+08:00');
  const scan = createRiskScan({ db, clock, riskState, queue: { send }, logger });
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { db, statements, send, setRiskState, scan, logs };
}

it('[B1-03j §10] a conflicting user is skipped with a warn line; the next user is still released', async () => {
  const f = scripted([A, B], () => true);
  f.setRiskState.mockImplementation(async (_trx, command) => {
    if (command.user_id === A.user_id) throw new RiskStateConflictError();
  });
  try {
    await expect(f.scan.expireFrozen()).resolves.toBeUndefined();
    expect(f.setRiskState.mock.calls.map(([, c]) => c.user_id)).toEqual([A.user_id, B.user_id]);
    expect(f.setRiskState.mock.calls[1]![1]).toEqual({
      ...B,
      state: 'normal',
      reason: null,
      reason_category: null,
      frozen_until: null,
      changed_by: 'system:freeze-expiry',
    });
    expect(f.statements.filter((s) => /^rollback/i.test(s))).toHaveLength(1);
    expect(f.statements.filter((s) => /^commit/i.test(s))).toHaveLength(1);
    expect(f.logs().filter((l) => l['msg'] === 'risk_freeze_expiry_skipped')).toEqual([
      expect.objectContaining({ ...A, cause: 'conflict', level: 40 }),
    ]);
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03j §10] a candidate that no longer qualifies under the row lock is not written', async () => {
  const f = scripted([A], () => false);
  try {
    await f.scan.expireFrozen();
    expect(f.setRiskState).not.toHaveBeenCalled();
    expect(f.statements.some((s) => /for update/i.test(s))).toBe(true);
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03j §10] an unknown job name rejects without scanning or enqueuing', async () => {
  const f = scripted([A], () => true);
  try {
    await expect(
      f.scan.handle({ id: 'j', queue: 'risk-scan', name: 'other', payload: {}, attempt: 1 }),
    ).rejects.toThrow('unknown risk-scan job');
    expect(f.statements).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03j §10] seed() still sends the second seed when the first fails, then rejects', async () => {
  const f = scripted([], () => false);
  f.send.mockRejectedValueOnce(new Error('first-failed'));
  try {
    await expect(f.scan.seed()).rejects.toThrow('first-failed');
    expect(f.send.mock.calls.map(([, name]) => name)).toEqual(['freeze-expiry', 'daily-alerts']);
  } finally {
    await f.db.destroy();
  }
});

function seedHarness() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const seed = vi.fn<RiskScan['seed']>(async () => undefined);
  const scan = { seed } as unknown as RiskScan;
  const warns = () =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['level'] === 40);
  return { logger, seed, scan, warns };
}

it('[B1-03j §10] the worker seed helper seeds the resolved scan once', async () => {
  const h = seedHarness();
  await seedRiskScan(
    () => h.scan,
    h.logger,
    () => false,
  );
  expect(h.seed).toHaveBeenCalledTimes(1);
  expect(h.warns()).toEqual([]);
});

it('[B1-03j §10] the worker seed helper sends nothing while stopping, without a scan or for another provider value', async () => {
  const h = seedHarness();
  const resolve = vi.fn(() => h.scan);
  await seedRiskScan(resolve, h.logger, () => true);
  expect(resolve).not.toHaveBeenCalled();
  await seedRiskScan(
    () => null,
    h.logger,
    () => false,
  );
  await seedRiskScan(
    () => ({ start: () => undefined }),
    h.logger,
    () => false,
  );
  expect(h.seed).not.toHaveBeenCalled();
  expect(h.warns()).toEqual([]);
});

it('[B1-03j §10] a failed seed or lookup is a warn line, never a failed worker start', async () => {
  const h = seedHarness();
  h.seed.mockRejectedValueOnce(new Error('queue-down'));
  await expect(
    seedRiskScan(
      () => h.scan,
      h.logger,
      () => false,
    ),
  ).resolves.toBeUndefined();
  await expect(
    seedRiskScan(
      () => {
        throw new Error('no-provider');
      },
      h.logger,
      () => false,
    ),
  ).resolves.toBeUndefined();
  expect(h.warns()).toEqual([
    expect.objectContaining({ msg: 'risk_scan_seed_failed', queue: 'risk-scan' }),
    expect.objectContaining({ msg: 'risk_scan_seed_failed', queue: 'risk-scan' }),
  ]);
  expect(JSON.stringify(h.warns())).not.toContain('queue-down');
});
