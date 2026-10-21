import { expect, it } from 'vitest';
import { createAuditLogIdCodec } from '../infra/audit-log-id.ts';
import type { AuditLogFilter, AuditLogRow, AuditLogStore } from '../infra/audit-log-store.ts';
import { auditRangeInvalid, createAuditLogsReader, type AuditCaller } from './audit-logs-read.ts';

const ME = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const OTHER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02';
const ids = createAuditLogIdCodec(Buffer.alloc(16, 3));

function row(id: bigint, adminId: string, patch: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id,
    adminId,
    displayName: null,
    loginName: 'ops01',
    action: 'admin.login',
    target: `admin_users:${adminId}`,
    before: null,
    after: null,
    ip: '192.0.2.1',
    at: new Date(Date.parse('2026-10-08T00:00:00Z')),
    ...patch,
  };
}

function setup(ticked: string[] = []) {
  const rows = [row(2n, OTHER, { displayName: '运营乙' }), row(1n, ME)];
  const filters: AuditLogFilter[] = [];
  const store: AuditLogStore = {
    count: (filter) => {
      filters.push(filter);
      return Promise.resolve(
        rows.filter((r) => filter.actorId === undefined || r.adminId === filter.actorId).length,
      );
    },
    page: (filter) =>
      Promise.resolve(
        rows.filter((r) => filter.actorId === undefined || r.adminId === filter.actorId),
      ),
    byId: (_appId, id, actorId) =>
      Promise.resolve(
        rows.find((r) => r.id === id && (actorId === undefined || r.adminId === actorId)),
      ),
  };
  const reader = createAuditLogsReader({
    store,
    profiles: { permissionKeys: () => Promise.resolve(ticked) },
    ids: () => ids,
    configPermissions: new Map(),
  });
  return { reader, filters };
}

const caller: AuditCaller = { appId: 'couli', adminId: ME, isSuper: false };
const query = { page: 1, pageSize: 20 };

it('[AC-B1-34a] without audit.view_all the actor is forced to the caller', async () => {
  const { reader, filters } = setup(['risk.ban']);
  const own = await reader.list(caller, query);
  expect(own.items.map((item) => item.actorId)).toEqual([ME]);
  expect(own.items[0]).toMatchObject({ actorName: 'ops01', targetType: 'admin_user' });
  expect(filters[0]).toMatchObject({ appId: 'couli', actorId: ME });
  expect(await reader.list(caller, { ...query, actorId: OTHER })).toEqual({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
  });
  expect(filters).toHaveLength(1);
  expect(await reader.get(caller, ids.encode(2n))).toBeUndefined();
  expect((await reader.get(caller, ids.encode(1n)))?.actorId).toBe(ME);
});

it('[AC-B1-34a] audit.view_all or super sees every account; names fall back to the username', async () => {
  for (const [ticked, isSuper] of [
    [['audit.view_all'], false],
    [[], true],
  ] as const) {
    const { reader } = setup([...ticked]);
    const all = await reader.list({ ...caller, isSuper }, query);
    expect(all.items.map((item) => [item.actorId, item.actorName])).toEqual([
      [OTHER, '运营乙'],
      [ME, 'ops01'],
    ]);
    expect((await reader.get({ ...caller, isSuper }, ids.encode(2n)))?.actorId).toBe(OTHER);
  }
});

it('[AC-B1-34a] a filter that can match nothing and a malformed id never query', async () => {
  const { reader, filters } = setup(['audit.view_all']);
  expect((await reader.list(caller, { ...query, permission: 'invented.permission' })).total).toBe(
    0,
  );
  expect((await reader.list(caller, { ...query, targetType: 'nothing' })).total).toBe(0);
  expect(filters).toEqual([]);
  expect(await reader.get(caller, 'aud_AAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
});

it('[AC-B1-34a] from later than to is refused; equal or one-sided bounds are not', () => {
  expect(auditRangeInvalid('2026-10-09T00:00:00Z', '2026-10-08T00:00:00Z')).toBe(true);
  expect(auditRangeInvalid('2026-10-08T08:00:00+08:00', '2026-10-08T00:00:00Z')).toBe(false);
  expect(auditRangeInvalid('2026-10-09T00:00:00Z', undefined)).toBe(false);
});
