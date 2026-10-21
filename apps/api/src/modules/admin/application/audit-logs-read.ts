// Audit search of the admin console (B1-34a; contract adminListAuditLogs / adminGetAuditLog,
// CT-24c; 04 §6.6 audit-logs, §11.1 audit.view_all). Any signed-in account; the app is the
// authenticated principal's. Visibility is enforced here: an account holding audit.view_all (a
// super admin holds every point) sees every account's records; any other account only its own —
// the actor filter is forced to the caller, another account's actor_id is an empty page, and
// another account's record reads as unknown (20001 [id], as for a malformed or foreign id).
// Reads only: searching and reading write no audit record.
//
// Pure module (no decorators, erasable syntax).
import type { AdminPermission } from '@couli/contracts-ts';
import {
  AUDIT_VIEW_ALL,
  deriveAudit,
  permissionMatch,
  targetIdMatch,
  targetTypeMatch,
  type AuditCondition,
  type ConfigPermissions,
} from '../domain/audit-log-view.ts';
import type { AuditLogIdCodec } from '../infra/audit-log-id.ts';
import type { AuditLogRow, AuditLogStore, AuditSnapshot } from '../infra/audit-log-store.ts';
import type { AdminProfiles } from '../infra/admin-profiles.ts';

/** The authenticated caller (from the admin request check). */
export interface AuditCaller {
  readonly appId: string;
  readonly adminId: string;
  readonly isSuper: boolean;
}

/** Query parameters, already validated against the contract (page ≥ 1, page_size 1–200). */
export interface AuditQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly actorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly permission?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface AuditLogItemView {
  readonly id: string;
  readonly actorId: string;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly permission: AdminPermission | null;
  readonly ip: string | null;
  readonly at: Date;
}

export interface AuditLogDetailView extends AuditLogItemView {
  readonly before: AuditSnapshot;
  readonly after: AuditSnapshot;
}

export interface AuditLogsPage {
  readonly items: AuditLogItemView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface AuditLogsReader {
  list(caller: AuditCaller, query: AuditQuery): Promise<AuditLogsPage>;
  /** undefined: malformed, altered, unknown, foreign or not visible to the caller (all 20001). */
  get(caller: AuditCaller, id: string): Promise<AuditLogDetailView | undefined>;
}

/** `from` later than `to` (both given): the contract's 20001 [from, to]. */
export function auditRangeInvalid(from: string | undefined, to: string | undefined): boolean {
  return from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to);
}

export function createAuditLogsReader(deps: {
  readonly store: AuditLogStore;
  readonly profiles: Pick<AdminProfiles, 'permissionKeys'>;
  readonly ids: () => AuditLogIdCodec;
  readonly configPermissions: ConfigPermissions;
}): AuditLogsReader {
  const { store, profiles, configPermissions } = deps;

  const viewsAll = async (caller: AuditCaller): Promise<boolean> =>
    caller.isSuper ||
    (await profiles.permissionKeys(caller.appId, caller.adminId)).includes(AUDIT_VIEW_ALL);

  const item = (row: AuditLogRow): AuditLogItemView => {
    const derived = deriveAudit(row, configPermissions);
    const name =
      row.displayName !== null && row.displayName !== '' ? row.displayName : row.loginName;
    return {
      id: deps.ids().encode(row.id),
      actorId: row.adminId,
      actorName: name,
      action: row.action,
      targetType: derived.targetType,
      targetId: derived.targetId,
      permission: derived.permission,
      ip: row.ip,
      at: row.at,
    };
  };

  return {
    async list(caller, query) {
      const all = await viewsAll(caller);
      const empty = { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
      let actorId = query.actorId?.toLowerCase();
      if (!all) {
        if (actorId !== undefined && actorId !== caller.adminId.toLowerCase()) return empty;
        actorId = caller.adminId;
      }
      const derived: (readonly AuditCondition[])[] = [];
      if (query.targetType !== undefined) derived.push(targetTypeMatch(query.targetType));
      if (query.targetId !== undefined) derived.push(targetIdMatch(query.targetId));
      if (query.permission !== undefined) {
        derived.push(permissionMatch(query.permission, configPermissions));
      }
      // A filter that can match no row answers the empty page without a query.
      if (derived.some((any) => any.length === 0)) return empty;
      const filter = {
        appId: caller.appId,
        ...(actorId === undefined ? {} : { actorId }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        derived,
      };
      const total = await store.count(filter);
      const rows = await store.page(filter, (query.page - 1) * query.pageSize, query.pageSize);
      return { items: rows.map(item), page: query.page, pageSize: query.pageSize, total };
    },

    async get(caller, id) {
      const key = deps.ids().decode(id);
      if (key === undefined) return undefined;
      const all = await viewsAll(caller);
      const row = await store.byId(caller.appId, key, all ? undefined : caller.adminId);
      if (row === undefined) return undefined;
      return { ...item(row), before: row.before, after: row.after };
    },
  };
}
