// Unit tests of the landing registration service (B1-11h): Kysely queries are compiled against an
// in-memory driver (no socket, no database); idempotency, SMS, registration, growth's port and the
// blocklist are fakes. The rule tests (test/spec/growth/landing-register) run it on PostgreSQL.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Transaction,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createRootLogger,
  FixedClock,
  type HandlerResult,
  type IdempotentRequest,
  type Idempotency,
} from '../../platform/index.ts';
import type {
  LandingInviteBindInput,
  LandingInvitePort,
  LandingInvitePrecheck,
  LandingInvitePrecheckInput,
} from '../ports/landing-invite.ts';
import {
  createLandingRegisterService,
  LANDING_REGISTER_PATH,
  LANDING_REGISTRATIONS_IP_CONTEXT,
  type LandingRegisterCommand,
  type LandingRegisterOptions,
} from './landing-register.ts';
import type { RegistrationCommand, RegistrationResult } from './registration.ts';

const NOW = '2026-10-18T02:00:00.000Z';
const APP = 'couli';
const PHONE = '13912345678';
const USER = '019a0000-0000-7000-8000-00000000000a';
const INVITER = '019a0000-0000-7000-8000-00000000000b';
const IP = '203.0.113.88';
const KEY = 'key-b1-11h-0001';
const TRACE = 'trace-b1-11h';
const blindIndex = (value: string, context: string) =>
  Buffer.from(`${context}|${value}`).toString('hex').padEnd(64, '0').slice(0, 64);
const PHONE_HMAC = blindIndex(PHONE, 'users.phone');

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

async function fixture() {
  const world = { held: [false, false], count: 0 };
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const text = query.sql;
    const rows = (value: unknown[]) => ({ rows: value as R[] });
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /.test(text)) return rows([]);
    if (text.startsWith('SELECT pg_advisory_xact_lock(')) return rows([{}]);
    if (text.startsWith('select "id" from "app"."users"')) {
      return rows(world.held.shift() === true ? [{ id: 'existing' }] : []);
    }
    if (text.includes('from "app"."landing_registrations"')) {
      return rows([{ count: String(world.count) }]);
    }
    if (/^insert into "app"\."(consent_records|landing_registrations)"/.test(text)) {
      return { rows: [] as R[], numAffectedRows: 1n };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  handles.push(db);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const values = new Map<string, unknown>([
    ['legal.agreement.version', 7],
    ['legal.privacy.version', 11],
  ]);
  const requests: IdempotentRequest[] = [];
  const results: HandlerResult[] = [];
  const idempotency: Pick<Idempotency, 'executeInTransaction'> = {
    async executeInTransaction(request, handler) {
      requests.push(request);
      if (request.key === undefined) {
        return { status: 400, body: '{"code":20001}', source: 'idempotency' };
      }
      const result = await db.transaction().execute((trx) => handler(trx));
      results.push(result);
      return { status: result.status, body: JSON.stringify(result.envelope), source: 'handler' };
    },
  };
  const precheck = vi.fn<(input: LandingInvitePrecheckInput) => LandingInvitePrecheck>(() => ({
    ok: true,
    inviter_id: INVITER,
  }));
  const bindResult = { value: 'bound' as 'bound' | 30401 | 50001 };
  const binds: LandingInviteBindInput[] = [];
  const invite: LandingInvitePort = {
    precheck: async (_trx, input) => precheck(input),
    async bind(_trx, input) {
      binds.push(input);
      return bindResult.value === 'bound'
        ? { result: 'bound', parent_id: INVITER, bound_at: new FixedClock(NOW).now() }
        : { result: 'failed', code: bindResult.value };
    },
  };
  const sms = { verifyAndConsume: vi.fn(async () => ({ code: 0 as 0 | 20002 | 20003 })) };
  const registered: RegistrationCommand[] = [];
  const registration = {
    answer: { code: 0, user_id: USER, invite_code: 'AAAAAA', attr_code: 'a' } as RegistrationResult,
    async register(_trx: Transaction<DB>, command: RegistrationCommand) {
      registered.push(command);
      return this.answer;
    },
  };
  const recordHits = vi.fn(async () => ({ ref_id: 'ref' }));
  const blocklist = {
    hit: false,
    async matchRegistration() {
      return this.hit
        ? {
            code: 44001 as const,
            data: { risk_msg_code: 'blocklist.other' },
            hits: [{ dimension: 'phone', value_hmac: PHONE_HMAC, rule_id: 'BLACKLIST_PHONE' }],
          }
        : null;
    },
    recordHits,
  };
  const configValue = vi.fn(async (_app: string, key: string) =>
    values.has(key) ? { value: values.get(key), version: 1 } : null,
  );
  const options: LandingRegisterOptions = {
    db,
    clock: new FixedClock(NOW),
    crypto: { blindIndex },
    logger,
    idempotency,
    sms,
    registration,
    registrationConfig: { configValue: async () => null },
    config: { configValue },
    invite,
    blocklist,
  };
  const service = createLandingRegisterService(options);
  const command: LandingRegisterCommand = {
    app_id: APP,
    body: { phone: `+86 ${PHONE}`, sms_code: '246810', invite_code: ' k7q2mz ', agreed: true },
    client_ip: IP,
    idempotency_key: KEY,
    trace_id: TRACE,
  };
  return {
    world,
    queries,
    lines,
    values,
    requests,
    results,
    precheck,
    bindResult,
    binds,
    sms,
    registered,
    registration,
    blocklist,
    recordHits,
    configValue,
    register: (overrides: Partial<LandingRegisterCommand> = {}) =>
      service.register({ ...command, ...overrides }),
    body: command.body,
    texts: () => queries.map((q) => q.sql),
  };
}

