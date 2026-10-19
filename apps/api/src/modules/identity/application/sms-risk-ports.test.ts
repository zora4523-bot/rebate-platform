// identity's SMS risk ports and risk's PG-authoritative attempts (B1-11g round 7). The ports are
// checked against a recording risk double; the attempt store runs createSmsRisk over a real Kysely
// (PostgreSQL compiler) whose driver keeps app.sms_send_attempts in memory and serialises the
// advisory lock, so the count, the lock, the window edges and the failure paths are exercised
// without a database (the real PG runs in test/spec/identity/landing-sms/attempts.int.test.ts).
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { DB } from '@couli/db';
import { expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type RedisHandle } from '../../platform/index.ts';
import {
  SMS_ATTEMPT_SEND_BOUND_MS,
  SMS_ATTEMPT_TRANSITIONS,
  SmsAttemptTransitionError,
  canTransitionSmsAttempt,
  createSmsRisk,
  ephemeralSmsRiskIndex,
  transitionSmsAttempt,
  type SmsRisk,
} from '../../risk/index.ts';
import { createSmsRiskPorts } from './sms-risk-ports.ts';
import { SMS_SEND_TIMEOUT_MS, type SmsAttemptGate, type SmsRequest } from './sms-codes.ts';

const IP = '203.0.113.7';
const NOW = '2026-10-18T10:00:00+08:00';
const START = Date.parse(NOW);

function memoryLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

// ---------------------------------------------------------------- ports over a risk double

function ports(overrides: Partial<SmsRisk> = {}) {
  const { logger, lines } = memoryLogger();
  const risk: SmsRisk = {
    admit: vi.fn(async () => ({ code: 0 as const })),
    checkAttempts: vi.fn(async () => ({ code: 0 as const })),
    admitAttempt: vi.fn(async () => ({ code: 0 as const, attemptId: 'a1' })),
    admitDevice: vi.fn(async () => ({ code: 0 as const })),
    finishAttempt: vi.fn(async () => undefined),
    recordAccepted: vi.fn(async () => undefined),
    recordRegistered: vi.fn(async () => undefined),
    ...overrides,
  };
  const created = createSmsRiskPorts({
    risk,
    logger,
    devices: { deviceHashOf: async () => 'ab'.repeat(32) },
  });
  return { ...created, risk, lines };
}

const landing: SmsRequest = {
  app_id: 'couli',
  phone: '13912345678',
  purpose: 'login',
  client_ip: IP,
  channel: 'landing',
};
const app: SmsRequest = {
  app_id: 'couli',
  phone: '13912345678',
  purpose: 'login',
  client_ip: IP,
  device_id: 'd1',
};

it('[AC-B1-11g#1] the identity send bound equals the attempt window bound of risk', () => {
  expect(SMS_ATTEMPT_SEND_BOUND_MS).toBe(SMS_SEND_TIMEOUT_MS);
});

it('[AC-B1-11g#7] landingQuota checks the IP read-only; the gate commits the attempt and its slot writes the outcome', async () => {
  const p = ports();
  const gate = (await p.smsHooks.landingQuota(landing)) as SmsAttemptGate;
  expect(gate.code).toBe(0);
  expect(p.risk.checkAttempts).toHaveBeenCalledExactlyOnceWith({ appId: 'couli', clientIp: IP });
  expect(p.risk.admitAttempt).not.toHaveBeenCalled();
  const slot = await gate.commit();
  expect(p.risk.admitAttempt).toHaveBeenCalledExactlyOnceWith({
    appId: 'couli',
    clientIp: IP,
    phone: landing.phone,
  });
  if (slot.code !== 0) throw new Error('refused');
  await slot.finish('accepted');
  expect(p.risk.finishAttempt).toHaveBeenCalledExactlyOnceWith({
    appId: 'couli',
    attemptId: 'a1',
    outcome: 'accepted',
  });
  expect(p.risk.admit).not.toHaveBeenCalled();
  expect(p.risk.admitDevice).not.toHaveBeenCalled();
});

