import { expect, it } from 'vitest';
import { createAuditLogsReader } from '../../../../apps/api/src/modules/admin/application/audit-logs-read.ts';
import { createAuditLogIdCodec } from '../../../../apps/api/src/modules/admin/infra/audit-log-id.ts';
import type {
  AuditLogFilter,
  AuditLogRow,
  AuditLogStore,
} from '../../../../apps/api/src/modules/admin/infra/audit-log-store.ts';

const APP = 'read_hardening';
const ME = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const OTHER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02';
const UNKNOWN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b03';

function setup(permissions: string[], isSuper: boolean) {
  const rows: AuditLogRow[] = [ME, OTHER].map((adminId, index) => ({
    id: BigInt(index + 1),
    adminId,
    displayName: null,
    loginName: 'operator',
    action: 'admin.login',
    target: `admin_users:${adminId}`,
    before: null,
    after: null,
    ip: null,
    at: new Date('2026-10-23T00:00:00.000Z'),
  }));
  // This port double models the UUID-column failure, without PostgreSQL or a connection.
  // A permissive array filter would incorrectly hide the original 22P02 regression.
  function matching(filter: AuditLogFilter): AuditLogRow[] {
    if (
      filter.actorId !== undefined &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(filter.actorId)
    ) {
      throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
    }
    return rows.filter(
      (row) =>
        filter.appId === APP &&
        (filter.actorId === undefined || row.adminId === filter.actorId.toLowerCase()),
    );
  }
  const store: AuditLogStore = {
    async count(filter) {
      return matching(filter).length;
    },
    async page(filter, offset, limit) {
      return matching(filter).slice(offset, offset + limit);
    },
    async byId() {
      return undefined;
    },
  };
  const ids = createAuditLogIdCodec(Buffer.alloc(16, 34));
  return {
    caller: { appId: APP, adminId: ME, isSuper },
    reader: createAuditLogsReader({
      store,
      profiles: { permissionKeys: async () => permissions },
      ids: () => ids,
      configPermissions: new Map(),
    }),
  };
}

it('[AC-B1-34j#1] actor_id 非 UUID 对有无 audit.view_all 及超级管理员均为空页，合法筛选仍按权限生效', async () => {
  for (const access of [
    { permissions: [], isSuper: false, all: false },
    { permissions: ['audit.view_all'], isSuper: false, all: true },
    { permissions: [], isSuper: true, all: true },
  ]) {
    const { reader, caller } = setup(access.permissions, access.isSuper);
    const query = { page: 1, pageSize: 20 };
    const unfiltered = await reader.list(caller, query);
    expect(unfiltered.items.map((row) => row.actorId)).toEqual(access.all ? [ME, OTHER] : [ME]);
    expect(unfiltered.total).toBe(access.all ? 2 : 1);
    const own = await reader.list(caller, { ...query, actorId: ME.toUpperCase() });
    expect(own.items.map((row) => row.actorId)).toEqual([ME]);
    expect(own.total).toBe(1);
    const other = await reader.list(caller, { ...query, actorId: OTHER });
    expect(other.items.map((row) => row.actorId)).toEqual(access.all ? [OTHER] : []);
    expect(other.total).toBe(access.all ? 1 : 0);

    for (const actorId of [UNKNOWN, 'not-a-uuid', `${ME}x`, ME.replace('0199', 'g199')]) {
      // Compare the captured outcome so port errors fail the empty-page assertion.
      let result: unknown;
      try {
        result = await reader.list(caller, { page: 3, pageSize: 7, actorId });
      } catch (error) {
        result = error;
      }
      expect.soft(result).toEqual({
        items: [],
        total: 0,
        page: 3,
        pageSize: 7,
      });
    }
  }
});