it('[AC-B1-11h#5] agreed=false answers 10004 before the phone, the configuration and idempotency', async () => {
  const f = await fixture();
  const answer = await f.register({ body: { ...f.body, agreed: false, phone: 'invalid' } });
  expect(answer).toEqual({
    kind: 'refused',
    status: 403,
    envelope: {
      code: 10004,
      msg: expect.any(String),
      data: { consent_type: 'agreement' },
      trace_id: TRACE,
    },
  });
  expect(f.configValue).not.toHaveBeenCalled();
  expect(f.requests).toEqual([]);
});

it('[AC-B1-11h#6] an invalid phone answers 20001 phone_invalid before idempotency', async () => {
  const f = await fixture();
  const answer = await f.register({ body: { ...f.body, phone: '12345' } });
  expect(answer).toMatchObject({
    kind: 'refused',
    status: 400,
    envelope: { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } },
  });
  expect(f.requests).toEqual([]);
});

it('[AC-B1-11h#20] a missing or malformed legal version answers 50001 before idempotency', async () => {
  for (const value of [undefined, 0, -1, 1.5, '7', null]) {
    const f = await fixture();
    if (value === undefined) f.values.delete('legal.privacy.version');
    else f.values.set('legal.privacy.version', value);
    expect(await f.register()).toMatchObject({
      kind: 'refused',
      status: 500,
      envelope: { code: 50001, trace_id: TRACE },
    });
    expect(f.requests).toEqual([]);
    expect(f.sms.verifyAndConsume).not.toHaveBeenCalled();
  }
});

it('[AC-B1-11h#19] idempotency subject p:<phone_hmac> of the normalised phone, keyed digest', async () => {
  const f = await fixture();
  await f.register();
  expect(f.requests).toEqual([
    {
      appId: APP,
      actor: { userId: null, deviceId: null, phoneHmac: PHONE_HMAC },
      method: 'POST',
      path: LANDING_REGISTER_PATH,
      key: KEY,
      body: f.body,
      traceId: TRACE,
      keyedRequestDigest: true,
    },
  ]);
  // A missing key is the idempotency module's 20001: the handler never runs.
  const g = await fixture();
  expect(await g.register({ idempotency_key: undefined })).toEqual({
    kind: 'response',
    status: 400,
    body: '{"code":20001}',
  });
  expect(g.precheck).not.toHaveBeenCalled();
});

