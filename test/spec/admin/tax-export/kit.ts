// B2-08e rule-test kit (claude-independent, SPEC_REF deb521c2; 规划/08 BR-WDR-21; contract CT-24zi
// adminCreateExport / adminListExports / adminDownloadExport / adminRetryExport; task §9).
// Real pieces, nothing of the code under test is replaced:
//   admin   createHttpApp('admin'), through test/spec/admin/exports/kit.ts's setup (real queue);
//   worker  createWorkerContext('worker') over the same config, clock, logger and database, and
//           context.get(EXPORT_WORKER): whatever app.module assembles for the export queue, so the
//           payout reader (B2-08d) and identity's batch real-name port are the real ones;
//   rows    withdrawals, real names and the correction go in as production stores them: ciphers of
//           the real field keyring (contexts realname.*, payout_accounts.*), the correction through
//           POST /admin/v1/users/{user_id}/realname-correction, so no test depends on where the
//           implementation reads the correction time from (couli_app cannot read
//           realname_prior_identities).
// The worker's queue is built but not started (only entry.ts starts it): its export sends go
// through the admin entry's started runtime with the caller's transaction, every other queue stays
// not_running. Jobs are delivered by calling the worker's handler with what the admin entry sent.
// Tax tasks are only ever created over HTTP: before the migration the table refuses the resource,
// and a red must be an assertion. Provisioners are passed in by the *.int.test.ts files.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb } from '@couli/db';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import { hashAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  EXPORT_STORE,
  type MemoryExportStore,
} from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import type {
  JobHandler,
  JobQueue,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  body as correctionBody,
  user,
  verified,
  type Identity,
  type User,
} from '../../identity/admin-realname/kit.ts';
import { CORRECTION } from '../../identity/admin-realname/schema.ts';
import { decode } from '../../identity/token/kit.ts';
import { ALIPAY_PHONE, BANK_CARD, seedWithdrawal } from '../../payout/tax-export/kit.ts';
import { grant, seed } from '../accounts/kit.ts';
import { ORIGIN, signedIn, totp, type Harness, type HttpApp, type Response } from '../auth/kit.ts';
import { parseCsv } from '../export-worker/kit.ts';
import { ROOT, setup, validate, type Setup } from '../exports/kit.ts';
import { adminSurface } from '../permissions/expected.ts';
import { ok as stepOk, redisOf, STEP, type Grant } from '../step-up/kit.ts';

export const PURPOSE = '2026 年第四季度个税申报';
export const MASKED = { resource: 'tax_withdrawals', filters: { quarter: '2026-Q4' } } as const;
export const FULL = { ...MASKED, unmasked: true, reason: PURPOSE } as const;
/** Task §9.3: the masked version needs both, the full version only tax.export_full. */
export const MASKED_POINTS = ['export', 'fund.view'] as const;
export const FULL_POINT = 'tax.export_full';
export const DENIED = { reason: 'admin_permission_denied' } as const;
/** D10-546: each link lives 5 minutes; BR-WDR-21: the file is kept 24 hours. */
export const LINK_TTL_MS = 300_000;
export const DAY_MS = 86_400_000;
/** Task §9.5 boundaries: the start is inside, the end is not. */
export const Q4_START = new Date('2026-10-01T00:00:00+08:00');
export const Q4_END = new Date('2027-01-01T00:00:00+08:00');
export const MAX_ROWS_KEY = 'admin.export.max_rows';

/** Column order of the contract (adminCreateExport, File). */
export const COLUMN = {
  name: 0,
  idNo: 1,
  incomeType: 2,
  income: 3,
  tax: 4,
  paidAt: 5,
  account: 6,
  outBizNo: 7,
  corrected: 8,
} as const;

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  url: string;
  stop(): Promise<void>;
}

