// Unit tests of the console's risk state command (F1-07d) on a scripted pg transport: real Kysely
// statements, no database, no Redis, no listen. The rule tests (test/spec/risk/admin-risk-state)
// cover PostgreSQL locking and the real ports; these pin the order of the steps.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, type RedisHandle } from '../../platform/index.ts';
import {
  AdminRiskState,
  AdminRiskStateFieldsError,
  AdminRiskStateNotAllowedError,
  type AdminRiskAction,
} from './admin-risk-state.ts';
import { RiskStateConflictError, type RiskStateService } from './risk-state.ts';

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-000000000030';
const NOW = '2031-05-06T07:08:09.000Z';

interface Row {
  state: string;
  reason: string | null;
  reason_category: string | null;
  frozen_until: Date | null;
  changed_by: string | null;
  changed_at: Date | null;
  row_version: number;
}

function harness(options: { user?: boolean; row?: Row | null; redis?: boolean } = {}) {
  const log: string[] = [];
  const state = { row: options.row ?? null };
  const client = {
    release() {},
    async query(text: string) {
      log.push(`sql:${text}`);
      if (/^select\b/i.test(text) && text.includes('"users"')) {
        const rows = options.user === false ? [] : [{ id: USER }];
        return { command: 'SELECT', rowCount: rows.length, rows };
      }
      if (/^select\b/i.test(text) && text.includes('user_risk_state')) {
        const rows = state.row === null ? [] : [{ ...state.row }];
        return { command: 'SELECT', rowCount: rows.length, rows };
      }
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const clock = new FixedClock(NOW);
  const setRiskState = vi.fn<RiskStateService['setRiskState']>(async (_trx, command) => {
    log.push(`setRiskState:${command.state}`);
    state.row = {
      state: command.state,
      reason: command.reason,
      reason_category: command.reason_category,
      frozen_until: command.frozen_until,
      changed_by: command.changed_by,
      changed_at: clock.now(),
      row_version: state.row === null ? 0 : state.row.row_version + 1,
    };
  });
  const riskState: RiskStateService = {
    readRiskState: vi.fn(),
    setRiskState,
    checkRequest: vi.fn(),
  };
  const evals = vi.fn(async (_script: string, opts: { args: readonly string[] }) => {
    log.push(`stamp:${opts.args[0]!}`);
    return opts.args[0]!;
  });
  const redis: RedisHandle = {
    namespace: () => ({ get: async () => null, set: async () => undefined, eval: evals }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  const warn = vi.fn();
  const append = vi.fn(async () => {
    log.push('audit');
  });
  const revokeSessions = vi.fn(async () => {
    log.push('revokeSessions');
    return ['sid'];
  });
  const blockForBan = vi.fn(async () => {
    log.push('blockForBan');
  });
  const restoreAfterUnban = vi.fn(async () => {
    log.push('restoreAfterUnban');
  });
  const service = new AdminRiskState({
    db,
    clock,
    events: { publish: vi.fn() },
    riskState,
    ...(options.redis === false ? {} : { redis }),
    logger: { warn },
    auditOn: () => ({ append }),
    revokeSessions,
    blockForBan,
    restoreAfterUnban,
  });
  return { db, log, service, setRiskState, evals, warn, append, revokeSessions, blockForBan };
}

function row(state: string, version = 3): Row {
  return {
    state,
    reason: '原原因',
    reason_category: state === 'normal' ? null : 'other',
    frozen_until: null,
    changed_by: 'fixture',
    changed_at: null,
    row_version: version,
  };
}

function command(action: AdminRiskAction, expected: number | null, extra: object = {}) {
  return {
    appId: APP,
    userId: USER,
    adminId: '019a0000-0000-7000-8000-0000000000a1',
    adminUsername: 'ops-unit',
    ip: null,
    body: {
      action,
      reason: '人工处理',
      expected_row_version: expected,
      ...(action === 'ban' || action === 'freeze' ? { reason_category: 'other' as const } : {}),
      ...extra,
    },
  };
}

const sqlOnly = (log: readonly string[]) => log.filter((line) => line.startsWith('sql:'));

it.each([
  ['ban', null, null],
  ['freeze', null, null],
  ['unban', 3, 'banned'],
  ['unfreeze', 3, 'frozen'],
] as const)(
  '[F1-07d S2①] %s takes the user lock FOR NO KEY UPDATE before reading and writing the risk state',
  async (action, expected, seeded) => {
    const h = harness({ row: seeded === null ? null : row(seeded) });
    try {
      await h.service.apply(command(action, expected));
      const statements = sqlOnly(h.log);
      const lock = h.log.findIndex((line) => /from "app"\."users"/i.test(line));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(h.log[lock]).toMatch(/for no key update$/i);
      expect(h.log[lock]).not.toMatch(/for update$/i);
      expect(statements.findIndex((line) => /from "app"\."users"/i.test(line))).toBe(
        statements.findIndex((line) => !/^sql:(begin|commit)/i.test(line)),
      );
      expect(lock).toBeLessThan(h.log.findIndex((line) => line.startsWith('setRiskState:')));
    } finally {
      await h.db.destroy();
    }
  },
);

it('[F1-07d S2②] a ban writes no withdrawal and calls its ports in order, the stamp last before and after the commit', async () => {
  const h = harness();
  try {
    const view = await h.service.apply(command('ban', null));
    expect(view).toMatchObject({ state: 'banned', row_version: 0, changed_by: 'ops-unit' });
    expect(h.log.some((line) => /withdrawal/i.test(line))).toBe(false);
    const steps = h.log.filter((line) => !line.startsWith('sql:') || /^sql:commit/i.test(line));
    expect(steps).toEqual([
      'setRiskState:banned',
      'revokeSessions',
      'blockForBan',
      'audit',
      'stamp:0',
      'sql:commit',
      'stamp:0',
    ]);
    expect(h.revokeSessions).toHaveBeenCalledWith(expect.anything(), {
      app_id: APP,
      user_id: USER,
      reason: 'banned',
    });
  } finally {
    await h.db.destroy();
  }
});

it.each(['freeze', 'unfreeze'] as const)(
  '[F1-07d] %s touches neither sessions nor bindings',
  async (action) => {
    const h = harness({ row: action === 'unfreeze' ? row('frozen') : null });
    try {
      await h.service.apply(command(action, action === 'unfreeze' ? 3 : null));
      expect(h.log).not.toContain('revokeSessions');
      expect(h.log).not.toContain('blockForBan');
      expect(h.log).not.toContain('restoreAfterUnban');
      expect(h.log).toContain('audit');
    } finally {
      await h.db.destroy();
    }
  },
);

it('[F1-07d] without Redis nothing is read or written', async () => {
  const h = harness({ redis: false });
  try {
    await expect(h.service.apply(command('ban', null))).rejects.toThrow(/need Redis/);
    expect(h.log).toEqual([]);
  } finally {
    await h.db.destroy();
  }
});

it('[F1-07d] an unknown user is 20001 user_id; a version mismatch conflicts; a refused state is 44004', async () => {
  const unknown = harness({ user: false });
  const conflict = harness({ row: row('normal', 3) });
  const appealing = harness({ row: row('appealing', 3) });
  const bannedFreeze = harness({ row: row('banned', 3) });
  try {
    await expect(unknown.service.apply(command('ban', null))).rejects.toMatchObject({
      fields: ['user_id'],
    });
    await expect(conflict.service.apply(command('ban', 2))).rejects.toBeInstanceOf(
      RiskStateConflictError,
    );
    await expect(appealing.service.apply(command('unban', 3))).rejects.toBeInstanceOf(
      AdminRiskStateNotAllowedError,
    );
    await expect(bannedFreeze.service.apply(command('freeze', 3))).rejects.toBeInstanceOf(
      AdminRiskStateNotAllowedError,
    );
    for (const h of [unknown, conflict, appealing, bannedFreeze]) {
      expect(h.setRiskState).not.toHaveBeenCalled();
      expect(h.evals).not.toHaveBeenCalled();
    }
  } finally {
    for (const h of [unknown, conflict, appealing, bannedFreeze]) await h.db.destroy();
  }
});

it.each([
  ['unban', { reason_category: 'other' }, 'reason_category'],
  ['ban', { reason_category: undefined }, 'reason_category'],
  ['ban', { frozen_until: null }, 'frozen_until'],
  ['freeze', { frozen_until: NOW }, 'frozen_until'],
  ['freeze', { frozen_until: 'later' }, 'frozen_until'],
  ['freeze', { reason: '' }, 'reason'],
  ['freeze', { expected_row_version: -1 }, 'expected_row_version'],
] as const)('[F1-07d] %s with %o is 20001 %s before the lock', async (action, extra, field) => {
  const h = harness();
  try {
    const input = command(action, null, extra);
    await expect(h.service.apply(input)).rejects.toBeInstanceOf(AdminRiskStateFieldsError);
    await expect(h.service.apply(input)).rejects.toMatchObject({ fields: [field] });
    expect(h.log).toEqual([]);
  } finally {
    await h.db.destroy();
  }
});

it('[F1-07d] a freeze keeps a future frozen_until as a date of that instant', async () => {
  const h = harness();
  try {
    const view = await h.service.apply(
      command('freeze', null, { frozen_until: '2031-05-06T07:08:09.001Z' }),
    );
    expect(view.frozen_until).toBe('2031-05-06T07:08:09.001Z');
  } finally {
    await h.db.destroy();
  }
});

it('[F1-07d] the stamp after the commit is retried, then one warn line without the error; the change stands', async () => {
  const h = harness();
  try {
    let calls = 0;
    h.evals.mockImplementation(async (_script, opts) => {
      calls += 1;
      if (calls > 1) throw new Error('synthetic secret detail');
      return opts.args[0]!;
    });
    expect(await h.service.apply(command('ban', null))).toMatchObject({ state: 'banned' });
    expect(calls).toBe(4);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.warn.mock.calls[0])).not.toContain('synthetic secret detail');
  } finally {
    await h.db.destroy();
  }
});
