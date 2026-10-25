// B1-27i fixtures, console side: the admin entry over a real test database, FieldCrypto, Redis and
// admin sessions (container runner only), built on B1-27c's data-copies-register kit (its setup also
// checks that the registration and list routes are mounted). Copy requests, their registrants and
// the sealed wecom_session files are written by the test: the file goes into the entry's own
// MemoryExportStore (EXPORT_STORE, test env) sealed under the same field key the entry loads
// (sealDataCopyEntries, B1-27h), so every expected value is derived from what was seeded here. The
// delivery file is opened with the independent WinZip AES reader of data-copies-interop (B1-27k).
// Concurrency is observed in PostgreSQL: the test holds the request row and waits until the calls
// wait on its lock before letting them go.
// Sources: 08 BR-ID-40 细则「企业微信会话交付的下载」; contract adminDownloadUserDataExport (CT-24q);
// task §9 ① – ③.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import {
  sealDataCopyEntries,
  type DataCopyFileEntry,
} from '../../../../apps/api/src/modules/identity/application/data-copy-file.ts';
import {
  dataCopyObjectKey,
  EXPORT_STORE,
  type MemoryExportStore,
} from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import type { Harness, Response } from '../../admin/auth/kit.ts';
import { digest, openArchive } from '../data-copies-interop/kit.ts';
import {
  allAudits,
  booleanLeaves,
  member,
  rowText,
  setup as registerSetup,
  stepUp,
  DAY_MS as DAY,
  HOUR_MS as HOUR,
  PERMISSION,
  PII,
  TRACE,
  type AuditRow,
  type CopyRow,
  type CopyStatus,
  type Delivery,
  type Member,
  type User,
} from '../data-copies-register/kit.ts';
import { ADMIN_DOWNLOAD, OPERATIONS, validate } from './schema.ts';

export {
  allAudits,
  copiesOf,
  copyRow,
  deletion,
  member,
  ms,
  rowText,
  stepUp,
  superAdmin,
  user,
  DAY_MS,
  HOUR_MS,
  NOW,
  PERMISSION,
  PII,
  TRACE,
} from '../data-copies-register/kit.ts';
export type { AuditRow, CopyRow, CopyStatus, Delivery, Member, User };

export const MINUTE_MS = 60_000;
/** BR-ID-40 细则 / BR-ID-42: a signed link lives at most 5 minutes. */
export const LINK_MS = 5 * MINUTE_MS;
/** The audit action of every call that returns a link (contract adminDownloadUserDataExport). */
export const DOWNLOAD_ACTION = 'user_data_copy_download';

/** A download's response data (AdminUserDataExportDownload). */
export interface Download {
  url: string;
  url_expires_at: string;
  password: string | null;
  status: 'delivered';
  expires_at: string;
}

interface Inject {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  payload: string;
  remoteAddress: string;
}
interface RouteApp {
  inject(request: Inject): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(options: { method: string; url: string }): boolean };
  };
}

export async function setup(h: Harness) {
  const s = await registerSetup(h);
  const app = s.app as unknown as RouteApp;
  // Every integration case is red before the route exists, negative cases included.
  expect(
    app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: OPERATIONS.admin.route }),
    `admin 入口必须挂载 POST ${ADMIN_DOWNLOAD}`,
  ).toBe(true);
  const store = s.app.get<MemoryExportStore>(EXPORT_STORE);
  const put = vi.spyOn(store, 'put');
  return { ...s, routes: app, store, put };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A signed-in admin of the app holding both user.data_export and pii.reveal_phone. */
export const holder = (s: Setup): Promise<Member> => member(s, [PERMISSION, PII]);

/** Synthetic entries of one copy file (names as B1-27h writes them, values unique to the copy). */
export function entries(): DataCopyFileEntry[] {
  const tag = randomBytes(6).toString('hex');
  const encode = (value: string) => new TextEncoder().encode(value);
  return [
    { name: 'README.txt', bytes: encode(`synthetic personal information copy ${tag}\n`) },
    {
      name: 'account.json',
      bytes: encode(
        `${JSON.stringify({ nickname: `copy-${tag}`, login_providers: ['wechat'] })}\n`,
      ),
    },
    { name: 'agent_conversations.json', bytes: encode(`[{"text":"agent-said-${tag}"}]\n`) },
  ];
}

