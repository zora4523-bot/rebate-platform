// Union account and PID (推广位) service (B1-19b; 规划/02 §6.3; BR-ATTR-02, BR-ATTR-08,
// BR-ATTR-28, BR-PROD-07). union is the only writer of union_accounts / union_pids.
//
// Every command that writes either table (account registration, PID registration incl. the
// implicit sync_start_at write, HJY confirmation, activation, retirement) first runs the injected
// combined "super account + dynamic code" verifier (F1-06b), outside any transaction, then opens a
// transaction, locks the row, writes, and appends the audit row on the same transaction: an audit
// failure rolls the business write back. There is no delete and no free-form update.
//
// Read queries (getActivePid, isWhitelisted) never verify or audit and work on a read-only role.
//
// Pure module (no decorators, erasable syntax, type-only imports from other modules): command
// line tools can run it with node directly. union never imports admin: the verifier and audit
// writer are received structurally from the caller.
import { randomUUID } from 'node:crypto';
import { pid_scene, type PidScene, type components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { isPlatform } from '../domain/types.ts';

export type PidPlatform = components['schemas']['PlatformCode'];
export type PidStatus = 'pending' | 'active' | 'retired';
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
}

export interface WriteContext {
  readonly appId: string;
  readonly adminId: string;
  readonly code: string;
  readonly ip: string | null;
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
  | 'duplicate';

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
const UNIQUE_VIOLATION = '23505';
const AUTH_STATUSES: readonly string[] = ['active', 'expiring', 'expired'];
/** BR-ATTR-08: scenes a conversion may use; fallback is whitelist-only, query is price-only. */
const CONVERT_SCENES: readonly PidScene[] = ['self_buy', 'share', 'agent', 'taolijin'];

type AuditSnapshot = NonNullable<DB['audit_logs']['after']>;

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

/** Row → JSON snapshot for audit_logs (instants as ISO strings). */
function snapshot(row: AccountRow | PidRow): AuditSnapshot {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value instanceof Date ? value.toISOString() : (value as string | number | boolean | null);
  }
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** Taobao PIDs carry site_id; every other platform has none (union_pids_site_check). */
function checkSite(platform: PidPlatform, siteId: unknown): string | null {
  if (platform === 'taobao') {
    if (!nonBlank(siteId)) invalid('taobao PID requires site_id');
    return siteId;
  }
  if (siteId !== null) invalid('only taobao PIDs carry site_id');
  return null;
}

export function createUnionPidService(deps: PidServiceDeps): UnionPidService {
  const { db, clock } = deps;

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

  function checkContext(input: WriteContext): void {
    if (!nonBlank(input.appId)) invalid('appId required');
    if (typeof input.adminId !== 'string') invalid('adminId required');
    if (typeof input.code !== 'string') invalid('code required');
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
      const actor = await verify(input);
      return db.transaction().execute(async (trx) => {
        const now = clock.now();
        const row = await trx
          .insertInto('union_accounts')
          .values({
            id: randomUUID(),
            app_id: actor.appId,
            platform: input.platform,
            account_name: input.accountName.trim(),
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
      if (!nonBlank(input.pid)) invalid('pid required');
      if (!isPidScene(input.pidScene)) invalid('unknown pid_scene');
      const siteId = checkSite(input.platform, input.siteId);
      const actor = await verify(input);
      try {
        return await db.transaction().execute(async (trx) => {
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
              id: randomUUID(),
              app_id: actor.appId,
              platform: input.platform,
              union_account_id: account.id,
              site_id: siteId,
              pid: input.pid,
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
              .returningAll()
              .executeTakeFirstOrThrow();
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
      const actor = await verify(input);
      return db.transaction().execute(async (trx) => {
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
            hjy_ignore_evidence_path: input.evidencePath.trim(),
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('app_id', '=', actor.appId)
          .where('id', '=', before.id)
          .returningAll()
          .executeTakeFirstOrThrow();
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
      return db.transaction().execute(async (trx) => {
        const before = await lockPid(trx, actor.appId, input.pidId);
        // Forward only: pending → active → retired (BR-ATTR-02). No delete.
        if (target === 'active') {
          if (before.status !== 'pending') {
            throw new UnionPidError('illegal_transition', `cannot activate from ${before.status}`);
          }
          // BR-ATTR-28: the stored confirmation instant and a nonblank screenshot path are
          // required on this PID itself; a confirmed sibling never stands in for it.
          if (
            before.hjy_ignore_confirmed_at === null ||
            !nonBlank(before.hjy_ignore_evidence_path)
          ) {
            throw new UnionPidError('evidence_missing', 'HJY ignore confirmation missing');
          }
        } else if (before.status !== 'active') {
          throw new UnionPidError('illegal_transition', `cannot retire from ${before.status}`);
        }
        const now = clock.now();
        const row = await trx
          .updateTable('union_pids')
          .set((eb) => ({
            status: target,
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('app_id', '=', actor.appId)
          .where('id', '=', before.id)
          .where('status', '=', before.status)
          .returningAll()
          .executeTakeFirstOrThrow();
        await deps.auditWriter(trx).append({
          appId: actor.appId,
          actor: actor.adminId,
          action: target === 'active' ? 'union.pid.activate' : 'union.pid.retire',
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
     * (platform, union_account_id, pid).
     */
    async isWhitelisted(input) {
      if (
        typeof input.appId !== 'string' ||
        !isPlatform(input.platform) ||
        !isUuid(input.unionAccountId) ||
        typeof input.pid !== 'string' ||
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
