import { expect, it, vi } from 'vitest';
import {
  auditRangeInvalid,
  type AuditLogsReader,
} from '../../../../apps/api/src/modules/admin/application/audit-logs-read.ts';

it('[AC-B1-34j#2] from/to 比较到微秒，等值、顺序、时区及缺省边界保持正确', () => {
  const cases: readonly (readonly [string | undefined, string | undefined, boolean])[] = [
    ['2026-10-23T00:00:00.000500Z', '2026-10-23T00:00:00.000100Z', true],
    ['2026-10-23T00:00:00.000101Z', '2026-10-23T00:00:00.000100Z', true],
    ['2026-10-23T08:00:00.000501+08:00', '2026-10-23T00:00:00.000500Z', true],
    ['2026-10-22T19:00:00.123457-05:00', '2026-10-23T00:00:00.123456Z', true],
    ['2026-10-23T00:00:00.000100Z', '2026-10-23T00:00:00.000500Z', false],
    ['2026-10-23T00:00:00.000500Z', '2026-10-23T00:00:00.000500Z', false],
    ['2026-10-23T08:00:00.000500+08:00', '2026-10-23T00:00:00.0005Z', false],
    ['2026-10-22T19:00:00.1-05:00', '2026-10-23T00:00:00.100000Z', false],
    ['2026-10-23T00:00:00Z', '2026-10-23T00:00:00.000000Z', false],
    ['2026-10-23T00:00:00.000001Z', '2026-10-23T00:00:00Z', true],
    ['2026-10-23T00:00:00.001000Z', '2026-10-23T00:00:00.000999Z', true],
    ['2026-10-22T23:59:59.999999Z', '2026-10-23T00:00:00Z', false],
    ['2026-10-23T08:00:00.000100+08:00', '2026-10-23T01:00:00.000000Z', false],
    ['2026-10-23T00:00:00.000100Z', '2026-10-23T01:00:00.000500+02:00', true],
    ['2026-10-23T00:00:00.000500Z', undefined, false],
    [undefined, '2026-10-23T00:00:00.000100Z', false],
    [undefined, undefined, false],
  ];
  for (const [from, to, invalid] of cases) {
    expect.soft(auditRangeInvalid(from, to), `${from} / ${to}`).toBe(invalid);
  }
});

it('[AC-B1-34j#3] adminListAuditLogs 微秒倒置返回 20001 和精确字段列表，拒绝前不读库', async () => {
  // URL import follows the existing rule-test convention for decorated API controllers:
  // the test TS project uses erasable syntax; Vite compiles the API with its own tsconfig.
  const { AdminAuditLogsController } = (await import(
    new URL(
      '../../../../apps/api/src/modules/admin/http/admin/audit-logs.controller.ts',
      import.meta.url,
    ).href
  )) as {
    AdminAuditLogsController: new (reader: AuditLogsReader) => {
      list(request: object): Promise<unknown>;
    };
  };
  const list = vi.fn<AuditLogsReader['list']>(async (_caller, query) => ({
    items: [],
    page: query.page,
    pageSize: query.pageSize,
    total: 0,
  }));
  const controller = new AdminAuditLogsController({ list, get: async () => undefined });
  const request = {
    id: 'b134j-range',
    adminPrincipal: {
      appId: 'read_hardening',
      adminId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
      sessionId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02',
      isSuper: false,
    },
    params: {},
  };
  const to = '2026-10-23T00:00:00.000100Z';
  await expect(controller.list({ ...request, query: { from: to, to } })).resolves.toMatchObject({
    code: 0,
    data: { items: [], total: 0 },
  });
  expect(list).toHaveBeenCalledTimes(1);
  list.mockClear();
  await expect(
    controller.list({ ...request, query: { from: '2026-10-23T00:00:00.000500Z', to } }),
  ).rejects.toMatchObject({
    status: 400,
    response: { code: 20001, data: { fields: ['from', 'to'] }, trace_id: request.id },
  });
  expect(list).not.toHaveBeenCalled();
});
