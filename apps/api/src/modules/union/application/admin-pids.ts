// Admin console PIDs (推广位) (B1-22h; contract adminListUnionPids / adminCreateUnionPid /
// adminUpdateUnionPid / adminActivateUnionPid / adminRetireUnionPid; BR-ATTR-02 正文与细则「后台登记
// 与启停」「后台修改与启用的裁定」, BR-ATTR-28; 编排裁定 D10-152, D10-159, D10-221 A as amended
// by D10-231).
// union is the only writer of union_pids and union_accounts. The controller has already checked
// the admin_token, the permission point union.pid and (writes) the totp step-up through platform's
// AdminOperationGuard; the app and the admin are the guard's actor, never request fields.
//
// Every write runs on one primary transaction together with its audit row (admin's writer bound to
// that transaction, action union_pid_<create|update|activate|retire>, reason in `after`):
//   - create: lock the union account (app, platform), refuse a duplicate (app, platform, pid) in
//     any status, insert a pending row, and write the account's sync_start_at when it has none
//     (the first PID of the account, BR-ATTR-02);
//   - update: lock the row; only a pending row at the expected row_version changes; the merged row
//     is checked as a new one; moving to an account without sync_start_at writes it at the time
//     of the change; hjy confirmation fields are left as they are;
//   - activate: the screenshot is checked from its bytes and stored before the transaction (a
//     failing store changes no row); the transaction first takes an advisory lock on the
//     PID's app × platform × union_account_id × pid_scene, then locks every row of that account's
//     scene in id order (FOR UPDATE), so concurrent activations there serialize without a
//     phantom, and an active row of the same union account and scene refuses with 30155 without
//     changing anything. Other union accounts' active rows in the scene do not count: each
//     account may have one active PID per scene (D10-231, amending D10-221 A);
//   - retire: active → retired only.
// The frozen B1-19 service (../pids/service.ts) keeps its command-line semantics (super account,
// taobao mm_ PID form, warn-only cross-account activation); this console path follows the contract
// instead and shares its tables, status machine (canTransitionPid) and row_version CAS.
//
// Pure module (no decorators, erasable syntax).
import { pid_scene, type PidScene, type Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import { newUuidV7, type AuditPort, type Clock } from '../../platform/index.ts';
import { validAdminUnionReason } from '../domain/admin-reason.ts';
import { inspectHjyIgnoreEvidence } from '../domain/hjy-ignore-evidence.ts';
import { canTransitionPid } from '../domain/pid-status.ts';
import { isPlatform } from '../domain/types.ts';
import type { HjyIgnoreEvidenceStore } from '../infra/hjy-ignore-evidence-store.ts';

type PidRow = Selectable<DB['union_pids']>;
type AccountRow = Selectable<DB['union_accounts']>;
type Platform = Schema<'PlatformCode'>;
export type AdminPid = Schema<'AdminUnionPid'>;

export type AdminPidAction = 'create' | 'update' | 'activate' | 'retire';

/** 20001 with data.fields. */
export class AdminPidFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`union pid: invalid ${fields.join(', ')}`);
    this.name = 'AdminPidFieldsError';
    this.fields = fields;
  }
}

/** 20902 with data.resource=union_pid: not in the operation's start state, or row_version moved. */
export class AdminPidConflictError extends Error {
  constructor() {
    super('union pid: state or row_version changed');
    this.name = 'AdminPidConflictError';
  }
}

/**
 * 30155: another PID of the same app × platform × union_account_id × pid_scene is active
 * (D10-231; other union accounts' active PIDs in the scene do not count).
 */
export class AdminPidSceneActiveError extends Error {
  constructor() {
    super('union pid: the scene already has an active PID');
    this.name = 'AdminPidSceneActiveError';
  }
}

export interface AdminPidActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface AdminPidCreate {
  readonly platform: string;
  readonly union_account_id: string;
  readonly site_id?: string | null;
  readonly pid: string;
  readonly pid_scene: string;
  readonly reason?: string;
}

export interface AdminPidUpdate {
  readonly platform?: string;
  readonly union_account_id?: string;
  readonly site_id?: string | null;
  readonly pid?: string;
  readonly pid_scene?: string;
  readonly expected_row_version: number;
  readonly reason?: string;
}