export interface CopySpec {
  readonly delivery?: Delivery;
  readonly status?: CopyStatus;
  readonly generatedAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly deliveredAt?: Date | null;
  readonly dueAt?: Date;
}

export interface SeededCopy {
  readonly row: CopyRow;
  /** The plain entries of the file (sealed into the store for a ready wecom_session request). */
  readonly entries: readonly DataCopyFileEntry[];
}

/**
 * A copy request of `target` registered by `registrant`, written directly (synthetic fixture).
 * Defaults follow the status: ready / delivered were generated an hour ago, expired 25 hours ago,
 * each expiring 24 hours after generation; a ready wecom_session request holds its sealed file
 * (B1-27h), a delivered one and an in_app_sms ready / delivered one some ZIP bytes; failed has a
 * failure_reason.
 */
export async function copy(
  s: Setup,
  target: User,
  registrant: string,
  spec: CopySpec = {},
): Promise<SeededCopy> {
  const id = randomUUID();
  const now = s.clock.now().getTime();
  const status = spec.status ?? 'ready';
  const delivery = spec.delivery ?? 'wecom_session';
  const generated =
    status === 'expired'
      ? new Date(now - DAY - HOUR)
      : status === 'ready' || status === 'delivered'
        ? new Date(now - HOUR)
        : null;
  const generatedAt = spec.generatedAt === undefined ? generated : spec.generatedAt;
  const expiresAt =
    spec.expiresAt === undefined
      ? generatedAt === null
        ? null
        : new Date(generatedAt.getTime() + DAY)
      : spec.expiresAt;
  const deliveredAt =
    spec.deliveredAt === undefined
      ? status === 'delivered' && generatedAt !== null
        ? new Date(generatedAt.getTime() + 10 * MINUTE_MS)
        : null
      : spec.deliveredAt;
  const files = entries();
  let objectKey: string | null = null;
  if (status === 'ready' || status === 'delivered') {
    const sealed = status === 'ready' && delivery === 'wecom_session';
    objectKey = dataCopyObjectKey(target.appId, id, sealed ? 'sealed' : 'seed');
    await s.store.put({
      key: objectKey,
      bytes: sealed ? sealDataCopyEntries(files, s.h.fields) : randomBytes(96),
      contentType: sealed ? 'application/octet-stream' : 'application/zip',
    });
  }
  const created = new Date(now - 2 * DAY);
  const row = await s.h.db
    .insertInto('personal_data_copies')
    .values({
      id,
      app_id: target.appId,
      user_id: target.id,
      requested_by: registrant,
      delivery,
      status,
      retry_of: null,
      object_key: objectKey,
      due_at: spec.dueAt ?? new Date(now + 10 * DAY),
      generated_at: generatedAt,
      delivered_at: deliveredAt,
      expires_at: expiresAt,
      failure_reason: status === 'failed' ? '副本文件生成失败，请重新登记' : null,
      created_at: created,
      updated_at: created,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  // The seeding put is not one of the entry's.
  s.put.mockClear();
  return { row, entries: files };
}

export interface DownloadOptions {
  /** The admin calling. */
  readonly as: Member;
  /** undefined: a fresh valid totp token of the admin; null: no X-Step-Up-Token. */
  readonly stepUp?: string | null;
  /** The JSON body (default {}). */
  readonly body?: Record<string, unknown>;
}

/** POST /admin/v1/users/{user_id}/data-exports/{export_id}/download. */
export async function download(
  s: Setup,
  userId: string,
  exportId: string,
  options: DownloadOptions,
): Promise<Response> {
  const step =
    options.stepUp === undefined
      ? await stepUp(s, options.as.who, options.as.token)
      : options.stepUp;
  return s.routes.inject({
    method: 'POST',
    url: ADMIN_DOWNLOAD.replace('{user_id}', encodeURIComponent(userId)).replace(
      '{export_id}',
      encodeURIComponent(exportId),
    ),
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      authorization: `Bearer ${options.as.token}`,
      ...(step === null ? {} : { 'x-step-up-token': step }),
    },
    payload: JSON.stringify(options.body ?? {}),
    remoteAddress: '127.0.0.1',
  });
}

/** A 200 download: envelope, Cache-Control: no-store and the contract's 200 schema; returns data. */
export async function granted(response: Response): Promise<Download> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  expect(response.headers['cache-control']).toBe('no-store');
  await validate(response, 'admin');
  return response.json<{ data: Download }>().data;
}

