// HTTP kit of B1-20a (POST /v1/me/phone, first binding; 规划/08 BR-ID-06, 04 §6.1).
// The real AppModule with real guards, PG and Redis. Two seams only, both installed while the app
// is built and restored right after init:
//   - IdentityModule.forRoot: the assembled `accountAssets` port is wrapped, so a test can report a
//     claim or a ledger entry (those modules do not exist yet; their real answer is "none");
//   - createRedisHandle: the real handle is wrapped, so a test can make the `merge_ticket`
//     namespace unavailable while every other namespace (SMS codes, nonces) keeps working.
// Every apps/api module is imported dynamically; static imports are types only.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type {
  AccountAssetsPort,
  AccountRef,
} from '../../../../apps/api/src/modules/identity/application/bind-phone.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { SmsCodeService } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import type {
  FieldCrypto,
  RedisHandle,
  RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { RiskStateService } from '../../../../apps/api/src/modules/risk/index.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import { seedUser } from '../registration/kit.ts';
import { openSuite, closeSuite, type Suite } from '../session/kit.ts';
import { buildApp, outbox, type HttpApp, type Response } from '../sms-codes/http-kit.ts';
import { memoryLogger, phone } from '../sms-codes/kit.ts';

export const PATH = '/v1/me/phone';
export const INSTANT = '2026-10-16T02:00:00.000Z';
/** Redis namespace of merge tickets: keys are `merge_ticket:<SHA-256 hex of the ticket>`. */
export const TICKET_NAMESPACE = 'merge_ticket';
export const TICKET_TTL_MS = 300_000;
/** users.phone_cipher / users.phone_hmac context (domain/registration.ts). */
export const PHONE_CONTEXT = 'users.phone';

type ClockModule = typeof import('../../../../apps/api/src/modules/platform/clock/index.ts');
type RedisModule = typeof import('../../../../apps/api/src/modules/platform/redis/index.ts');
type PlatformModule = typeof import('../../../../apps/api/src/modules/platform/index.ts');
type ValidatorModule =
  typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
type SessionsModule =
  typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
type Clock = InstanceType<ClockModule['FixedClock']>;
type Contract = {
  paths: Record<
    string,
    Record<
      string,
      {
        'x-implementation'?: string;
        responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
      }
    >
  >;
};
type FactoryOption = { useFactory(...args: unknown[]): unknown; inject?: unknown[] };
type ForRoot = (options: Record<string, unknown>) => unknown;

/** Switches the tests flip; reset by every fixture. */
export interface Faults {
  ticketStore: boolean;
  claims: boolean;
  ledger: boolean;
}

export interface Kit {
  suite: Suite;
  app: HttpApp;
  dir: string;
  clock: Clock;
  document: Contract;
  compile: ReturnType<ValidatorModule['createValidatorCompiler']>;
  lines: string[];
  faults: Faults;
  crypto: FieldCrypto;
  redis: RedisHandle;
  sms: SmsCodeService;
  tokens: TokenService;
  risk: RiskStateService;
  createSession: SessionsModule['createSession'];
}

function faultyNamespace(
  real: RedisNamespace,
  faults: Faults,
  unavailable: RedisModule['RedisUnavailableError'],
): RedisNamespace {
  const fail = () => Promise.reject(new unavailable('command_failed'));
  return Object.freeze({
    get: (key: string) => (faults.ticketStore ? fail() : real.get(key)),
    set: (key: string, value: string, ttl: number) =>
      faults.ticketStore ? fail() : real.set(key, value, ttl),
    eval: (script: string, options: Parameters<RedisNamespace['eval']>[1]) =>
      faults.ticketStore ? fail() : real.eval(script, options),
  });
}

function faultyHandle(
  real: RedisHandle,
  faults: Faults,
  unavailable: RedisModule['RedisUnavailableError'],
): RedisHandle {
  return Object.freeze({
    namespace(name: string): RedisNamespace {
      const namespace = real.namespace(name);
      return name === TICKET_NAMESPACE
        ? faultyNamespace(namespace, faults, unavailable)
        : namespace;
    },
    close: () => real.close(),
    onApplicationShutdown: () => real.onApplicationShutdown(),
  });
}