export interface AdminPidRetire {
  readonly expected_row_version: number;
  readonly reason?: string;
}

/**
 * The decoded multipart parts of an activation, as sent: every field value a string (or undefined
 * when absent), the screenshot's bytes (undefined when absent). `invalid` names parts that were
 * malformed while reading (a repeated field, a field where the file belongs).
 */
export interface AdminPidActivationParts {
  readonly expected_row_version: string | undefined;
  readonly hjy_ignore_confirmed_at: string | undefined;
  readonly reason: string | undefined;
  readonly hjy_ignore_evidence: Uint8Array | undefined;
  readonly invalid: readonly string[];
}

export interface AdminUnionPidsOptions {
  /** Primary handle; undefined without a database (every call then fails closed, 50001). */
  readonly db: Kysely<DB> | undefined;
  readonly clock: Clock;
  /** Admin's audit writer bound to a transaction handle. */
  readonly auditWriter: (trx: Kysely<DB>) => AuditPort;
  readonly evidence: HjyIgnoreEvidenceStore;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** contract AdminUnionPidCode. */
const CODE = /^[0-9A-Za-z_-]{1,64}$/;
const UNIQUE_VIOLATION = '23505';
const INT32_MAX = 2_147_483_647;
const ROW_VERSION = /^(?:0|[1-9][0-9]{0,9})$/;
/** RFC 3339 date-time (contract format date-time). */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
const EDITABLE = ['platform', 'union_account_id', 'site_id', 'pid', 'pid_scene'] as const;

type Json = NonNullable<DB['audit_logs']['after']>;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isPidScene(value: unknown): value is PidScene {
  return typeof value === 'string' && (pid_scene as readonly string[]).includes(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * An RFC 3339 date-time as a Date (built from `like`, never from the wall clock: apps/api Clock
 * rule), or undefined.
 */
function parseDateTime(value: string, like: Date): Date | undefined {
  const match = DATE_TIME.exec(value);
  if (match === null) return undefined;
  const [, , month, day, hour, minute, second, offsetHour, offsetMinute] = match.map(Number);
  if (month! < 1 || month! > 12 || day! < 1 || day! > 31) return undefined;
  if (hour! > 23 || minute! > 59 || second! > 60) return undefined;
  if (offsetHour !== undefined && !Number.isNaN(offsetHour) && offsetHour > 23) return undefined;
  if (offsetMinute !== undefined && !Number.isNaN(offsetMinute) && offsetMinute > 59) {
    return undefined;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  const parsed = structuredClone(like);
  parsed.setTime(ms);
  return parsed;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The row as the contract shows it (AdminUnionPid). */
export function toAdminPid(row: PidRow): AdminPid {
  return {
    pid_id: row.id,
    platform: row.platform as Platform,
    union_account_id: row.union_account_id,
    site_id: row.site_id,
    pid: row.pid,
    pid_scene: row.pid_scene as AdminPid['pid_scene'],
    status: row.status as AdminPid['status'],
    hjy_ignore_confirmed_at: iso(row.hjy_ignore_confirmed_at),
    hjy_ignore_evidence_path: row.hjy_ignore_evidence_path,
    row_version: row.row_version,
    created_at: row.created_at.toISOString(),
  };
}

/** Audit snapshot of a row (instants as ISO strings), with the optional reason. */
function snapshot(row: PidRow, reason?: string): Json {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row) as [string, unknown][]) {
    out[key] =
      value instanceof Date
        ? value.toISOString()
        : ((value as string | number | null | undefined) ?? null);
  }
  if (reason !== undefined) out['reason'] = reason;
  return out;
}

function auditTarget(id: string): string {
  return `union_pids:${id}`;
}

/** Contract checks of a row's identity that need no database (POST and the merged PATCH row). */
function checkIdentity(row: {
  platform: unknown;
  union_account_id: unknown;
  site_id: unknown;
  pid: unknown;
  pid_scene: unknown;
}): void {
  if (!isPlatform(row.platform)) throw new AdminPidFieldsError(['platform']);
  if (!isUuid(row.union_account_id)) throw new AdminPidFieldsError(['union_account_id']);
  if (row.platform === 'taobao') {
    if (typeof row.site_id !== 'string' || !CODE.test(row.site_id)) {
      throw new AdminPidFieldsError(['site_id']);
    }
  } else if (row.site_id !== null && row.site_id !== undefined) {
    throw new AdminPidFieldsError(['site_id']);
  }
  if (typeof row.pid !== 'string' || !CODE.test(row.pid)) throw new AdminPidFieldsError(['pid']);
  if (!isPidScene(row.pid_scene)) throw new AdminPidFieldsError(['pid_scene']);
}

export class AdminUnionPids {
  readonly #options: AdminUnionPidsOptions;

  constructor(options: AdminUnionPidsOptions) {
    this.#options = options;
  }

  #db(): Kysely<DB> {
    const db = this.#options.db;
    if (db === undefined) throw new Error('union: PID administration needs the database');
    return db;
  }

  /** adminListUnionPids: every row of the app, three statuses, not paged. */
  async list(appId: string): Promise<AdminPid[]> {
    const rows = await this.#db()
      .selectFrom('union_pids')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('platform', 'asc')
      .orderBy('pid_scene', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(toAdminPid);
  }

  /** adminCreateUnionPid: always pending; the first PID of an account writes its sync_start_at. */
  async create(actor: AdminPidActor, body: AdminPidCreate): Promise<AdminPid> {
    const siteId = body.site_id ?? null;
    checkIdentity({ ...body, site_id: siteId });
    if (!validAdminUnionReason(body.reason)) throw new AdminPidFieldsError(['reason']);
    const platform = body.platform as Platform;
    const { clock } = this.#options;
    try {
      const row = await this.#db()
        .transaction()
        .execute(async (trx) => {
          const account = await this.#lockAccount(
            trx,
            actor.appId,
            platform,
            body.union_account_id,
          );
          await this.#refuseDuplicate(trx, actor.appId, platform, body.pid, null);
          const now = clock.now();
          const created = await trx
            .insertInto('union_pids')
            .values({
              id: newUuidV7(now),
              app_id: actor.appId,
              platform,
              union_account_id: account.id,
              site_id: siteId,
              pid: body.pid,
              pid_scene: body.pid_scene,
              status: 'pending',
              hjy_ignore_confirmed_at: null,
              hjy_ignore_evidence_path: null,
              row_version: 0,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await this.#startSync(trx, account, created.created_at);
          await this.#options.auditWriter(trx).append({
            appId: actor.appId,
            actor: actor.adminId,
            action: 'union_pid_create',
            target: auditTarget(created.id),
            before: null,
            after: snapshot(created, body.reason),
            ip: actor.ip,
          });
          return created;
        });
      return toAdminPid(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AdminPidFieldsError(['pid']);
      throw error;
    }
  }

  /** adminUpdateUnionPid: pending rows only; the merged row is checked as a new one. */
  async update(actor: AdminPidActor, pidId: string, body: AdminPidUpdate): Promise<AdminPid> {
    if (!isUuid(pidId)) throw new AdminPidFieldsError(['pid_id']);
    const { clock } = this.#options;
    try {
      const row = await this.#db()
        .transaction()
        .execute(async (trx) => {
          const before = await this.#lockPid(trx, actor.appId, pidId);
          if (!EDITABLE.some((field) => Object.hasOwn(body, field))) {
            throw new AdminPidFieldsError(['body']);
          }
          if (!validAdminUnionReason(body.reason)) throw new AdminPidFieldsError(['reason']);
          const merged = {
            platform: body.platform ?? before.platform,
            union_account_id: body.union_account_id ?? before.union_account_id,
            site_id: Object.hasOwn(body, 'site_id') ? (body.site_id ?? null) : before.site_id,
            pid: body.pid ?? before.pid,
            pid_scene: body.pid_scene ?? before.pid_scene,
          };
          checkIdentity(merged);
          const platform = merged.platform as Platform;
          const account = await this.#lockAccount(
            trx,
            actor.appId,
            platform,
            merged.union_account_id,
          );
          await this.#refuseDuplicate(trx, actor.appId, platform, merged.pid, before.id);
          // Only pending rows change (D10-159); a moved row_version is a stale console view.
          if (before.status !== 'pending' || before.row_version !== body.expected_row_version) {
            throw new AdminPidConflictError();
          }
          const now = clock.now();
          const updated = await trx
            .updateTable('union_pids')
            .set((eb) => ({
              platform,
              union_account_id: account.id,
              site_id: merged.site_id,
              pid: merged.pid,
              pid_scene: merged.pid_scene,
              updated_at: now,
              row_version: eb('row_version', '+', 1),
            }))
            .where('app_id', '=', actor.appId)
            .where('id', '=', before.id)
            .where('status', '=', 'pending')
            .where('row_version', '=', before.row_version)
            .returningAll()
            .executeTakeFirst();
          if (updated === undefined) throw new AdminPidConflictError();
          // Moving to an account without a sync start writes it at the time of the change; a
          // start already written (on either account) never changes (BR-ATTR-02 细则).
          if (account.id !== before.union_account_id) await this.#startSync(trx, account, now);
          await this.#options.auditWriter(trx).append({
            appId: actor.appId,
            actor: actor.adminId,
            action: 'union_pid_update',
            target: auditTarget(before.id),
            before: editable(before),
            after: {
              ...editable(updated),
              ...(body.reason === undefined ? {} : { reason: body.reason }),
            },
            ip: actor.ip,
          });
          return updated;
        });
      return toAdminPid(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AdminPidFieldsError(['pid']);
      throw error;
    }
  }

  /**
   * adminActivateUnionPid. Order of checks (contract): pid_id → the 花卷云 items missing → the
   * screenshot → other parts → state / row_version (20902) → an active PID of the same union
   * account in the scene (30155, D10-231).
   * The screenshot is stored only after every check passed on a plain read, and the row is written
   * only after the store succeeded; the transaction repeats the state and scene checks under lock.
   */
  async activate(
    actor: AdminPidActor,
    pidId: string,
    parts: AdminPidActivationParts,
  ): Promise<AdminPid> {
    if (!isUuid(pidId)) throw new AdminPidFieldsError(['pid_id']);
    const db = this.#db();
    const current = await db
      .selectFrom('union_pids')
      .selectAll()
      .where('app_id', '=', actor.appId)
      .where('id', '=', pidId)
      .executeTakeFirst();
    if (current === undefined) throw new AdminPidFieldsError(['pid_id']);

    const missing: string[] = [];
    if (parts.hjy_ignore_confirmed_at === undefined) missing.push('hjy_ignore_confirmed_at');
    if (parts.hjy_ignore_evidence === undefined && !parts.invalid.includes('hjy_ignore_evidence')) {
      missing.push('hjy_ignore_evidence');
    }
    if (missing.length > 0) throw new AdminPidFieldsError(missing);
    const evidence = parts.hjy_ignore_evidence;
    const inspected =
      evidence === undefined ? ({ valid: false } as const) : inspectHjyIgnoreEvidence(evidence);
    if (!inspected.valid || evidence === undefined) {
      throw new AdminPidFieldsError(['hjy_ignore_evidence']);
    }

    const { clock } = this.#options;
    const invalid: string[] = [];
    const expected = parts.expected_row_version;
    const version =
      expected !== undefined && ROW_VERSION.test(expected) && Number(expected) <= INT32_MAX
        ? Number(expected)
        : undefined;
    if (version === undefined || parts.invalid.includes('expected_row_version')) {
      invalid.push('expected_row_version');
    }
    const now = clock.now();
    const confirmedAt = parseDateTime(parts.hjy_ignore_confirmed_at ?? '', now);
    if (
      confirmedAt === undefined ||
      confirmedAt.getTime() > now.getTime() ||
      parts.invalid.includes('hjy_ignore_confirmed_at')
    ) {
      invalid.push('hjy_ignore_confirmed_at');
    }
    if (!validAdminUnionReason(parts.reason) || parts.invalid.includes('reason'))
      invalid.push('reason');
    for (const name of parts.invalid) {
      if (!invalid.includes(name) && name !== 'hjy_ignore_evidence') invalid.push(name);
    }
    if (invalid.length > 0 || version === undefined || confirmedAt === undefined) {
      throw new AdminPidFieldsError(invalid);
    }

    // Refusals that need no lock are answered before anything is stored.
    if (!canTransitionPid(current.status, 'active') || current.row_version !== version) {
      throw new AdminPidConflictError();
    }
    const sibling = await db
      .selectFrom('union_pids')
      .select('id')
      .where('app_id', '=', actor.appId)
      .where('platform', '=', current.platform)
      .where('union_account_id', '=', current.union_account_id)
      .where('pid_scene', '=', current.pid_scene)
      .where('status', '=', 'active')
      .where('id', '<>', current.id)
      .limit(1)
      .executeTakeFirst();
    if (sibling !== undefined) throw new AdminPidSceneActiveError();

    // A fresh object per attempt: a losing concurrent attempt never overwrites the winner's file.
    const extension = inspected.contentType === 'image/png' ? 'png' : 'jpg';
    const key = `union-pids/${current.id.toLowerCase()}/${newUuidV7(clock.now())}.${extension}`;
    await this.#options.evidence.put({ key, bytes: evidence, contentType: inspected.contentType });

    const row = await db.transaction().execute(async (trx) => {
      // Mutex first (review r1 S1): a transaction-level advisory lock keyed by app × platform ×
      // union_account_id × pid_scene, the unit of D10-231's "at most one active". It is keyed by
      // the account too (not the whole scene) because activations of different accounts never
      // conflict and need not wait for each other. Row locks alone miss a phantom: the SELECT's
      // snapshot is taken before it waits on a row lock, so a row of this account and scene
      // inserted (or moved here) and activated by another transaction meanwhile would stay
      // invisible to it. Every activation takes this lock before its SELECT, so that SELECT starts
      // (READ COMMITTED: a new statement snapshot) only after any earlier activation of the same
      // account and scene committed or rolled back.
      // Registration and PATCH need not take it: they only ever write pending rows, and a pending
      // row becomes active only through this path. Lock order is always advisory → row locks;
      // PATCH and retire take row locks only, so no cycle.
      await sql`select pg_advisory_xact_lock(hashtextextended(${sceneLockKey(
        actor.appId,
        current.platform,
        current.union_account_id,
        current.pid_scene,
      )}, 0))`.execute(trx);
      // Every row of this account's scene, in id order, locked (D10-231): the active check below
      // reads committed state, and a concurrent PATCH or retire of these rows waits for this
      // commit. A row moved to another account or scene meanwhile is not returned → 20902.
      const scene = await trx
        .selectFrom('union_pids')
        .selectAll()
        .where('app_id', '=', actor.appId)
        .where('platform', '=', current.platform)
        .where('union_account_id', '=', current.union_account_id)
        .where('pid_scene', '=', current.pid_scene)
        .orderBy('id', 'asc')
        .forUpdate()
        .execute();
      const before = scene.find((candidate) => candidate.id === current.id);
      // Gone from this account's scene: changed meanwhile (row_version moved).
      if (
        before === undefined ||
        !canTransitionPid(before.status, 'active') ||
        before.row_version !== version
      ) {
        throw new AdminPidConflictError();
      }
      if (scene.some((candidate) => candidate.id !== before.id && candidate.status === 'active')) {
        throw new AdminPidSceneActiveError();
      }
      const now = clock.now();
      const activated = await trx
        .updateTable('union_pids')
        .set((eb) => ({
          status: 'active',
          hjy_ignore_confirmed_at: confirmedAt,
          hjy_ignore_evidence_path: key,
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('app_id', '=', actor.appId)
        .where('id', '=', before.id)
        .where('status', '=', 'pending')
        .where('row_version', '=', before.row_version)
        .returningAll()
        .executeTakeFirst();
      if (activated === undefined) throw new AdminPidConflictError();
      await this.#options.auditWriter(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: 'union_pid_activate',
        target: auditTarget(before.id),
        before: snapshot(before),
        after: snapshot(activated, parts.reason),
        ip: actor.ip,
      });
      return activated;
    });
    return toAdminPid(row);
  }

  /** adminRetireUnionPid: active → retired only; the row stays on the whitelist. */
  async retire(actor: AdminPidActor, pidId: string, body: AdminPidRetire): Promise<AdminPid> {
    if (!isUuid(pidId)) throw new AdminPidFieldsError(['pid_id']);
    if (!validAdminUnionReason(body.reason)) throw new AdminPidFieldsError(['reason']);
    const { clock } = this.#options;
    const row = await this.#db()
      .transaction()
      .execute(async (trx) => {
        const before = await this.#lockPid(trx, actor.appId, pidId);
        if (
          before.status !== 'active' ||
          !canTransitionPid(before.status, 'retired') ||
          before.row_version !== body.expected_row_version
        ) {
          throw new AdminPidConflictError();
        }
        const now = clock.now();
        const retired = await trx
          .updateTable('union_pids')
          .set((eb) => ({
            status: 'retired',
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('app_id', '=', actor.appId)
          .where('id', '=', before.id)
          .where('status', '=', 'active')
          .where('row_version', '=', before.row_version)
          .returningAll()
          .executeTakeFirst();
        if (retired === undefined) throw new AdminPidConflictError();
        await this.#options.auditWriter(trx).append({
          appId: actor.appId,
          actor: actor.adminId,
          action: 'union_pid_retire',
          target: auditTarget(before.id),
          before: snapshot(before),
          after: snapshot(retired, body.reason),
          ip: actor.ip,
        });
        return retired;
      });
    return toAdminPid(row);
  }

  async #lockPid(trx: Kysely<DB>, appId: string, pidId: string): Promise<PidRow> {
    const row = await trx
      .selectFrom('union_pids')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', pidId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new AdminPidFieldsError(['pid_id']);
    return row;
  }

  /** The app's union account of that platform, locked; otherwise 20001 [union_account_id]. */
  async #lockAccount(
    trx: Kysely<DB>,
    appId: string,
    platform: Platform,
    accountId: string,
  ): Promise<AccountRow> {
    const account = await trx
      .selectFrom('union_accounts')
      .selectAll()
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .where('id', '=', accountId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined) throw new AdminPidFieldsError(['union_account_id']);
    return account;
  }

  /** The same (app, platform, pid) on another row, in any status → 20001 [pid]. */
  async #refuseDuplicate(
    trx: Kysely<DB>,
    appId: string,
    platform: Platform,
    pid: string,
    self: string | null,
  ): Promise<void> {
    let query = trx
      .selectFrom('union_pids')
      .select('id')
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .where('pid', '=', pid);
    if (self !== null) query = query.where('id', '<>', self);
    if ((await query.limit(1).executeTakeFirst()) !== undefined) {
      throw new AdminPidFieldsError(['pid']);
    }
  }