/** contracts/error-codes.yaml statuses of the codes this operation answers. */
const STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  30417: 422,
};

/** A refusal: code, HTTP status, the exact data and the contract's 4XX schema. */
export async function refused(response: Response, code: number, data: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  expect(response.json().data).toEqual(data);
  await validate(response, 'admin');
}

/** The signed link names this object key of the store (memory store: <base>/<key>?...). */
export function expectLinkTo(s: Setup, url: string, key: string | null) {
  expect(key, 'the request must record its file').not.toBeNull();
  expect(url).toContain(`/${key}?`);
  expect(s.store.verify(url, s.clock.now()), 'the link must be valid now').toBe(true);
}

/** The file at `key` opens with `password` into exactly `expected` (independent reader). */
export function expectOpens(
  s: Setup,
  key: string | null,
  password: string,
  expected: readonly DataCopyFileEntry[],
) {
  expect(key).not.toBeNull();
  const file = s.store.get(key!);
  expect(file, `the store must hold ${key}`).toBeDefined();
  expect(digest(openArchive(file!.bytes, password))).toEqual(digest(expected));
}

/** Opening the file at `key` with `password` fails. */
export function expectRefusesPassword(s: Setup, key: string | null, password: string) {
  const file = s.store.get(key!);
  expect(file).toBeDefined();
  expect(() => openArchive(file!.bytes, password)).toThrow();
}

/** The audit rows of the download action, oldest first. */
export const downloadAudits = (s: Setup) =>
  s.h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('action', '=', DOWNLOAD_ACTION)
    .orderBy('id')
    .execute();

/** The audit rows added after `before` (any action). */
export async function auditsSince(s: Setup, before: readonly AuditRow[]): Promise<AuditRow[]> {
  return (await allAudits(s)).filter((entry) => !before.some((old) => old.id === entry.id));
}

/**
 * One boolean leaf (same path in every record; key names are the implementation's) holds the
 * regenerate flag of each record, in order.
 */
export function expectRegenerateRecorded(rows: readonly AuditRow[], flags: readonly boolean[]) {
  expect(rows).toHaveLength(flags.length);
  const leaves = rows.map((row) =>
    booleanLeaves({ target: row.target, before: row.before, after: row.after }),
  );
  const paths = [...(leaves[0]?.keys() ?? [])].filter((path) =>
    flags.every((flag, index) => leaves[index]?.get(path) === flag),
  );
  expect(
    paths.length,
    `审计必须能还原每次的 regenerate ${JSON.stringify(flags)}；审计里的真假值：${JSON.stringify(
      leaves.map((map) => Object.fromEntries(map)),
    )}`,
  ).toBeGreaterThan(0);
}

/** Every scalar leaf of a JSON value by path, as JSON text ('null' included). */
function scalarLeaves(
  value: unknown,
  path = '$',
  out: Map<string, string> = new Map(),
): Map<string, string> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) scalarLeaves(item, `${path}[${index}]`, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) scalarLeaves(child, `${path}.${key}`, out);
  } else if (value !== undefined) {
    out.set(path, rowText(value));
  }
  return out;
}

/**
 * The first download records the delivery of `copyId` (contract: the request becomes delivered, "an
 * audit record of the delivery"; BR-ID-40 细则: 交付一条记交付方式为企业微信会话) and later calls do
 * not. Either the first call adds an audit row of its own (an action other than the download's,
 * under the registrant) naming the request and wecom_session, or its download record names
 * wecom_session and has a leaf whose value every later record (plain and regenerate alike) differs
 * from. Key names are the implementation's. Each later call adds exactly one download record.
 */