function wrapAssets(option: unknown, faults: Faults): unknown {
  const provider = option as FactoryOption | undefined;
  if (provider === undefined || provider === null || typeof provider.useFactory !== 'function') {
    return option;
  }
  return {
    ...provider,
    useFactory: async (...args: unknown[]): Promise<AccountAssetsPort> => {
      const port = (await provider.useFactory(...args)) as AccountAssetsPort;
      return {
        countOrders: (db, account: AccountRef) => port.countOrders(db, account),
        hasClaims: async (db, account: AccountRef) =>
          faults.claims || (await port.hasClaims(db, account)),
        hasLedgerEntries: async (db, account: AccountRef) =>
          faults.ledger || (await port.hasLedgerEntries(db, account)),
      };
    },
  };
}

export async function openKit(): Promise<Kit> {
  // openSuite -> createTestDatabase: the database address comes from the global setup only.
  const suite = await openSuite();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-20a-'));
  const faults: Faults = { ticketStore: false, claims: false, ledger: false };
  const { logger, lines } = memoryLogger();
  let app: HttpApp | undefined;
  const restore: (() => void)[] = [];
  try {
    const { FixedClock } = (await import(
      new URL('apps/api/src/modules/platform/clock/index.ts', ROOT).href
    )) as ClockModule;
    const { createValidatorCompiler } = (await import(
      new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
    )) as ValidatorModule;
    const redisModule = (await import(
      new URL('apps/api/src/modules/platform/redis/index.ts', ROOT).href
    )) as RedisModule;
    const { IdentityModule } = (await import(
      new URL('apps/api/src/modules/identity/identity.module.ts', ROOT).href
    )) as { IdentityModule: { forRoot: ForRoot } };
    const clock = new FixedClock(INSTANT);

    const createReal = redisModule.createRedisHandle;
    const redisSpy = vi
      .spyOn(redisModule, 'createRedisHandle')
      .mockImplementation(async (connection, options) => {
        const handle = await createReal(connection, options);
        return handle === null
          ? null
          : faultyHandle(handle, faults, redisModule.RedisUnavailableError);
      });
    restore.push(() => redisSpy.mockRestore());
    const forRoot = IdentityModule.forRoot;
    const wiring = vi
      .spyOn(IdentityModule, 'forRoot')
      .mockImplementation((options: Record<string, unknown>) =>
        forRoot.call(IdentityModule, {
          ...options,
          ...('accountAssets' in options
            ? { accountAssets: wrapAssets(options['accountAssets'], faults) }
            : {}),
        }),
      );
    restore.push(() => wiring.mockRestore());

    app = await buildApp(suite.db, dir, suite.server.url, clock, logger);
    await app.init();
    for (const undo of restore.splice(0)) undo();

    const platform = (await import(
      new URL('apps/api/src/modules/platform/index.ts', ROOT).href
    )) as PlatformModule;
    const { TOKEN_SERVICE, SMS_CODES } = (await import(
      new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
    )) as { TOKEN_SERVICE: symbol; SMS_CODES: symbol };
    const { riskStateServiceToken } = (await import(
      new URL('apps/api/src/modules/risk/index.ts', ROOT).href
    )) as { riskStateServiceToken(): symbol };
    const { createSession } = (await import(
      new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
    )) as SessionsModule;
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Contract>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    return {
      suite,
      app,
      dir,
      clock,
      document,
      compile: createValidatorCompiler(),
      lines,
      faults,
      crypto: app.get<FieldCrypto>(platform.FIELD_CRYPTO),
      redis: app.get<RedisHandle>(platform.REDIS),
      sms: app.get<SmsCodeService>(SMS_CODES),
      tokens: app.get<TokenService>(TOKEN_SERVICE),
      risk: app.get<RiskStateService>(riskStateServiceToken()),
      createSession,
    };
  } catch (error) {
    for (const undo of restore.splice(0)) undo();
    await app?.close();
    await closeSuite(suite);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function closeKit(kit: Kit | undefined): Promise<void> {
  if (!kit) return;
  try {
    await kit.app.close();
  } finally {
    try {
      await closeSuite(kit.suite);
    } finally {
      rmSync(kit.dir, { recursive: true, force: true });
    }
  }
}

type Inject = (request: {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  payload: string;
}) => Promise<Response>;

export interface BindOptions {
  /** No Authorization header (a guest). */
  guest?: boolean;
  /** A signature that does not match the request. */
  badSign?: boolean;
  /** Idempotency-Key of the request; a fresh one when absent. */
  key?: string;
  headers?: Record<string, string>;
}

export interface FixtureOptions {
  /** users.register_method of the current account (default wechat). */
  method?: 'wechat' | 'apple' | 'huawei' | 'sms';
  /** The current account already has a phone (the change branch). */
  bound?: boolean;
  /** Seeds app_versions (ios / appstore) with this minimum before the device registers. */
  minVersion?: string;
}

export async function fixture(kit: Kit, options: FixtureOptions = {}) {
  kit.clock.set(INSTANT);
  kit.faults.ticketStore = false;
  kit.faults.claims = false;
  kit.faults.ledger = false;
  const appId = `bp_${randomBytes(10).toString('hex')}`;
  const db = kit.suite.db.withSchema('app');
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  if (options.minVersion !== undefined) {
    await db
      .insertInto('app_versions')
      .values({
        id: randomUUID(),
        app_id: appId,
        platform: 'ios',
        channel: 'appstore',
        latest_version: options.minVersion,
        min_supported_version: options.minVersion,
        update_title: 'test',
        update_notes: 'test',
        store_url: 'https://example.test/app',
        default_store: 'appstore',
        store_listings: JSON.stringify([]),
      })
      .execute();
  }
  const inject = kit.app.inject.bind(kit.app) as Inject;
  const created = await inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ code: 0 });
  const device = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  const method = options.method ?? 'wechat';
  const uid = await seedUser(db, appId, { method });
  const own = options.bound ? phone('137') : null;
  if (own !== null) {
    await db
      .updateTable('users')
      .set({
        phone_hmac: kit.crypto.blindIndex(own, PHONE_CONTEXT),
        phone_cipher: Buffer.from(kit.crypto.encrypt(own, PHONE_CONTEXT), 'utf8'),
      })
      .where('id', '=', uid)
      .execute();
  }
  if (method !== 'sms') await oauth(db, appId, uid, method);
  const session = await db
    .transaction()
    .execute((trx) =>
      kit.createSession(
        trx,
        { uid, app_id: appId, device_id: device.device_id, scp: 'full' },
        { clock: kit.clock, tokens: kit.tokens },
      ),
    );
  const number = phone('139');

  const bind = (body: unknown, bindOptions: BindOptions = {}) => {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = sign(
      'POST',
      PATH,
      Buffer.from(bindOptions.badSign ? `${raw} ` : raw),
      timestamp,
      nonce,
      device.install_secret,
    );
    return inject({
      method: 'POST',
      url: PATH,
      payload: raw,
      headers: {
        ...headers,
        'x-device-id': device.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': signature,
        'x-trace-id': randomUUID(),
        'idempotency-key': bindOptions.key ?? randomUUID(),
        ...(bindOptions.guest ? {} : { authorization: `Bearer ${session.access_token}` }),
        ...bindOptions.headers,
      },
    });
  };

  /** Sends a code through the real SMS service and returns it from the fake sender. */
  const send = async (to = number, purpose: 'bind' | 'login' = 'bind') => {
    expect(
      await kit.sms.send({ app_id: appId, phone: to, purpose, device_id: device.device_id }),
    ).toMatchObject({ code: 0 });
    const sent = outbox(kit.app)
      .filter((m) => m.app_id === appId && m.phone === to && m.purpose === purpose)
      .at(-1);
    expect(sent).toBeDefined();
    return sent!.code;
  };

  /** True when the code is still the current one of (app, phone, purpose=bind); consumes it. */
  const stillValid = async (code: string, to = number) =>
    (await kit.sms.verifyAndConsume({ app_id: appId, phone: to, purpose: 'bind', code })).code ===
    0;

  /** Another account of the app that owns `to` (default: the number under test). */
  const owner = async (
    ownerOptions: { status?: 'normal' | 'deleting' | 'deleted'; to?: string; method?: string } = {},
  ) =>
    seedUser(db, appId, {
      status: ownerOptions.status ?? 'normal',
      method: ownerOptions.method ?? 'sms',
      phoneHmac: kit.crypto.blindIndex(ownerOptions.to ?? number, PHONE_CONTEXT),
    });

  const order = async (user = uid) => {
    const orderId = randomUUID();
    const sub = `sub-${randomUUID()}`;
    const attrAt = kit.clock.now();
    await sql`INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
      VALUES ('taobao', ${sub}, ${orderId}, ${appId}, ${attrAt})`.execute(db);
    await sql`INSERT INTO app.orders
      (order_id, app_id, platform, sub_order_id, raw_item_id, user_id, platform_status, attr_at)
      VALUES (${orderId}, ${appId}, 'taobao', ${sub}, 'item-fixture', ${user}, 'PAID',
        ${attrAt})`.execute(db);
    return orderId;
  };

  const setParent = (child: string, parent: string) =>
    sql`UPDATE app.users SET parent_id = ${parent} WHERE app_id = ${appId} AND id = ${child}`.execute(
      db,
    );

  const setRisk = (user: string, state: 'banned' | 'appealing' | 'frozen' | 'normal') =>
    db.transaction().execute((trx) =>
      kit.risk.setRiskState(trx, {
        app_id: appId,
        user_id: user,
        state,
        reason: 'fixture reason',
        reason_category: state === 'normal' ? null : 'other',
        frozen_until: null,
        changed_by: 'fixture_operator',
      }),
    );

  const appeal = (user: string, previous: 'banned' | 'frozen') =>
    sql`INSERT INTO app.appeals (id, app_id, user_id, target_type, target_id, prev_risk_state,
        status, content, deadline_at, handler_id, closed_at)
      VALUES (${randomUUID()}, ${appId}, ${user}, 'account', ${user}, ${previous}, 'processing',
        'fixture appeal', ${new Date(kit.clock.now().getTime() + 86_400_000)}, null, null)`.execute(
      db,
    );

  /** Users, third-party bindings and sessions of the app, for "nothing moved" assertions. */
  const snapshot = async () => ({
    users: await db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    oauth: await db
      .selectFrom('user_oauth')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    sessions: await db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  });

  const user = (id = uid) =>
    db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  return {
    kit,
    db,
    appId,
    uid,
    deviceId: device.device_id,
    session,
    own,
    number,
    bind,
    send,
    stillValid,
    owner,
    oauth: (user: string, provider: 'wechat' | 'apple' | 'huawei') =>
      oauth(db, appId, user, provider),
    order,
    setParent,
    setRisk,
    appeal,
    snapshot,
    user,
    hmac: (value = number) => kit.crypto.blindIndex(value, PHONE_CONTEXT),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

async function oauth(
  db: Kysely<DB>,
  appId: string,
  user: string,
  provider: 'wechat' | 'apple' | 'huawei',
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('user_oauth')
    .values({ id, app_id: appId, user_id: user, provider, union_id: `union-${randomUUID()}` })
    .execute();
  return id;
}

function statusOf(code: number): number {
  if (code === 0) return 200;
  if (code === 50001) return 500;
  if (code === 30411) return 422;
  if ([10001, 10401].includes(code)) return 401;
  if ([10003, 10405, 44001].includes(code)) return 403;
  return 400;
}

/** The response envelope, checked against the contract of POST /v1/me/phone. */
export function envelope(kit: Kit, response: Response, code: number) {
  expect(response.statusCode).toBe(statusOf(code));
  const body = response.json<{
    code: number;
    msg: string;
    trace_id: string;
    data?: Record<string, unknown>;
  }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const status = code === 0 ? '200' : code === 50001 ? '5XX' : '4XX';
  const schema =
    kit.document.paths[PATH]!['post']!.responses[status]!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}

export function bound(kit: Kit, response: Response): void {
  expect(envelope(kit, response, 0).data).toEqual({});
}

/** 30411 without the merge offer: no data.reason, no data.merge_ticket. */
export function occupied(kit: Kit, response: Response): void {
  const body = envelope(kit, response, 30411);
  expect(body.data?.['reason']).toBeUndefined();
  expect(body.data?.['merge_ticket']).toBeUndefined();
}

/** 30411 with the merge offer; returns the ticket. */
export function mergeable(kit: Kit, response: Response): string {
  const body = envelope(kit, response, 30411);
  expect(body.data).toEqual({ reason: 'mergeable', merge_ticket: expect.any(String) });
  const ticket = body.data!['merge_ticket'] as string;
  // At least 128 random bits in any common encoding (22 base64url characters, 32 hex digits).
  expect(ticket.length).toBeGreaterThanOrEqual(22);
  return ticket;
}

export const ticketKey = (ticket: string) => createHash('sha256').update(ticket).digest('hex');

export async function storedTicket(kit: Kit, ticket: string) {
  const namespace = kit.redis.namespace(TICKET_NAMESPACE);
  const value = await namespace.get(ticketKey(ticket));
  const pttl = (await namespace.eval("return redis.call('PTTL', KEYS[1])", {
    keys: [ticketKey(ticket)],
    args: [],
    ttlSeconds: 1,
  })) as number;
  return { value, pttl, raw: await namespace.get(ticket) };
}

/** No phone number or ticket appears in any log line (6-digit codes could match by chance). */
export function quiet(kit: Kit, ...secrets: string[]): void {
  const text = kit.lines.join('\n');
  for (const secret of secrets) expect(text).not.toContain(secret);
}