it('[AC-B1-11h#2] registered: one savepoint, IP lock before the count, consents, binding, row', async () => {
  const f = await fixture();
  const answer = await f.register({ header_channel: 'appstore' });
  expect(answer).toEqual({
    kind: 'response',
    status: 200,
    body: JSON.stringify({ code: 0, msg: '', data: { result: 'registered' }, trace_id: TRACE }),
  });
  const texts = f.texts();
  expect(texts[0]).toMatch(/^SAVEPOINT identity_landing_register$/);
  expect(texts.at(-1)).toMatch(/^RELEASE SAVEPOINT identity_landing_register$/);
  const lock = texts.findIndex((t) => t.startsWith('SELECT pg_advisory_xact_lock('));
  const count = texts.findIndex((t) => t.includes('"app"."landing_registrations" where'));
  expect(lock).toBeGreaterThan(0);
  expect(count).toBeGreaterThan(lock);
  expect(f.queries[lock]!.parameters).toEqual([
    `identity.landing_registrations:${APP}:${blindIndex(IP, LANDING_REGISTRATIONS_IP_CONTEXT)}`,
  ]);
  expect(f.registered).toEqual([
    {
      app_id: APP,
      phone: PHONE,
      register_method: 'h5_landing',
      channel: 'appstore',
      client_ip: IP,
      config: expect.anything(),
    },
  ]);
  const consents = f.queries.find((q) => q.sql.startsWith('insert into "app"."consent_records"'))!;
  expect(consents.parameters).toEqual(
    expect.arrayContaining(['agreement', 7, 'privacy', 11, 'h5_landing', USER]),
  );
  expect(f.binds).toEqual([
    {
      app_id: APP,
      user_id: USER,
      inviter_id: INVITER,
      phone_hmac: PHONE_HMAC,
      client_ip: IP,
      attempt_key: KEY,
    },
  ]);
  expect(texts.some((t) => t.startsWith('insert into "app"."landing_registrations"'))).toBe(true);
  expect(f.sms.verifyAndConsume).toHaveBeenCalledWith({
    app_id: APP,
    phone: PHONE,
    purpose: 'login',
    code: '246810',
  });
  for (const secret of [PHONE, PHONE_HMAC, IP, '246810', 'K7Q2MZ', 'k7q2mz']) {
    expect(f.lines.join('')).not.toContain(secret);
  }
});

it('[AC-B1-11h#3] the body channel wins over X-Channel; neither leaves the channel out', async () => {
  const f = await fixture();
  await f.register({ body: { ...f.body, channel: 'official' }, header_channel: 'appstore' });
  await f.register();
  expect(f.registered.map((c) => c.channel)).toEqual(['official', undefined]);
});

it('[AC-B1-11h#9] precheck refusals answer their codes without the SMS code or a savepoint', async () => {
  for (const [refusal, status] of [
    [{ ok: false, code: 30408 }, 422],
    [{ ok: false, code: 30401 }, 422],
    [{ ok: false, code: 50001 }, 500],
    [{ ok: false, code: 42901, retry_after_seconds: 29.2 }, 429],
  ] as const) {
    const f = await fixture();
    f.precheck.mockReturnValue(refusal);
    const answer = await f.register();
    expect(answer).toMatchObject({ kind: 'response', status });
    if (refusal.code === 42901) expect(answer).toMatchObject({ retryAfter: 30 });
    else expect(answer).not.toHaveProperty('retryAfter');
    expect(f.sms.verifyAndConsume).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  }
});

it('[AC-B1-11h#13] a wrong or expired SMS code answers 20002 / 20003 before any account step', async () => {
  for (const code of [20002, 20003] as const) {
    const f = await fixture();
    f.sms.verifyAndConsume.mockResolvedValue({ code });
    expect(await f.register()).toMatchObject({ kind: 'response', status: 400 });
    expect(f.queries).toEqual([]);
  }
});