export function expectDeliveryRecorded(
  registrant: string,
  copyId: string,
  first: readonly AuditRow[],
  later: readonly (readonly AuditRow[])[],
) {
  for (const rows of later) expect(rows.map((entry) => entry.action)).toEqual([DOWNLOAD_ACTION]);
  const own = first.filter(
    (entry) =>
      entry.action !== DOWNLOAD_ACTION &&
      entry.admin_id === registrant &&
      rowText(entry).includes(copyId) &&
      rowText(entry).includes('wecom_session'),
  );
  const record = first.find((entry) => entry.action === DOWNLOAD_ACTION);
  const leavesOf = (row: AuditRow | undefined) =>
    scalarLeaves({ target: row?.target, before: row?.before, after: row?.after });
  const mine = leavesOf(record);
  const others = later.map((rows) => leavesOf(rows[0]));
  const paths = new Set([...mine.keys(), ...others.flatMap((leaves) => [...leaves.keys()])]);
  const marking = [...paths].filter(
    (path) =>
      others.every((leaves) => leaves.get(path) === others[0]?.get(path)) &&
      others[0]?.get(path) !== mine.get(path),
  );
  const inRecord =
    record !== undefined && rowText(record).includes('wecom_session') && marking.length > 0;
  const seen = `第一次：${rowText(first)}；之后：${rowText(later)}`;
  expect(
    own.length > 0 || inRecord,
    `第一次下载必须留下交付记录（企业微信会话），之后的下载与 regenerate 不再记交付；${seen}`,
  ).toBe(true);
}

/** Takes `permission` away from `admin` (effective on its next call). */
export const revoke = (s: Setup, admin: Member, permission: string) =>
  s.h.db
    .deleteFrom('admin_permissions')
    .where('app_id', '=', s.appId)
    .where('admin_id', '=', admin.who.id)
    .where('permission_key', '=', permission)
    .execute();

/** The request row held FOR UPDATE by a transaction of the test until `release` commits it. */
export async function holdRow(s: Setup, copyId: string) {
  const held = Promise.withResolvers<number>();
  const gate = Promise.withResolvers<void>();
  const done = s.h.db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('personal_data_copies')
      .select('id')
      .where('id', '=', copyId)
      .forUpdate()
      .execute();
    const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
    held.resolve(rows[0]!.pid);
    await gate.promise;
  });
  void done.catch((error: unknown) => {
    held.reject(error);
  });
  const pid = await held.promise;
  return {
    pid,
    release: async () => {
      gate.resolve();
      await done;
    },
  };
}

/**
 * Waits until at least `count` backends of this database (not `holder`) wait on a PostgreSQL lock
 * (behind the holder or behind each other); none of `requests` may answer meanwhile. Observed, not
 * a sleep that guesses the interleaving; the timeout fails the case.
 */
export async function lockWaiters(
  s: Setup,
  holder: number,
  count: number,
  requests: readonly Promise<unknown>[],
) {
  let finished = false;
  for (const request of requests) {
    void Promise.allSettled([request]).then(() => {
      finished = true;
    });
  }
  let observed = 0;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> ${holder} and wait_event_type = 'Lock'
        and cardinality(pg_blocking_pids(pid)) > 0`.execute(s.h.db);
    observed = rows[0]!.n;
    if (observed >= count || finished) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(finished, '请求行被占住时下载不能先回答（必须在行锁下判 ready）').toBe(false);
  expect(observed, '下载必须等在 PostgreSQL 锁上').toBeGreaterThanOrEqual(count);
}

/** Every place a password or link must never be: all audit rows, log lines and the copy rows. */
export async function stored(s: Setup, target: User): Promise<string> {
  const rows = await s.h.db
    .selectFrom('personal_data_copies')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .execute();
  return [rowText(await allAudits(s)), s.lines.join('\n'), rowText(rows)].join('\n');
}

/** The part of a signed link that grants access (its query string). */
export function signatureOf(url: string): string {
  const query = url.indexOf('?');
  expect(query, url).toBeGreaterThan(0);
  return url.slice(query + 1);
}
