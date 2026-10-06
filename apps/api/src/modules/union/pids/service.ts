// Union account and PID (推广位) service (B1-19b; 规划/02 §6.3; BR-ATTR-02, BR-ATTR-08,
// BR-ATTR-28, BR-PROD-07). union is the only writer of union_accounts / union_pids.
//
// Every command that writes either table (account registration, PID registration incl. the
// implicit sync_start_at write, HJY confirmation, activation, retirement) first runs the injected
// combined "super account + dynamic code" verifier (F1-06b), outside any transaction, then opens a
// transaction, locks the row, writes, and appends the audit row on the same transaction: an audit
// failure rolls the business write back. There is no delete and no free-form update.
//
// Safe retry: a command may carry an idempotency key (8–64 of [A-Za-z0-9_-]). With a key, the
// transaction is run through platform/idempotency executeInTransaction: the key is reserved and
// completed in the same transaction as the business write and its audit, a replay of the same key
// with the same request returns the row the first call wrote (read back by its id) without
// writing again, and the same key with a different request is refused. A retry still needs a
// fresh dynamic code: verification runs first on every call. The command line (B1-19c) always
// generates and prints the key.
// Without a key the command runs once, as before (the frozen rule tests call it that way); the
// business unique constraints remain the last line (规划/02 §18).
//
// Status writes: forward only via canTransitionPid (union domain), applied with a row_version CAS
// (ADR-0001 §4.1). Every UPDATE carries `row_version = <read value>` and increments it; zero rows
// affected is a conflict.
//
// Read queries (getActivePid, isWhitelisted) never verify or audit and work on a read-only role.
//
// Pure module (no decorators, erasable syntax, no Nest injection). Its runtime platform helpers
// (newUuidV7, createIdempotency) come through platform/index.ts as the module boundary requires
// (depcruise modules-only-via-index). union never imports admin: the verifier and audit writer are
// received structurally from the caller.
import { pid_scene, type PidScene, type components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import {
  createIdempotency,
  newUuidV7,
  type Clock,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import { canTransitionPid, type PidStatus } from '../domain/pid-status.ts';
import { isPlatform } from '../domain/types.ts';

export type PidPlatform = components['schemas']['PlatformCode'];
export type { PidStatus } from '../domain/pid-status.ts';
export type AccountRow = Selectable<DB['union_accounts']>;
export type PidRow = Selectable<DB['union_pids']>;

/** Structural match for F1-06b's combined super-account and TOTP verifier. */
export interface VerifiedSuper {
  readonly appId: string;
  readonly adminId: string;
}

export interface SuperVerification {
  verify(request: VerifiedSuper & { readonly code: string }): Promise<VerifiedSuper | null>;
}

/** Structural match for F1-06b's audit writer; union never imports admin. */
export interface UnionAuditInput {
  readonly appId: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly before: DB['audit_logs']['before'];
  readonly after: DB['audit_logs']['after'];
  readonly ip: string | null;
}

export interface UnionAuditWriter {
  append(input: UnionAuditInput): Promise<void>;
}

export interface PidServiceDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly superVerifier: SuperVerification;
  /** Bind the injected writer to the command transaction, e.g. createAuditWriter({db, clock}). */
  readonly auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
  /**
   * platform/idempotency instance (the IDEMPOTENCY provider). Defaults to one created on the same
   * db and clock; only executeInTransaction is used, which never logs.
   */
  readonly idempotency?: Pick<Idempotency, 'executeInTransaction'>;
}

export interface WriteContext {
  readonly appId: string;
  readonly adminId: string;
  readonly code: string;
  readonly ip: string | null;
  /**
   * Retry key, the same across retries of one intended change (B1-19c generates and prints it).
   * Optional at this layer; see the header comment.
   */
  readonly idempotencyKey?: string;
  readonly traceId?: string;
}

export interface RegisterAccountInput extends WriteContext {
  readonly platform: PidPlatform;
  readonly accountName: string;
  readonly authStatus: 'active' | 'expiring' | 'expired';
  readonly authExpiresAt: Date | null;
}

export interface RegisterPidInput extends WriteContext {
  readonly platform: PidPlatform;
  readonly unionAccountId: string;
  readonly siteId: string | null;
  readonly pid: string;
  readonly pidScene: PidScene;
}

export interface PidWriteInput extends WriteContext {
  readonly pidId: string;
}

export interface ConfirmHjyInput extends PidWriteInput {
  readonly confirmedAt: Date;
  readonly evidencePath: string;
}

export interface SetPidStatusInput extends PidWriteInput {
  readonly status: 'active' | 'retired';
}

export interface ActivePidInput {
  readonly appId: string;
  readonly platform: PidPlatform;
  readonly pidScene: PidScene;
  /** query 位仅供查价；fallback 从不用于转链。 */
  readonly purpose: 'convert' | 'query';
}

export interface WhitelistInput {
  readonly appId: string;
  readonly platform: PidPlatform;
  readonly unionAccountId: string;
  readonly siteId: string | null;
  readonly pid: string;
}

/** No delete, arbitrary update, caller-supplied status or caller-supplied sync start API. */
export interface UnionPidService {
  registerAccount(input: RegisterAccountInput): Promise<AccountRow>;
  registerPid(input: RegisterPidInput): Promise<PidRow>;
  confirmHjyIgnore(input: ConfirmHjyInput): Promise<PidRow>;
  setPidStatus(input: SetPidStatusInput): Promise<PidRow>;
  getActivePid(input: ActivePidInput): Promise<PidRow | null>;
  isWhitelisted(input: WhitelistInput): Promise<boolean>;
}

export type UnionPidErrorCode =
  | 'invalid_input'
  | 'not_verified'
  | 'not_found'
  | 'illegal_transition'
  | 'evidence_missing'
  | 'duplicate'
  | 'conflict'
  | 'idempotency_conflict'
  | 'idempotency_in_progress';

/** Internal failure of a union account / PID command (not an HTTP error code). */
export class UnionPidError extends Error {
  readonly code: UnionPidErrorCode;
  constructor(code: UnionPidErrorCode, message: string) {
    super(message);
    this.name = 'UnionPidError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
/** Whitespace or control characters anywhere: such a PID never matches the union's clean value. */
const UNCLEAN = /[\s\p{Cc}]/u;
/** Taobao adzone PID mm_<member>_<site>_<adzone> (02 §6.3). */
const TAOBAO_PID = /^mm_(\d+)_(\d+)_(\d+)$/;
const UNIQUE_VIOLATION = '23505';
const AUTH_STATUSES: readonly string[] = ['active', 'expiring', 'expired'];
/** BR-ATTR-08: scenes a conversion may use; fallback is whitelist-only, query is price-only. */
const CONVERT_SCENES: readonly PidScene[] = ['self_buy', 'share', 'agent', 'taolijin'];
const NO_LOG = { warn: () => undefined };

type AuditSnapshot = NonNullable<DB['audit_logs']['after']>;
type JsonRow = Record<string, string | number | boolean | null>;

function invalid(message: string): never {
  throw new UnionPidError('invalid_input', message);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isInstant(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isPidScene(value: unknown): value is PidScene {
  return typeof value === 'string' && (pid_scene as readonly string[]).includes(value);
}

/**
 * Row → plain JSON (instants as ISO strings, any bigint as a decimal string): used for audit
 * snapshots (jsonb) and for the stored idempotent result. JSON.stringify must never meet a bigint.
 */
function toJson(row: AccountRow | PidRow): JsonRow {
  const out: JsonRow = {};
  for (const [key, value] of Object.entries(row) as [string, unknown][]) {
    if (value instanceof Date) out[key] = value.toISOString();
    else if (typeof value === 'bigint') out[key] = value.toString();
    else out[key] = value as string | number | boolean | null;
  }
  return out;
}

function snapshot(row: AccountRow | PidRow): AuditSnapshot {
  return toJson(row);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** A PID or site id as the union reports it: no surrounding or embedded whitespace. */
function cleanIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${name} required`);
  if (UNCLEAN.test(value)) invalid(`${name} must not contain whitespace or control characters`);
  return value;
}

/**
 * Taobao PIDs are mm_<a>_<b>_<c> and carry site_id = <b>, the union's match key
 * (BR-ATTR-02); every other platform has no site_id (union_pids_site_check).
 */
function checkPidIdentity(platform: PidPlatform, pid: unknown, siteId: unknown) {
  const cleanPid = cleanIdentifier(pid, 'pid');
  if (platform === 'taobao') {
    const site = cleanIdentifier(siteId, 'taobao site_id');
    const match = TAOBAO_PID.exec(cleanPid);
    if (match === null) invalid('taobao pid must be mm_<digits>_<digits>_<digits>');
    if (match[2] !== site) invalid('taobao site_id must equal the second segment of the pid');
    return { pid: cleanPid, siteId: site };
  }
  if (siteId !== null) invalid('only taobao PIDs carry site_id');
  return { pid: cleanPid, siteId: null };
}

interface Scope {
  readonly table: 'union_accounts' | 'union_pids';
  readonly path: string;
  readonly body: Record<string, string | null>;
}

export function createUnionPidService(deps: PidServiceDeps): UnionPidService {
  const { db, clock } = deps;
  let idempotency = deps.idempotency;

  /**
   * Combined super + dynamic-code check on every write, never cached, before any transaction
   * (a row lock held across the verifier would serialize unrelated admins). Only the verifier's
   * returned identity is trusted: the audit actor is its (canonical) adminId, and an identity of
   * another app is refused. A verifier failure fails closed.
   */
  async function verify(ctx: WriteContext): Promise<{ appId: string; adminId: string }> {
    const verified = await deps.superVerifier.verify({
      appId: ctx.appId,
      adminId: ctx.adminId,
      code: ctx.code,
    });
    if (
      verified === null ||
      typeof verified !== 'object' ||
      verified.appId !== ctx.appId ||
      !nonBlank(verified.adminId)
    ) {
      throw new UnionPidError('not_verified', 'super verification failed');
    }
    return { appId: verified.appId, adminId: verified.adminId };
  }

  /**
   * Runs one command transaction. With an idempotency key: platform/idempotency in transactional
   * mode, scoped to (app, admin, command path, key) and hashed over the command's own fields
   * (never the dynamic code, the IP or the trace id, which change across retries).
   * The admin occupies the record's device slot (subject `d:<adminId>`): the `u:` slot would put
   * an admin id into idempotency_keys.user_id, a users column. Paths are /admin/v1/union-… labels
   * (02 §6.3 admin routes, not yet in the contract) so they never meet a /v1 user scope.
   */
  async function run<T extends AccountRow | PidRow>(
    input: WriteContext,
    actor: { appId: string; adminId: string },
    scope: Scope,
    work: (trx: Kysely<DB>) => Promise<T>,
  ): Promise<T> {
    if (input.idempotencyKey === undefined) return db.transaction().execute(work);
    idempotency ??= createIdempotency({ db, clock, logger: NO_LOG });
    const traceId = typeof input.traceId === 'string' ? input.traceId : '';
    let produced: T | undefined;
    let response: IdempotentResponse;
    try {
      response = await idempotency.executeInTransaction(
        {
          appId: actor.appId,
          actor: { userId: null, deviceId: actor.adminId.toLowerCase(), phoneHmac: null },
          method: 'POST',
          path: scope.path,
          key: input.idempotencyKey,
          body: scope.body,
          traceId,
        },
        async (trx) => {
          produced = await work(trx);
          return {
            status: 200,
            envelope: { code: 0, msg: '', data: toJson(produced), trace_id: traceId },
          };
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'IdempotencyError') {
        const code = (error as { code?: unknown }).code;
        if (code === 'invalid_subject') invalid('verified admin id is not a UUID');
      }
      throw error;
    }
    if (response.source === 'handler' && produced !== undefined) return produced;
    const envelope = JSON.parse(response.body) as { code?: unknown; data?: unknown };
    if (response.source === 'replay' && envelope.code === 0) {
      // Replay: the row the first call wrote (same id), read back; nothing is inserted again.
      const id = (envelope.data as { id?: unknown } | null)?.id;
      if (!isUuid(id)) throw new UnionPidError('conflict', 'stored idempotent result has no id');
      const row = await db
        .selectFrom(scope.table)
        .selectAll()
        .where('app_id', '=', actor.appId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined) throw new UnionPidError('not_found', 'replayed row not found');
      return row as T;
    }
    if (envelope.code === 40901) {
      throw new UnionPidError('idempotency_in_progress', 'same key is being processed');
    }
    if (envelope.code === 20001) invalid('idempotency key is missing or malformed');
    throw new UnionPidError('idempotency_conflict', 'idempotency key used for another request');
  }

  function checkContext(input: WriteContext): void {
    if (!nonBlank(input.appId)) invalid('appId required');
    if (typeof input.adminId !== 'string') invalid('adminId required');
    if (typeof input.code !== 'string') invalid('code required');
    if (input.idempotencyKey !== undefined) {
      if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
        invalid('idempotencyKey must be 8–64 characters of [A-Za-z0-9_-]');
      }
    }
    if (input.traceId !== undefined && typeof input.traceId !== 'string') {
      invalid('traceId must be a string');
    }
  }

  async function lockPid(trx: Kysely<DB>, appId: string, pidId: string): Promise<PidRow> {
    const row = await trx
      .selectFrom('union_pids')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', pidId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new UnionPidError('not_found', 'PID not found in this app');
    return row;
  }

  function casFailed(): never {
    throw new UnionPidError('conflict', 'row changed concurrently (row_version)');
  }

  return {
    async registerAccount(input) {
      checkContext(input);
      if (!isPlatform(input.platform)) invalid('unknown platform');
      if (!nonBlank(input.accountName)) invalid('accountName required');
      if (!AUTH_STATUSES.includes(input.authStatus)) invalid('unknown authStatus');
      if (input.authExpiresAt !== null && !isInstant(input.authExpiresAt)) {
        invalid('authExpiresAt must be an instant or null');
      }
      const accountName = input.accountName.trim();
      const actor = await verify(input);
      const scope: Scope = {
        table: 'union_accounts',
        path: '/admin/v1/union-accounts',
        body: {
          platform: input.platform,
          accountName,
          authStatus: input.authStatus,
          authExpiresAt: input.authExpiresAt === null ? null : input.authExpiresAt.toISOString(),
        },
      };
      return run(input, actor, scope, async (trx) => {
        const now = clock.now();
        const row = await trx
          .insertInto('union_accounts')
          .values({
            id: newUuidV7(now),
            app_id: actor.appId,
            platform: input.platform,
            account_name: accountName,
            status: 'pending',
            sync_start_at: null,
            auth_status: input.authStatus,
            auth_expires_at: input.authExpiresAt,
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await deps.auditWriter(trx).append({
          appId: actor.appId,
          actor: actor.adminId,
          action: 'union.account.register',
          target: `union_accounts:${row.id}`,
          before: null,
          after: snapshot(row),
          ip: input.ip,
        });
        return row;
      });
    },

    async registerPid(input) {
      checkContext(input);
      if (!isPlatform(input.platform)) invalid('unknown platform');
      if (!isUuid(input.unionAccountId)) invalid('unionAccountId must be a UUID');
      if (!isPidScene(input.pidScene)) invalid('unknown pid_scene');
      // Rejected, never rewritten: a stored value must equal what the union reports (BR-ATTR-02).
      const identity = checkPidIdentity(input.platform, input.pid, input.siteId);
      const actor = await verify(input);
      const scope: Scope = {
        table: 'union_pids',
        path: '/admin/v1/union-pids',
        body: {
          platform: input.platform,
          unionAccountId: input.unionAccountId.toLowerCase(),
          siteId: identity.siteId,
          pid: identity.pid,
          pidScene: input.pidScene,
        },
      };
      try {
        return await run(input, actor, scope, async (trx) => {
          // Lock the account: concurrent registrations under it serialize, so sync_start_at and
          // its audit are written by exactly the transactions that change it.
          const account = await trx
            .selectFrom('union_accounts')
            .selectAll()
            .where('app_id', '=', actor.appId)
            .where('platform', '=', input.platform)
            .where('id', '=', input.unionAccountId)
            .forUpdate()
            .executeTakeFirst();
          if (account === undefined) {
            throw new UnionPidError('not_found', 'union account not found for this app/platform');
          }
          const now = clock.now();
          // Only explicit columns: status is always pending, evidence always empty (BR-ATTR-28).
          const row = await trx
            .insertInto('union_pids')
            .values({
              id: newUuidV7(now),
              app_id: actor.appId,
              platform: input.platform,
              union_account_id: account.id,
              site_id: identity.siteId,
              pid: identity.pid,
              pid_scene: input.pidScene,
              status: 'pending',
              hjy_ignore_confirmed_at: null,
              hjy_ignore_evidence_path: null,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await deps.auditWriter(trx).append({
            appId: actor.appId,
            actor: actor.adminId,
            action: 'union.pid.register',
            target: `union_pids:${row.id}`,
            before: null,
            after: snapshot(row),
            ip: input.ip,
          });
          // BR-ATTR-02: sync_start_at = creation instant of this App's first PID under the
          // account; the earliest created_at wins even if a later-clocked PID committed first.
          if (account.sync_start_at === null || row.created_at < account.sync_start_at) {
            const updated = await trx
              .updateTable('union_accounts')
              .set((eb) => ({
                sync_start_at: row.created_at,
                updated_at: now,
                row_version: eb('row_version', '+', 1),
              }))
              .where('app_id', '=', actor.appId)
              .where('id', '=', account.id)
              .where('row_version', '=', account.row_version)
              .returningAll()
              .executeTakeFirst();
            if (updated === undefined) casFailed();
            await deps.auditWriter(trx).append({
              appId: actor.appId,
              actor: actor.adminId,
              action: 'union.account.sync_start',
              target: `union_accounts:${account.id}`,
              before: snapshot(account),
              after: snapshot(updated),
              ip: input.ip,
            });
          }
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new UnionPidError('duplicate', 'PID already registered for this app/platform');
        }
        throw error;
      }
    },

    async confirmHjyIgnore(input) {
      checkContext(input);
      if (!isUuid(input.pidId)) invalid('pidId must be a UUID');
      if (!isInstant(input.confirmedAt)) invalid('confirmedAt must be a valid instant');
      if (!nonBlank(input.evidencePath)) invalid('evidencePath must not be blank');
      const evidencePath = input.evidencePath.trim();
      const actor = await verify(input);
      const scope: Scope = {
        table: 'union_pids',
        path: `/admin/v1/union-pids/${input.pidId.toLowerCase()}/hjy-ignore`,
        body: { confirmedAt: input.confirmedAt.toISOString(), evidencePath },
      };
      return run(input, actor, scope, async (trx) => {
        const before = await lockPid(trx, actor.appId, input.pidId);
        // Evidence is filled while pending (BR-ATTR-28). After activation it is frozen: it is the
        // activation prerequisite, and an active row's updated_at must stay its activation time.
        if (before.status !== 'pending') {
          throw new UnionPidError('illegal_transition', 'evidence can change only while pending');
        }
        const now = clock.now();
        if (input.confirmedAt.getTime() > now.getTime()) invalid('confirmedAt is in the future');
        const row = await trx
          .updateTable('union_pids')
          .set((eb) => ({
            hjy_ignore_confirmed_at: input.confirmedAt,
            hjy_ignore_evidence_path: evidencePath,
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('app_id', '=', actor.appId)
          .where('id', '=', before.id)
          .where('row_version', '=', before.row_version)
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) casFailed();
        await deps.auditWriter(trx).append({
          appId: actor.appId,
          actor: actor.adminId,
          action: 'union.pid.confirm_hjy_ignore',
          target: `union_pids:${row.id}`,
          before: snapshot(before),
          after: snapshot(row),
          ip: input.ip,
        });
        return row;
      });
    },

    async setPidStatus(input) {
      checkContext(input);
      if (!isUuid(input.pidId)) invalid('pidId must be a UUID');
      const target: unknown = input.status;
      if (target !== 'active' && target !== 'retired') invalid('status must be active or retired');
      const actor = await verify(input);
      const scope: Scope = {
        table: 'union_pids',
        path: `/admin/v1/union-pids/${input.pidId.toLowerCase()}/status`,
        body: { status: target },
      };
      return run(input, actor, scope, async (trx) => {
        const before = await lockPid(trx, actor.appId, input.pidId);
        // Forward only: pending → active → retired (BR-ATTR-02). No delete.
        if (!canTransitionPid(before.status, target)) {
          throw new UnionPidError('illegal_transition', `cannot move ${before.status} → ${target}`);
        }
        // BR-ATTR-28: the stored confirmation instant and a nonblank screenshot path are
        // required on this PID itself; a confirmed sibling never stands in for it.
        if (
          target === 'active' &&
          (before.hjy_ignore_confirmed_at === null || !nonBlank(before.hjy_ignore_evidence_path))
        ) {
          throw new UnionPidError('evidence_missing', 'HJY ignore confirmation missing');
        }
        const now = clock.now();
        const next: PidStatus = target;
        const row = await trx
          .updateTable('union_pids')
          .set((eb) => ({
            status: next,
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('app_id', '=', actor.appId)
          .where('id', '=', before.id)
          .where('status', '=', before.status)
          .where('row_version', '=', before.row_version)
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) casFailed();
        await deps.auditWriter(trx).append({
          appId: actor.appId,
          actor: actor.adminId,
          action: next === 'active' ? 'union.pid.activate' : 'union.pid.retire',
          target: `union_pids:${row.id}`,
          before: snapshot(before),
          after: snapshot(row),
          ip: input.ip,
        });
        return row;
      });
    },

    /**
     * Active PID for app × platform × pid_scene (BR-ATTR-02, BR-ATTR-08, BR-PROD-07).
     * purpose=convert accepts only self_buy / share / agent / taolijin; purpose=query accepts
     * only the query scene. fallback is never returned, and a missing scene does not fall back
     * to another scene (default awaiting owner confirmation).
     * Several active rows in one scene: the earliest activated wins (default awaiting owner
     * confirmation). An active row is never updated after activation (evidence is frozen once
     * the row leaves pending, and retire moves it out of active), so its updated_at is its
     * activation instant.
     */
    async getActivePid(input) {
      const allowed =
        input.purpose === 'convert'
          ? CONVERT_SCENES.includes(input.pidScene)
          : input.purpose === 'query' && input.pidScene === 'query';
      if (!allowed || !isPlatform(input.platform) || typeof input.appId !== 'string') return null;
      const row = await db
        .selectFrom('union_pids')
        .selectAll()
        .where('app_id', '=', input.appId)
        .where('platform', '=', input.platform)
        .where('pid_scene', '=', input.pidScene)
        .where('status', '=', 'active')
        .orderBy('updated_at', 'asc')
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .limit(1)
        .executeTakeFirst();
      return row ?? null;
    },

    /**
     * BR-ATTR-02 attribution whitelist: pending, active and retired all count. Match key:
     * taobao (platform, union_account_id, site_id, adzone pid); other platforms
     * (platform, union_account_id, pid). A pid or site id carrying whitespace or control
     * characters is refused (invalid_input), the same rule as registration: the caller must
     * pass the union's value unchanged, never a value this query silently trimmed.
     */
    async isWhitelisted(input) {
      for (const value of [input.pid, input.siteId]) {
        if (typeof value === 'string' && UNCLEAN.test(value)) {
          invalid('pid and site_id must not contain whitespace or control characters');
        }
      }
      if (
        typeof input.appId !== 'string' ||
        !isPlatform(input.platform) ||
        !isUuid(input.unionAccountId) ||
        typeof input.pid !== 'string' ||
        input.pid.length === 0 ||
        (input.platform === 'taobao' && typeof input.siteId !== 'string')
      ) {
        return false;
      }
      let query = db
        .selectFrom('union_pids')
        .select('id')
        .where('app_id', '=', input.appId)
        .where('platform', '=', input.platform)
        .where('union_account_id', '=', input.unionAccountId)
        .where('pid', '=', input.pid);
      if (input.platform === 'taobao') {
        if (typeof input.siteId !== 'string') return false;
        query = query.where('site_id', '=', input.siteId);
      }
      const row = await query.limit(1).executeTakeFirst();
      return row !== undefined;
    },
  };
}