it('[AC-B1-11h#14] already registered: rolled back to the savepoint, no blocklist or IP lock', async () => {
  const f = await fixture();
  f.world.held = [true];
  f.blocklist.hit = true;
  const answer = await f.register();
  expect(answer).toMatchObject({
    status: 200,
    body: expect.stringContaining('"result":"already_registered"'),
  });
  expect(f.texts().some((t) => t.startsWith('SELECT pg_advisory_xact_lock('))).toBe(false);
  expect(f.texts().at(-1)).toMatch(/^RELEASE SAVEPOINT/);
  expect(f.texts()).toContain('ROLLBACK TO SAVEPOINT identity_landing_register');
  expect(f.registered).toEqual([]);
  expect(f.recordHits).not.toHaveBeenCalled();
});

it('[AC-B1-11h#26] the phone held after the IP lock, or phone_taken, is already_registered', async () => {
  const f = await fixture();
  f.world.held = [false, true];
  expect(await f.register()).toMatchObject({ body: expect.stringContaining('already_registered') });
  expect(f.registered).toEqual([]);
  const g = await fixture();
  g.registration.answer = { outcome: 'phone_taken' };
  expect(await g.register()).toMatchObject({ body: expect.stringContaining('already_registered') });
  expect(g.binds).toEqual([]);
  expect(g.texts()).toContain('ROLLBACK TO SAVEPOINT identity_landing_register');
});

it('[AC-B1-11h#16] a blocklisted phone answers 44001 before the IP lock; the hit recorded after', async () => {
  const f = await fixture();
  f.blocklist.hit = true;
  const answer = await f.register();
  expect(answer).toMatchObject({ kind: 'response', status: 403 });
  if (answer.kind !== 'response') throw new Error('unreachable');
  expect(JSON.parse(answer.body)).toMatchObject({
    code: 44001,
    data: { risk_msg_code: 'blocklist.other' },
  });
  expect(f.texts().some((t) => t.startsWith('SELECT pg_advisory_xact_lock('))).toBe(false);
  expect(f.recordHits).toHaveBeenCalledWith(
    { app_id: APP, request_type: 'register', related_phone: PHONE },
    [{ dimension: 'phone', value_hmac: PHONE_HMAC, rule_id: 'BLACKLIST_PHONE' }],
  );
  expect(f.registered).toEqual([]);
});

it('[AC-B1-11h#17] the IP count at the limit answers 44001 with risk_msg_code null', async () => {
  const f = await fixture();
  f.world.count = 3;
  const answer = await f.register();
  if (answer.kind !== 'response') throw new Error('unreachable');
  expect(answer.status).toBe(403);
  expect(JSON.parse(answer.body)).toMatchObject({ code: 44001, data: { risk_msg_code: null } });
  expect(f.registered).toEqual([]);
  const g = await fixture();
  g.values.set('landing.ip_register_limit', 4);
  g.world.count = 3;
  expect(await g.register()).toMatchObject({ status: 200 });
});

it('[AC-B1-11h#21] a malformed IP limit falls back to 3 with a warning naming the key only', async () => {
  for (const value of [0, -1, 1.5, '3']) {
    const f = await fixture();
    f.values.set('landing.ip_register_limit', value);
    f.world.count = 3;
    expect(await f.register()).toMatchObject({ status: 403 });
    const warnings = f.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['level'] === 40);
    expect(warnings).toEqual([
      expect.objectContaining({ app_id: APP, config_key: 'landing.ip_register_limit' }),
    ]);
  }
});

it('[AC-B1-11h#24] a failed binding rolls the account back to the savepoint and answers its code', async () => {
  for (const [code, status] of [
    [30401, 422],
    [50001, 500],
  ] as const) {
    const f = await fixture();
    f.bindResult.value = code;
    expect(await f.register()).toMatchObject({ status });
    expect(f.texts()).toContain('ROLLBACK TO SAVEPOINT identity_landing_register');
    expect(f.texts().some((t) => t.startsWith('insert into "app"."landing_registrations"'))).toBe(
      false,
    );
  }
});

it('[AC-B1-11h#23] a registration core 50001 is answered 50001 after the rollback', async () => {
  const f = await fixture();
  f.registration.answer = { code: 50001 };
  expect(await f.register()).toMatchObject({ status: 500 });
  expect(f.binds).toEqual([]);
  expect(f.texts()).toContain('ROLLBACK TO SAVEPOINT identity_landing_register');
});