  /** Writes sync_start_at once, on an account (locked by the caller) that has none. */
  async #startSync(trx: Kysely<DB>, account: AccountRow, at: Date): Promise<void> {
    if (account.sync_start_at !== null) return;
    const updated = await trx
      .updateTable('union_accounts')
      .set((eb) => ({
        sync_start_at: at,
        updated_at: this.#options.clock.now(),
        row_version: eb('row_version', '+', 1),
      }))
      .where('app_id', '=', account.app_id)
      .where('id', '=', account.id)
      .where('row_version', '=', account.row_version)
      .where('sync_start_at', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new Error('union: account changed under its lock');
  }
}

/**
 * Advisory-lock key text of one app × platform × union_account_id × pid_scene (hashed in SQL to a
 * bigint; D10-231's unit of "at most one active").
 */
function sceneLockKey(appId: string, platform: string, accountId: string, scene: string): string {
  return `union_pid_scene:${appId}:${platform}:${accountId.toLowerCase()}:${scene}`;
}

/** The five editable fields of a row (the update audit's before / after). */
function editable(row: PidRow): Record<string, string | null> {
  return {
    platform: row.platform,
    union_account_id: row.union_account_id,
    site_id: row.site_id,
    pid: row.pid,
    pid_scene: row.pid_scene,
  };
}