it('[AC-B1-11g#8] landingQuota passes the IP 42901 through; the gate passes a commit 42901 through; no IP or no attempt port refuses', async () => {
  const limited = ports({
    checkAttempts: vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 601 })),
  });
  expect(await limited.smsHooks.landingQuota(landing)).toEqual({ code: 42901, retryAfterSec: 601 });
  const lost = ports({
    admitAttempt: vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 3611 })),
  });
  const gate = (await lost.smsHooks.landingQuota(landing)) as SmsAttemptGate;
  expect(await gate.commit()).toEqual({ code: 42901, retryAfterSec: 3611 });
  const { client_ip: clientIp, ...withoutIp } = landing;
  void clientIp;
  const p = ports();
  expect(await p.smsHooks.landingQuota(withoutIp)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(p.risk.checkAttempts).not.toHaveBeenCalled();
  const { logger } = memoryLogger();
  const old = createSmsRiskPorts({
    risk: {
      admit: async () => ({ code: 0 }),
      recordAccepted: async () => undefined,
      recordRegistered: async () => undefined,
    },
    logger,
    devices: { deviceHashOf: async () => null },
  });
  expect(await old.smsHooks.landingQuota(landing)).toEqual({ code: 42901, retryAfterSec: 1 });
});

it('[AC-B1-11g#13] the app route checks the IP, then the device, and hands back a gate; refusals write nothing', async () => {
  const p = ports();
  const gate = await p.smsHooks.deviceQuota(app);
  expect(gate).toMatchObject({ code: 0 });
  expect(p.risk.checkAttempts).toHaveBeenCalledExactlyOnceWith({ appId: 'couli', clientIp: IP });
  expect(p.risk.admitDevice).toHaveBeenCalledExactlyOnceWith({
    appId: 'couli',
    deviceHash: 'ab'.repeat(32),
    phone: app.phone,
  });
  expect(p.risk.admitAttempt).not.toHaveBeenCalled();
  expect(p.risk.admit).not.toHaveBeenCalled();

  const ipLimited = ports({
    checkAttempts: vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 16 })),
  });
  expect(await ipLimited.smsHooks.deviceQuota(app)).toEqual({ code: 42901, retryAfterSec: 16 });
  expect(ipLimited.risk.admitDevice).not.toHaveBeenCalled();

  const deviceLimited = ports({
    admitDevice: vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 3601 })),
  });
  expect(await deviceLimited.smsHooks.deviceQuota(app)).toEqual({
    code: 42901,
    retryAfterSec: 3601,
  });
  expect(deviceLimited.risk.admitAttempt).not.toHaveBeenCalled();
});

it('[AC-B1-11g#13] without a client IP, or with a risk port built before attempts, the app route uses admit()', async () => {
  const p = ports();
  const { client_ip: clientIp, ...inProcess } = app;
  void clientIp;
  expect(await p.smsHooks.deviceQuota(inProcess)).toBeNull();
  expect(p.risk.admit).toHaveBeenCalledOnce();
  expect(p.risk.checkAttempts).not.toHaveBeenCalled();
  const { logger } = memoryLogger();
  const admit = vi.fn(async () => ({ code: 0 as const }));
  const old = createSmsRiskPorts({
    risk: { admit, recordAccepted: async () => undefined, recordRegistered: async () => undefined },
    logger,
    devices: { deviceHashOf: async () => 'cd'.repeat(32) },
  });
  expect(await old.smsHooks.deviceQuota(app)).toBeNull();
  expect(admit).toHaveBeenCalledOnce();
});

it('[AC-B1-11g#19] afterAccepted keeps the two-argument recordAccepted', async () => {
  const p = ports();
  await p.smsHooks.afterAccepted(landing);
  expect(p.risk.recordAccepted).toHaveBeenLastCalledWith({ appId: 'couli', clientIp: IP });
});

// ---------------------------------------------------------------- the attempt store

