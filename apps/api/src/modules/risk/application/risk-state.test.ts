// Unit tests of the risk state service (B1-03h §10) on a scripted pg transport: real Kysely
// statements, no database, no listen. The rule tests (test/spec/risk/risk-state) cover the SQL
// against PostgreSQL; these pin the implementation choices the rule tests leave open.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, type EventBus } from '../../platform/index.ts';
import {
  RiskStateBannedException,
  RiskStateConflictError,
  RiskStateTransitionError,
  createRiskStateService,
  riskStateServiceToken,
  type RiskStateRequest,
  type SetRiskState,
} from './risk-state.ts';

const SUBJECT = { app_id: 'couli', user_id: '019a0000-0000-7000-8000-000000000010' };

interface Row {
  state: string;
  reason_category: string | null;
  frozen_until: Date | null;
  row_version: number;
}

function scripted() {
  const statements: string[] = [];
  const state: {
    row: Row | null;
    appeal: string | null;
    updated: number;
    failure?: Error;
    /** Awaited after a user_risk_state select has taken its rows: a slow reply of that value. */
    hold?: Promise<void> | undefined;
  } = { row: null, appeal: null, updated: 1 };
  const client = {
    release() {},
    async query(text: string) {
      statements.push(text);
      if (/^insert\b/i.test(text)) return { command: 'INSERT', rowCount: 1, rows: [] };
      if (/^update\b/i.test(text)) return { command: 'UPDATE', rowCount: state.updated, rows: [] };
      if (/^select\b/i.test(text) && text.includes('user_risk_state')) {
        if (state.failure !== undefined) throw state.failure;
        const rows = state.row === null ? [] : [{ ...SUBJECT, ...state.row }];
        const hold = state.hold;
        state.hold = undefined;
        if (hold !== undefined) await hold;
        return { command: 'SELECT', rowCount: rows.length, rows };
      }
      if (/^select\b/i.test(text) && text.includes('appeals')) {
        const rows = state.appeal === null ? [] : [{ prev_risk_state: state.appeal }];
        return { command: 'SELECT', rowCount: rows.length, rows };
      }
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const publish = vi.fn<EventBus['publish']>(async () => ({ eventId: 'e', duplicate: false }));
  const clock = new FixedClock('2031-05-06T07:08:09Z');
  const service = createRiskStateService({ db, clock, events: { publish } });
  const reads = () =>
    statements.filter((s) => /^select\b/i.test(s) && s.includes('user_risk_state'));
  return { db, state, statements, reads, publish, clock, service };
}

const BAN: SetRiskState = {
  ...SUBJECT,
  state: 'banned',
  reason: 'internal note for operators',
  reason_category: 'other',
  frozen_until: null,
  changed_by: 'unit_operator',
};

function request(path: string, method = 'GET', body?: unknown): RiskStateRequest {
  return {
    id: 'trace-unit',
    method,
    routeOptions: { url: path },
    headers: {},
    body,
    principal: {
      uid: SUBJECT.user_id,
      app_id: SUBJECT.app_id,
      sid: 's',
      device_id: 'd',
      scp: 'full',
    },
  };
}

it('[B1-03h §10] the DI token is one module symbol', () => {
  expect(typeof riskStateServiceToken()).toBe('symbol');
  expect(riskStateServiceToken()).toBe(riskStateServiceToken());
});

it('[B1-03h §10] first change inserts row_version 0 and publishes from normal on the same transaction, without the reason', async () => {
  const f = scripted();
  try {
    await f.db.transaction().execute(async (trx) => {
      await f.service.setRiskState(trx, BAN);
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect(f.publish.mock.calls[0]![0]).toBe(trx);
    });
    expect(f.statements.some((s) => /^insert into "app"\."user_risk_state"/i.test(s))).toBe(true);
    expect(f.statements.some((s) => /^update\b/i.test(s))).toBe(false);
    const event = f.publish.mock.calls[0]![1];
    expect(event).toEqual({
      appId: SUBJECT.app_id,
      name: 'risk.state_changed',
      payload: { ...SUBJECT, from: 'normal', to: 'banned', reason_category: 'other' },
    });
    expect(JSON.stringify(event)).not.toContain(BAN.reason);
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §10] a later change is a row_version compare-and-set; a lost race throws before publishing', async () => {
  const f = scripted();
  try {
    f.state.row = { state: 'frozen', reason_category: 'other', frozen_until: null, row_version: 3 };
    await f.db.transaction().execute((trx) => f.service.setRiskState(trx, BAN));
    const update = f.statements.find((s) => /^update\b/i.test(s))!;
    expect(update).toMatch(/where .*"row_version" = \$/i);
    expect(f.publish.mock.calls[0]![1].payload).toMatchObject({ from: 'frozen', to: 'banned' });
    f.state.updated = 0;
    await expect(
      f.db.transaction().execute((trx) => f.service.setRiskState(trx, BAN)),
    ).rejects.toBeInstanceOf(RiskStateConflictError);
    expect(f.publish).toHaveBeenCalledTimes(1);
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §10] after a change the cache is bypassed until the written version is visible, then refilled', async () => {
  const f = scripted();
  try {
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('normal');
    await f.service.readRiskState(SUBJECT);
    expect(f.reads()).toHaveLength(1);
    // Inserted but not committed: other connections still see no row.
    await f.db.transaction().execute((trx) => f.service.setRiskState(trx, BAN));
    const afterWrite = f.reads().length;
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('normal');
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('normal');
    expect(f.reads()).toHaveLength(afterWrite + 2);
    // Committed: the written row_version is visible, cached again.
    f.state.row = { state: 'banned', reason_category: 'other', frozen_until: null, row_version: 0 };
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('banned');
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('banned');
    expect(f.reads()).toHaveLength(afterWrite + 3);
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §10] a write never seen (rolled back) stops bypassing the cache after 60 seconds', async () => {
  const f = scripted();
  try {
    await f.db.transaction().execute((trx) => f.service.setRiskState(trx, BAN));
    await f.service.readRiskState(SUBJECT);
    const n = f.reads().length;
    f.clock.advanceMs(60_001);
    await f.service.readRiskState(SUBJECT);
    await f.service.readRiskState(SUBJECT);
    expect(f.reads()).toHaveLength(n + 1);
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §10] a non-sensitive read failure rejects, never reads as normal', async () => {
  const f = scripted();
  try {
    f.state.failure = new Error('unit database unavailable');
    await expect(f.service.checkRequest(request('/v1/products/search'))).rejects.toBe(
      f.state.failure,
    );
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §10] appealing: prev frozen passes; prev banned, or no processing account appeal, is refused', async () => {
  const f = scripted();
  try {
    f.state.row = {
      state: 'appealing',
      reason_category: 'other',
      frozen_until: null,
      row_version: 1,
    };
    const r = request('/v1/products/search');
    f.state.appeal = 'frozen';
    await expect(f.service.checkRequest(r)).resolves.toBeUndefined();
    f.state.appeal = 'banned';
    await expect(f.service.checkRequest(r)).rejects.toBeInstanceOf(RiskStateBannedException);
    f.state.appeal = null;
    await expect(f.service.checkRequest(r)).rejects.toMatchObject({
      status: 403,
      response: { code: 10006, trace_id: 'trace-unit' },
    });
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §10] the realname operation GET /v1/me/payout-account reads the database each time', async () => {
  const f = scripted();
  try {
    await f.service.checkRequest(request('/v1/me/payout-account'));
    await f.service.checkRequest(request('/v1/me/payout-account'));
    expect(f.reads()).toHaveLength(2);
    await f.service.checkRequest(request('/v1/products/search'));
    await f.service.checkRequest(request('/v1/products/search'));
    expect(f.reads()).toHaveLength(3);
  } finally {
    await f.db.destroy();
  }
});

function gate() {
  let open!: () => void;
  const hold = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { hold, open };
}

it('[B1-03h §11#5] a read of the old value that returns after the commit was seen does not refill the cache', async () => {
  const f = scripted();
  try {
    // Written, not committed: the slow read A takes the old value (no row).
    await f.db.transaction().execute((trx) => f.service.setRiskState(trx, BAN));
    const slow = gate();
    f.state.hold = slow.hold;
    const before = f.reads().length;
    const a = f.service.readRiskState(SUBJECT);
    await vi.waitFor(() => expect(f.reads()).toHaveLength(before + 1));
    // Committed; read B sees the written version and caches banned.
    f.state.row = { state: 'banned', reason_category: 'other', frozen_until: null, row_version: 0 };
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('banned');
    slow.open();
    expect((await a).state).toBe('normal');
    const n = f.reads().length;
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('banned');
    expect(f.reads()).toHaveLength(n);
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §11#5] a late snapshot of a lower row_version never replaces a newer cache entry', async () => {
  const f = scripted();
  try {
    // Changed by another instance: no pending write here, only the versions tell the order.
    f.state.row = { state: 'normal', reason_category: null, frozen_until: null, row_version: 4 };
    const slow = gate();
    f.state.hold = slow.hold;
    const before = f.reads().length;
    const a = f.service.readRiskState(SUBJECT);
    await vi.waitFor(() => expect(f.reads()).toHaveLength(before + 1));
    f.state.row = { state: 'banned', reason_category: 'other', frozen_until: null, row_version: 5 };
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('banned');
    slow.open();
    expect((await a).state).toBe('normal');
    const n = f.reads().length;
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('banned');
    expect(f.reads()).toHaveLength(n);
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §11#2] a cached appealing without a processing appeal is re-read; normal or frozen passes', async () => {
  const f = scripted();
  try {
    f.state.row = {
      state: 'appealing',
      reason_category: 'other',
      frozen_until: null,
      row_version: 1,
    };
    f.state.appeal = 'frozen';
    const r = request('/v1/products/search');
    await expect(f.service.checkRequest(r)).resolves.toBeUndefined();
    // The appeal was closed elsewhere: the database says frozen again, the cache still appealing.
    f.state.appeal = null;
    f.state.row = { state: 'frozen', reason_category: 'other', frozen_until: null, row_version: 2 };
    await expect(f.service.checkRequest(r)).resolves.toBeUndefined();
    f.state.row = { state: 'normal', reason_category: null, frozen_until: null, row_version: 3 };
    await expect(f.service.checkRequest(r)).resolves.toBeUndefined();
    // The stale entry was dropped: the next read refills from the database.
    expect((await f.service.readRiskState(SUBJECT)).state).toBe('normal');
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §11#1] GET /v1/me/appeals is on the 10006 whitelist', async () => {
  const f = scripted();
  try {
    f.state.row = { state: 'banned', reason_category: 'other', frozen_until: null, row_version: 0 };
    await expect(f.service.checkRequest(request('/v1/me/appeals'))).resolves.toBeUndefined();
    await expect(
      f.service.checkRequest(request('/v1/me/appeals', 'POST')),
    ).resolves.toBeUndefined();
    await expect(f.service.checkRequest(request('/v1/me/orders'))).rejects.toBeInstanceOf(
      RiskStateBannedException,
    );
  } finally {
    await f.db.destroy();
  }
});

it('[B1-03h §11#4] a change outside the transition table writes and publishes nothing', async () => {
  const f = scripted();
  try {
    f.state.row = { state: 'banned', reason_category: 'other', frozen_until: null, row_version: 2 };
    await expect(
      f.db
        .transaction()
        .execute((trx) =>
          f.service.setRiskState(trx, { ...BAN, state: 'frozen', frozen_until: null }),
        ),
    ).rejects.toBeInstanceOf(RiskStateTransitionError);
    expect(f.statements.some((s) => /^(update|insert)\b/i.test(s))).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
    await f.db
      .transaction()
      .execute((trx) =>
        f.service.setRiskState(trx, { ...BAN, state: 'normal', reason_category: null }),
      );
    expect(f.publish).toHaveBeenCalledTimes(1);
  } finally {
    await f.db.destroy();
  }
});