/** Same shape as test/spec/admin/exports/kit.ts's, but h.db is bound to schema app once. */
export function harness(
  provision: () => Promise<TestDatabase>,
  redis: () => Promise<TestRedis>,
): Harness {
  const h = {} as Harness;
  let database: TestDatabase | undefined;
  let dir: string | undefined;
  beforeAll(async () => {
    h.apps = [];
    database = await provision();
    // createDb is already bound: the worker entry walks modules that need the single binding.
    h.db = createDb({ connectionString: database.urlFor('couli_app'), max: 16 });
    h.redis = await redis();
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(join(base, 'b2-08e-'));
    const master = randomBytes(32);
    const provider = new LocalKeyProvider(master);
    const wrapped = await createWrappedKeyring(provider);
    h.fields = await openFieldCrypto(wrapped, provider);
    const masterFile = join(dir, 'master.hex');
    const keyringFile = join(dir, 'keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    h.appKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    h.env = {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
      ADMIN_CORS_ORIGIN: ORIGIN,
      JWT_KEY_ID: 'b2-08e-app',
      JWT_PRIVATE_KEY_PEM: h.appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    h.password = randomBytes(24).toString('base64url');
    h.passwordHash = await hashAdminPassword(h.password);
  }, 180_000);
  afterEach(async () => {
    for (const app of h.apps.splice(0)) await app.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    try {
      if (h.db !== undefined) await destroyDb(h.db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await h.redis?.stop();
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  return h;
}

interface WorkerContext {
  get<T>(token: symbol): T;
}
/** The slice of the worker's public shape this kit calls (kept local: Nest stays out of tsc). */
interface ExportWorkerPort {
  readonly handle: JobHandler;
}

async function workerEntry(h: Harness, f: Setup) {
  const { createWorkerContext } = (await import(
    new URL('apps/api/src/bootstrap.ts', ROOT).href
  )) as {
    createWorkerContext(entry: 'worker', overrides: Setup['overrides']): Promise<WorkerContext>;
  };
  const { EXPORT_WORKER } = (await import(
    new URL('apps/api/src/modules/admin/index.ts', ROOT).href
  )) as { EXPORT_WORKER: symbol };
  const { JOB_QUEUE } = (await import(
    new URL('apps/api/src/modules/platform/platform.module.ts', ROOT).href
  )) as { JOB_QUEUE: symbol };
  const context = await createWorkerContext('worker', f.overrides);
  // Closed with the admin entry by the harness; only close() is ever called on it.
  h.apps.push(context as unknown as HttpApp);
  const worker = context.get<ExportWorkerPort | null>(EXPORT_WORKER);
  expect(worker, 'worker 入口须装配导出 worker').not.toBeNull();
  const queue = context.get<JobQueue>(JOB_QUEUE);
  const notRunning = queue.send.bind(queue);
  const sent = vi.spyOn(queue, 'send').mockImplementation((name, job, payload, options) => {
    if (name !== 'export') return notRunning(name, job, payload, options);
    return f.realSend(name, job, payload, options);
  });
  return { worker: worker!, sent, store: context.get<MemoryExportStore>(EXPORT_STORE) };
}

/** The file as the worker stored it, read through the contract's layout. */
export interface TaxFile {
  /** The raw first line, as a text editor shows it. */
  readonly line: string;
  readonly header: readonly string[];
  readonly rows: readonly string[][];
}

export async function open(
  h: Harness,
  permissions: readonly string[] = MASKED_POINTS,
  isSuper = false,
) {
  const f = await setup(h, permissions, isSuper);
  let booted: ReturnType<typeof workerEntry> | undefined;
  const entry = () => (booted ??= workerEntry(h, f));
  const taskOf = async (publicId: string) => {
    const row = (await f.tasks()).find((task) => task.public_id === publicId);
    expect(row, `task ${publicId}`).toBeDefined();
    return row!;
  };
  const jobOf = (name: string, taskId: string) => ({
    id: randomUUID(),
    queue: 'export',
    name,
    payload: { appId: f.appId, taskId },
    attempt: 1,
  });
  /** Delivers the generate job the admin entry sent for the task; the task as it is afterwards. */
  const generate = async (publicId: string) => {
    const { worker } = await entry();
    const row = await taskOf(publicId);
    const enqueued = f.send.mock.calls.filter(
      ([queue, name, payload]) =>
        queue === 'export' && name === 'generate' && payload['taskId'] === row.id,
    );
    expect(enqueued.length, 'generate 须由创建或重试入队').toBeGreaterThan(0);
    await worker.handle(jobOf('generate', row.id));
    return f.read(row.id);
  };
  /** Delivers the expire job the done transaction sent; the task as it is afterwards. */
  const expire = async (publicId: string) => {
    const { worker, sent } = await entry();
    const row = await taskOf(publicId);
    const enqueued = sent.mock.calls.filter(
      ([queue, name, payload]) =>
        queue === 'export' && name === 'expire' && payload['taskId'] === row.id,
    );
    expect(enqueued.length, 'expire 须由完成事务入队').toBeGreaterThan(0);
    await worker.handle(jobOf('expire', row.id));
    return f.read(row.id);
  };
  /** The stored CSV, BOM checked and removed. */
  const stored = async (publicId: string) => {
    const { store } = await entry();
    const row = await taskOf(publicId);
    expect(row.status).toBe('done');
    expect(row.object_key).toBe(`${f.appId}/${row.public_id}.csv`);
    const object = store.get(row.object_key!);
    expect(object, '导出对象须已写入').toBeDefined();
    expect(object!.contentType).toBe('text/csv');
    const raw = Buffer.from(object!.bytes).toString('utf8');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    return raw.slice(1);
  };
  const file = async (publicId: string): Promise<TaxFile> => {
    const body = await stored(publicId);
    const [, header, ...rows] = parseCsv(body);
    expect(header, '第二行须是表头').toBeDefined();
    return { line: body.slice(0, body.indexOf('\r\n')), header: header!, rows };
  };
  /** A fresh totp-tier step-up token of the actor. */
  const token = async () => (await f.issue()).step_up_token;
  return { ...f, entry, generate, expire, stored, file, token };
}
export type Tax = Awaited<ReturnType<typeof open>>;

/** open, with the worker entry up: a broken assembly shows at once, before any request. */
export async function started(
  h: Harness,
  permissions: readonly string[] = MASKED_POINTS,
  isSuper = false,
) {
  const f = await open(h, permissions, isSuper);
  await f.entry();
  return f;
}

/** Another admin of the app, signed in. */
export async function colleague(h: Harness, f: Setup, permissions: readonly string[]) {
  const who = await seed(h, f.appId);
  if (permissions.length > 0) await grant(h, who, who, permissions);
  const session = await signedIn(f, who);
  return { who, token: session.admin_token };
}

/** A member of the app with a verified real name. */
export async function person(h: Harness, appId: string, who: Identity): Promise<User> {
  const target = await user(h, appId);
  await verified(h, target, who);
  return target;
}

/** The cipher production stores for the snapshot (identity/application/payout-account.ts). */
export function accountCipher(h: Harness, method: 'alipay' | 'bank_card', plain: string): Buffer {
  return Buffer.from(h.fields.encrypt(plain, `payout_accounts.${method}`), 'utf8');
}

type WithdrawalPatch = NonNullable<Parameters<typeof seedWithdrawal>[2]>;

/** A paid withdrawal of `who` to an Alipay phone unless patched (default paid in 2026-Q4). */
export function paid(h: Harness, who: User, patch: WithdrawalPatch = {}) {
  return seedWithdrawal(
    h.db,
    { appId: who.appId, userId: who.id },
    { payee_account_cipher: accountCipher(h, 'alipay', ALIPAY_PHONE), ...patch },
  );
}

/** The patch of a bank-card payee. */
export function bank(h: Harness): WithdrawalPatch {
  return {
    payout_channel: 'bank_card',
    payee_account_cipher: accountCipher(h, 'bank_card', BANK_CARD),
  };
}

/** The real correction through the admin entry; the instant it happened at. */
export async function correct(h: Harness, f: Setup, target: User, who: Identity): Promise<Date> {
  const admin = await seed(h, f.appId, { isSuper: true });
  const session = await signedIn(f, admin);
  const headers = { authorization: `Bearer ${session.admin_token}` };
  f.clock.advanceMs(30_000);
  const step = await stepOk<Grant>(
    await f.post('/step-up', { tier: 'totp', code: totp(admin.secret, f.clock) }, headers),
    STEP,
  );
  const response = await f.app.inject({
    method: 'POST',
    url: CORRECTION.replace('{user_id}', target.id),
    headers: {
      ...headers,
      'content-type': 'application/json',
      'x-step-up-token': step.step_up_token,
    },
    payload: JSON.stringify(correctionBody(who)),
    remoteAddress: '127.0.0.1',
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  return f.clock.now();
}

/** The app's override of admin.export.max_rows (before the worker first reads it). */
export function setMaxRows(h: Harness, appId: string, value: number) {
  return sql`INSERT INTO app.config_items (app_id,key,value,updated_by)
    VALUES (${appId},${MAX_ROWS_KEY},${JSON.stringify(value)}::jsonb,'synthetic')`.execute(h.db);
}

/** A sms-tier token of the actor (lower than the totp the full version needs). */
export async function smsToken(f: Setup): Promise<string> {
  const surface = await adminSurface();
  const tokens = surface.createAdminStepUpTokens({
    clock: f.clock,
    redis: (await redisOf({ app: f.app } as Parameters<typeof redisOf>[0])).namespace(
      'admin-step-up',
    ),
  });
  const sessionId = decode(f.session.admin_token).payload['jti'];
  expect(sessionId).toBeTypeOf('string');
  const token = await tokens.issue({
    appId: f.appId,
    adminId: f.actor.id,
    sessionId: sessionId as string,
    tier: 'sms',
  });
  return token.step_up_token;
}

/**
 * 20001 for a year outside 2026..2100. Task §9.2 leaves the spelling to the existing filters check,
 * which has both forms (the route schema's filters.quarter, the use case's bare from / to).
 */
export async function quarterRefused(response: Response) {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001 });
  const fields = response.json<{ data: { fields: string[] } }>().data.fields;
  expect(fields).toHaveLength(1);
  expect(['filters.quarter', 'quarter']).toContain(fields[0]);
  await validate(response);
}

/** A schema refusal: oneOf reports every branch, so the field is required, not alone. */
export async function shapeRefused(response: Response, field: string) {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({
    code: 20001,
    data: { fields: expect.arrayContaining([field]) },
  });
  await validate(response);
}

/** No side effect of a refused create. */
export async function untouched(f: Setup) {
  expect(await f.tasks()).toEqual([]);
  expect(await f.audits()).toEqual([]);
  expect(f.send.mock.calls.filter(([queue]) => queue === 'export')).toEqual([]);
}

const NOTE_TIME =
  /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:\d{2})?/;

/**
 * The instant the first line names, to the minute. The format is not fixed: an ISO 8601 time, or a
 * display time without an offset, which is +08:00 like every console display (BR-WDR-21).
 */
export function noteInstant(line: string, username: string): number {
  const match = NOTE_TIME.exec(line.replace(username, ''));
  expect(match, `首行须写导出时刻：${line}`).not.toBeNull();
  const [, day, minute, zone] = match!;
  return Date.parse(`${day}T${minute}:00${zone ?? '+08:00'}`);
}

export function minuteOf(instant: Date): number {
  const ms = instant.getTime();
  return ms - (ms % 60_000);
}

/** The row of a withdrawal, by the out_biz_no column. */
export function rowOf(file: TaxFile, outBizNo: string): readonly string[] {
  const row = file.rows.find((cells) => cells[COLUMN.outBizNo] === outBizNo);
  expect(row, `out_biz_no ${outBizNo}`).toBeDefined();
  return row!;
}

/** First 6 and last 4 kept, nothing else of the number (BR-WDR-21). */
export function expectMaskedIdNo(cell: string | undefined, idNo: string) {
  expect(cell).toBeDefined();
  expect(cell!.slice(0, 6)).toBe(idNo.slice(0, 6));
  expect(cell!.slice(-4)).toBe(idNo.slice(-4));
  expect(cell!.slice(6, -4)).toMatch(/^[^0-9Xx]+$/);
}