interface Row {
  app_id: string;
  attempt_id: string;
  ip_hmac: string;
  phone_hmac: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/** An in-memory app.sms_send_attempts behind the PostgreSQL compiler, with an advisory lock. */
function memoryDb() {
  const rows: Row[] = [];
  const locks = new Map<string, Promise<void>>();
  const faults = { insert: 0, update: 0, updates: 0, lostReply: 0, reads: 0 };
  class Connection implements DatabaseConnection {
    private releases: (() => void)[] = [];
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const text = query.sql;
      const p = query.parameters as unknown[];
      if (text.startsWith('SELECT pg_advisory_xact_lock')) {
        const key = String(p[0]);
        const held = locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((resolve) => (release = resolve));
        locks.set(
          key,
          held.then(() => next),
        );
        await held;
        this.releases.push(release);
        return { rows: [] };
      }
      if (text.startsWith('select "created_at" from "app"."sms_send_attempts"')) {
        const [appId, ipHmac, s1, s2, s3, from, windowMs, high] = p as [
          string,
          string,
          string,
          string,
          string,
          Date,
          number,
          Date,
        ];
        // created_at >= $6::timestamptz - $7 ms (the window's lower edge, both ends closed).
        expect(text).toContain(
          `"created_at" >= $6::timestamptz - $7::float8 * interval '1 millisecond'`,
        );
        const low = from.getTime() - windowMs;
        const found = rows
          .filter(
            (row) =>
              row.app_id === appId &&
              row.ip_hmac === ipHmac &&
              [s1, s2, s3].includes(row.status) &&
              row.created_at.getTime() >= low &&
              row.created_at <= high,
          )
          .sort((x, y) => x.created_at.getTime() - y.created_at.getTime())
          .map((row) => ({ created_at: row.created_at }));
        return { rows: found as R[] };
      }
      if (text.startsWith('insert into "app"."sms_send_attempts"')) {
        if (faults.insert > 0) {
          faults.insert--;
          throw Object.assign(new Error('connection lost'), { code: '08006' });
        }
        const [app_id, attempt_id, ip_hmac, phone_hmac, status, created_at, updated_at] = p as [
          string,
          string,
          string,
          string,
          string,
          Date,
          Date,
        ];
        rows.push({ app_id, attempt_id, ip_hmac, phone_hmac, status, created_at, updated_at });
        return { rows: [] };
      }
      if (text.startsWith('update "app"."sms_send_attempts"')) {
        faults.updates++;
        if (faults.update > 0) {
          faults.update--;
          throw Object.assign(new Error('connection lost'), { code: '08006' });
        }
        const [status, updated, appId, attemptId, from] = p as [
          string,
          Date,
          string,
          string,
          string,
        ];
        // The UPDATE keeps app_id and the source status in its WHERE clause.
        expect(text).toContain(`where "app_id" = $3 and "attempt_id" = $4 and "status" = $5`);
        let changed = 0n;
        for (const row of rows) {
          if (row.app_id === appId && row.attempt_id === attemptId && row.status === from) {
            row.status = status;
            row.updated_at = updated;
            changed++;
          }
        }
        if (faults.lostReply > 0) {
          faults.lostReply--;
          throw Object.assign(new Error('connection lost after commit'), { code: '08006' });
        }
        return { rows: [], numAffectedRows: changed };
      }
      if (text.startsWith('select "status" from "app"."sms_send_attempts"')) {
        faults.reads++;
        const [appId, attemptId] = p as [string, string];
        const found = rows
          .filter((row) => row.app_id === appId && row.attempt_id === attemptId)
          .map((row) => ({ status: row.status }));
        return { rows: found as R[] };
      }
      throw new Error(`unexpected query: ${text}`);
    }
    async *streamQuery(): AsyncIterableIterator<never> {
      throw new Error('no streaming');
    }
    end(): void {
      for (const release of this.releases.splice(0)) release();
    }
  }
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => new Connection(),
    beginTransaction: async () => undefined,
    commitTransaction: async (connection) => (connection as Connection).end(),
    rollbackTransaction: async (connection) => (connection as Connection).end(),
    releaseConnection: async (connection) => (connection as Connection).end(),
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, rows, faults };
}

