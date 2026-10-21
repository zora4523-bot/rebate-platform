// Read-only queries of app.audit_logs for the admin console's audit search (B1-34a; contract
// adminListAuditLogs / adminGetAuditLog; 04 §3.2). Separate from the platform AuditPort (whose
// only method is append): this object never writes. Always one app_id; newest first (`at`, then
// the primary key, both descending). The actor's current name comes from admin_users (left join:
// a missing account reads as null). The derived-field filters arrive as condition plans built by
// ../domain/audit-log-view.ts from its action table, so SQL and the derivation agree.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import { AUDIT_TARGET_ID_MAX, type AuditCondition } from '../domain/audit-log-view.ts';

/** A stored before / after value: any JSON, null when none was recorded. */
export type AuditSnapshot = DB['audit_logs']['before'];

export interface AuditLogRow {
  readonly id: bigint;
  readonly adminId: string;
  readonly displayName: string | null;
  readonly loginName: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly before: AuditSnapshot;
  readonly after: AuditSnapshot;
  readonly ip: string | null;
  readonly at: Date;
}

export interface AuditLogFilter {
  readonly appId: string;
  /** Only this account's records; undefined: every account's. */
  readonly actorId?: string;
  /** Inclusive / exclusive bounds, ISO 8601 with offset (already validated). */
  readonly from?: string;
  readonly to?: string;
  /** Each entry is an OR of conditions, entries combine with AND; [] in an entry matches none. */
  readonly derived: readonly (readonly AuditCondition[])[];
}

export interface AuditLogStore {
  count(filter: AuditLogFilter): Promise<number>;
  page(filter: AuditLogFilter, offset: number, limit: number): Promise<AuditLogRow[]>;
  /** One record of the app (and of `actorId` when given); undefined when there is none. */
  byId(appId: string, id: bigint, actorId?: string): Promise<AuditLogRow | undefined>;
}

type Builder = ExpressionBuilder<DB & { l: DB['audit_logs'] }, 'l'>;

function condition(eb: Builder, plan: AuditCondition): Expression<SqlBool> {
  const action = eb('l.action', 'in', [...plan.actions]);
  switch (plan.kind) {
    case 'actions':
      return action;
    case 'targetEquals':
      return eb.and([action, eb('l.target', '=', plan.target)]);
    case 'targetIn':
      return eb.and([action, eb('l.target', 'in', [...plan.targets])]);
    case 'target': {
      const prefix = plan.prefix ?? '';
      return eb.and([
        action,
        eb('l.target', 'is not', null),
        sql<SqlBool>`starts_with(l.target, ${prefix})`,
        sql<SqlBool>`char_length(l.target) between ${prefix.length + 1} and ${
          prefix.length + AUDIT_TARGET_ID_MAX
        }`,
      ]);
    }
    case 'afterField':
      return eb.and([
        action,
        sql<SqlBool>`jsonb_typeof(l.after) = 'object'`,
        sql<SqlBool>`jsonb_typeof(l.after -> ${plan.field}::text) = 'string'`,
        sql<SqlBool>`(l.after ->> ${plan.field}::text) in (${sql.join([...plan.values])})`,
      ]);
  }
}

function where(eb: Builder, filter: AuditLogFilter): Expression<SqlBool> {
  const parts: Expression<SqlBool>[] = [eb('l.app_id', '=', filter.appId)];
  if (filter.actorId !== undefined) parts.push(eb('l.admin_id', '=', filter.actorId));
  if (filter.from !== undefined) {
    parts.push(sql<SqlBool>`l.at >= ${filter.from}::timestamptz`);
  }
  if (filter.to !== undefined) parts.push(sql<SqlBool>`l.at < ${filter.to}::timestamptz`);
  for (const any of filter.derived) {
    parts.push(
      any.length === 0 ? sql<SqlBool>`false` : eb.or(any.map((plan) => condition(eb, plan))),
    );
  }
  return eb.and(parts);
}

export function createAuditLogStore(deps: { readonly db: Kysely<DB> }): AuditLogStore {
  const { db } = deps;
  /** Rows of the app matching `scope`, with the actor's names (joined after the filter). */
  const rows = (scope: (eb: Builder) => Expression<SqlBool>) =>
    db
      .selectFrom('audit_logs as l')
      .where(scope)
      .leftJoin('admin_users as u', (join) =>
        join.onRef('u.app_id', '=', 'l.app_id').onRef('u.id', '=', 'l.admin_id'),
      )
      .select([
        'l.id',
        'l.admin_id',
        'u.display_name',
        'u.login_name',
        'l.action',
        'l.target',
        'l.before',
        'l.after',
        'l.ip',
        'l.at',
      ]);
  type Selected = Awaited<ReturnType<ReturnType<typeof rows>['execute']>>[number];
  const toRow = (row: Selected): AuditLogRow => ({
    id: row.id,
    adminId: row.admin_id,
    displayName: row.display_name,
    loginName: row.login_name,
    action: row.action,
    target: row.target,
    before: row.before,
    after: row.after,
    ip: row.ip,
    at: row.at,
  });

  return {
    async count(filter) {
      const row = await db
        .selectFrom('audit_logs as l')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .where((eb) => where(eb, filter))
        .executeTakeFirstOrThrow();
      return Number(row.total);
    },

    async page(filter, offset, limit) {
      const found = await rows((eb) => where(eb, filter))
        .orderBy('l.at', 'desc')
        .orderBy('l.id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      return found.map(toRow);
    },

    async byId(appId, id, actorId) {
      const row = await rows((eb) =>
        eb.and([
          eb('l.app_id', '=', appId),
          eb('l.id', '=', id),
          ...(actorId === undefined ? [] : [eb('l.admin_id', '=', actorId)]),
        ]),
      ).executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },
  };
}