/** Redis double for the registration item: a fixed wait in ms, or a failing store. */
function registrationRedis(answer: number | 'down'): RedisHandle {
  const fail = () => Promise.reject(new Error('unused'));
  return {
    namespace: () => ({
      get: fail,
      set: fail,
      eval: () =>
        answer === 'down'
          ? Promise.reject(Object.assign(new Error(`down ${IP}`), { reason: 'command_failed' }))
          : Promise.resolve(answer),
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } as unknown as RedisHandle;
}

function store(limit = 3, redis: RedisHandle | null = registrationRedis(0)) {
  const memory = memoryDb();
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger();
  const risk = createSmsRisk({
    clock,
    logger,
    redis,
    config: {
      configValue: async (_appId: string, key: string) =>
        key === 'sms.ip_sends_per_hour' ? { value: limit, version: 1 } : null,
    },
    crypto: ephemeralSmsRiskIndex(),
    db: memory.db,
  });
  const input = { appId: 'couli', clientIp: IP, phone: '13912345678' };
  return { ...memory, clock, risk, input, lines };
}

it('[AC-B1-11g#58] admitAttempt commits a pending row (UUIDv7, keyed hex digests, Clock time); checkAttempts writes nothing', async () => {
  const s = store();
  expect(await s.risk.checkAttempts(s.input)).toEqual({ code: 0 });
  expect(s.rows).toEqual([]);
  const admitted = await s.risk.admitAttempt(s.input);
  expect(admitted).toMatchObject({ code: 0 });
  expect(s.rows).toHaveLength(1);
  const row = s.rows[0]!;
  expect(row).toMatchObject({ app_id: 'couli', status: 'pending' });
  expect(row.attempt_id).toBe((admitted as { attemptId: string }).attemptId);
  expect(row.attempt_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  expect(row.ip_hmac).toMatch(/^[a-f0-9]{32,128}$/);
  expect(row.phone_hmac).toMatch(/^[a-f0-9]{32,128}$/);
  expect(JSON.stringify(s.rows)).not.toContain(IP);
  expect(JSON.stringify(s.rows)).not.toContain('13912345678');
  expect(row.created_at.getTime()).toBe(START);
});

it('[AC-B1-11g#58] with N−1 counted rows, concurrent commits admit exactly one (the advisory lock)', async () => {
  const s = store(3);
  await s.risk.admitAttempt(s.input);
  await s.risk.admitAttempt(s.input);
  const results = await Promise.all(Array.from({ length: 4 }, () => s.risk.admitAttempt(s.input)));
  expect(results.filter((r) => r.code === 0)).toHaveLength(1);
  expect(results.filter((r) => r.code === 42901)).toEqual(
    Array.from({ length: 3 }, () => ({ code: 42901, retryAfterSec: 3611 })),
  );
  expect(s.rows).toHaveLength(3);
});

it('[AC-B1-11g#56] pending, accepted and unknown count; failed does not', async () => {
  const s = store(2);
  const first = await s.risk.admitAttempt(s.input);
  await s.risk.finishAttempt({
    appId: 'couli',
    attemptId: (first as { attemptId: string }).attemptId,
    outcome: 'failed',
  });
  expect(s.rows.map((row) => row.status)).toEqual(['failed']);
  expect(await s.risk.checkAttempts(s.input)).toEqual({ code: 0 });
  for (const outcome of ['unknown', 'accepted'] as const) {
    const next = await s.risk.admitAttempt(s.input);
    await s.risk.finishAttempt({
      appId: 'couli',
      attemptId: (next as { attemptId: string }).attemptId,
      outcome,
    });
  }
  expect(s.rows.map((row) => row.status)).toEqual(['failed', 'unknown', 'accepted']);
  expect(await s.risk.checkAttempts(s.input)).toEqual({ code: 42901, retryAfterSec: 3611 });
  expect(await s.risk.admitAttempt(s.input)).toEqual({ code: 42901, retryAfterSec: 3611 });
});

for (const [advance, admitted] of [
  [3_609_999, false],
  [3_610_000, false],
  [3_610_001, true],
] as const) {
  it(`[AC-B1-11g#59] the window is [now − 3600 s − send bound, now]: first row aged ${advance} ms`, async () => {
    const s = store(1);
    await s.risk.admitAttempt(s.input);
    s.clock.advanceMs(advance);
    expect(await s.risk.checkAttempts(s.input)).toEqual(
      admitted ? { code: 0 } : { code: 42901, retryAfterSec: 1 },
    );
    expect((await s.risk.admitAttempt(s.input)).code).toBe(admitted ? 0 : 42901);
    expect(s.rows).toHaveLength(admitted ? 2 : 1);
  });
}

it('[AC-B1-11g#62] Retry-After is the (N−L+1)-th oldest counted row leaving the window', async () => {
  const s = store(2);
  await s.risk.admitAttempt(s.input);
  s.clock.set(new Date(START + 100_000));
  await s.risk.admitAttempt(s.input);
  expect(await s.risk.checkAttempts(s.input)).toEqual({ code: 42901, retryAfterSec: 3511 });
});

it('[AC-B1-11g#64] a failing outcome write is retried once, then the row stays pending and counts', async () => {
  const s = store(1);
  const admitted = await s.risk.admitAttempt(s.input);
  s.faults.update = 2;
  await s.risk.finishAttempt({
    appId: 'couli',
    attemptId: (admitted as { attemptId: string }).attemptId,
    outcome: 'failed',
  });
  expect(s.faults.updates).toBe(2);
  expect(s.rows.map((row) => row.status)).toEqual(['pending']);
  s.clock.advanceMs(60_001);
  expect(await s.risk.checkAttempts(s.input)).toEqual({ code: 42901, retryAfterSec: 3550 });
  expect(s.lines.join('')).not.toContain(IP);
});

it('[AC-B1-11g#28] PG failing or missing refuses (42901, 1 s) and writes nothing', async () => {
  const s = store();
  s.faults.insert = 1;
  expect(await s.risk.admitAttempt(s.input)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(s.rows).toEqual([]);
  expect(await s.risk.admitAttempt(s.input)).toMatchObject({ code: 0 });
  expect(s.lines.join('')).not.toContain(IP);
  const { logger } = memoryLogger();
  const without = createSmsRisk({
    clock: s.clock,
    logger,
    redis: null,
    config: { configValue: async () => null },
    crypto: ephemeralSmsRiskIndex(),
  });
  expect(await without.checkAttempts(s.input)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(await without.admitAttempt(s.input)).toEqual({ code: 42901, retryAfterSec: 1 });
});

it('[AC-B1-11g#40] the registration item joins checkAttempts (later release wins)', async () => {
  const reached = store(1, registrationRedis(600_500));
  expect(await reached.risk.checkAttempts(reached.input)).toEqual({
    code: 42901,
    retryAfterSec: 601,
  });
  await reached.risk.admitAttempt(reached.input);
  expect(await reached.risk.checkAttempts(reached.input)).toEqual({
    code: 42901,
    retryAfterSec: 3611,
  });
});

it('[AC-B1-11g#72] the registration item failing or missing refuses (42901, 1 s), never read as 0; nothing is written', async () => {
  const down = store(3, registrationRedis('down'));
  expect(await down.risk.checkAttempts(down.input)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(await down.risk.checkAttempts(down.input)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(down.rows).toEqual([]);
  const text = down.lines.join('');
  expect(text).toContain('sms_risk_registrations_unreadable');
  // One error per outage, as admit's store failures.
  expect(down.lines.filter((line) => line.includes('sms_risk_store_unavailable'))).toHaveLength(1);
  expect(text).not.toContain(IP);
  expect(text).not.toContain('13912345678');

  const malformed = store(3, registrationRedis(-1));
  expect(await malformed.risk.checkAttempts(malformed.input)).toEqual({
    code: 42901,
    retryAfterSec: 1,
  });
  const noRedis = store(3, null);
  expect(await noRedis.risk.checkAttempts(noRedis.input)).toEqual({
    code: 42901,
    retryAfterSec: 1,
  });
  expect(noRedis.rows).toEqual([]);
});

it('[AC-B1-11g#72] the landing and app ports pass the registration refusal through and never commit an attempt', async () => {
  const down = store(3, registrationRedis('down'));
  const { logger } = memoryLogger();
  const built = createSmsRiskPorts({
    risk: down.risk,
    devices: { deviceHashOf: async () => 'ab'.repeat(32) },
    logger,
  });
  expect(await built.smsHooks.landingQuota(landing)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(await built.smsHooks.deviceQuota(app)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(down.rows).toEqual([]);
});

it('[AC-B1-11g#69] the attempt transition table: pending → accepted | failed | unknown; the three are final', () => {
  expect(SMS_ATTEMPT_TRANSITIONS).toEqual({
    pending: ['accepted', 'failed', 'unknown'],
    accepted: [],
    failed: [],
    unknown: [],
  });
  const statuses = ['pending', 'accepted', 'failed', 'unknown'] as const;
  for (const from of statuses) {
    for (const to of statuses) {
      const legal = from === 'pending' && to !== 'pending';
      expect(canTransitionSmsAttempt(from, to), `${from} → ${to}`).toBe(legal);
      if (legal) expect(transitionSmsAttempt(from, to)).toBe(to);
      else expect(() => transitionSmsAttempt(from, to)).toThrow(SmsAttemptTransitionError);
    }
  }
  for (const bad of [null, undefined, 'failed_rejected', 'toString', '__proto__', 1]) {
    expect(canTransitionSmsAttempt('pending', bad)).toBe(false);
    expect(canTransitionSmsAttempt(bad, 'accepted')).toBe(false);
  }
});

it('[AC-B1-11g#69] finishAttempt refuses an outcome not reachable from pending before any write', async () => {
  const s = store(2);
  const admitted = (await s.risk.admitAttempt(s.input)) as { attemptId: string };
  for (const outcome of ['pending', 'failed_rejected', 'toString']) {
    await expect(
      Reflect.apply(s.risk.finishAttempt, s.risk, [
        { appId: 'couli', attemptId: admitted.attemptId, outcome },
      ]),
    ).rejects.toBeInstanceOf(SmsAttemptTransitionError);
  }
  expect(s.faults.updates).toBe(0);
  expect(s.rows.map((row) => row.status)).toEqual(['pending']);
});

for (const [index, final] of (['accepted', 'failed', 'unknown'] as const).entries()) {
  it(`[AC-B1-11g#${69 + index}] a ${final} attempt is final: a repeated completion is a no-op, another outcome throws, nothing changes`, async () => {
    const s = store(2);
    const admitted = (await s.risk.admitAttempt(s.input)) as { attemptId: string };
    const finish = (outcome: 'accepted' | 'failed' | 'unknown') =>
      s.risk.finishAttempt({ appId: 'couli', attemptId: admitted.attemptId, outcome });
    await finish(final);
    const decided = structuredClone(s.rows);
    expect(decided.map((row) => row.status)).toEqual([final]);
    s.clock.advanceMs(1_000);
    await expect(finish(final)).resolves.toBeUndefined();
    for (const other of (['accepted', 'failed', 'unknown'] as const).filter((o) => o !== final)) {
      await expect(finish(other)).rejects.toMatchObject({
        name: 'SmsAttemptTransitionError',
        from: final,
        to: other,
      });
    }
    expect(s.rows).toEqual(decided);
    expect(s.lines.join('')).toContain('sms_attempt_transition_refused');
    // Concurrent completions of one pending attempt: exactly one outcome lands.
    const t = store(2);
    const next = (await t.risk.admitAttempt(t.input)) as { attemptId: string };
    const settled = await Promise.allSettled(
      (['accepted', 'failed', 'unknown'] as const).map((outcome) =>
        t.risk.finishAttempt({ appId: 'couli', attemptId: next.attemptId, outcome }),
      ),
    );
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.status).not.toBe('pending');
  });
}

it('[AC-B1-11g#64] a lost reply of a committed outcome write is retried: the row is decided, the retry is a no-op', async () => {
  const s = store(2);
  const admitted = (await s.risk.admitAttempt(s.input)) as { attemptId: string };
  s.faults.lostReply = 1;
  await s.risk.finishAttempt({
    appId: 'couli',
    attemptId: admitted.attemptId,
    outcome: 'accepted',
  });
  expect(s.faults.updates).toBe(2);
  expect(s.faults.reads).toBe(1);
  expect(s.rows.map((row) => row.status)).toEqual(['accepted']);
});

it('[AC-B1-11g#69] finishAttempt on a missing attempt throws and writes nothing', async () => {
  const s = store(2);
  await expect(
    s.risk.finishAttempt({
      appId: 'couli',
      attemptId: '0192f3b0-0000-7000-8000-000000000000',
      outcome: 'accepted',
    }),
  ).rejects.toMatchObject({ name: 'SmsAttemptTransitionError', from: null, to: 'accepted' });
  expect(s.rows).toEqual([]);
});
