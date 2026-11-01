// CT-24zi 涉税季度导出的契约登记（BR-WDR-21、D10-544）。独立预期来自任务书第 9 节，不从契约生成；
// 全部静态读 contracts 与 specs，不连库、不 listen。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  body,
  contract,
  description,
  enumField,
  field,
  list,
  object,
  op,
  required,
  resolve,
  yaml,
} from '../admin-order-actions/kit.ts';

const exportsPath = '/admin/v1/exports';
const taxRequest = '#/components/schemas/AdminExportCreateTaxWithdrawalsRequest';
const masked = { resource: 'tax_withdrawals', filters: { quarter: '2026-Q4' } };
const full = { ...masked, unmasked: true, reason: '2026 年第四季度个税申报' };
const taskRoutes = [
  ['get', exportsPath, 'adminListExports'],
  ['get', `${exportsPath}/{id}/download`, 'adminDownloadExport'],
  ['post', `${exportsPath}/{id}/retry`, 'adminRetryExport'],
] as const;

// 权限点的键带点号：不经 at()（toHaveProperty 会把点号当路径），取键名再比较。
function declaredValues(name: string): string[] {
  return Object.keys(at(yaml('contracts/enums/admin.yaml'), 'enums', name, 'values'));
}

it('[AC-CT-24zi#1] 枚举登记权限点 tax.export_full 与导出来源 tax_withdrawals', () => {
  expect(declaredValues('admin_permission')).toContain('tax.export_full');
  expect(declaredValues('export_resource')).toContain('tax_withdrawals');
});

it('[AC-CT-24zi#2] tax.export_full 的 step-up 档位是 totp，没有另定档位的操作', () => {
  const entries = list(yaml('specs/permissions.yaml')['permissions']).map(object);
  expect(entries.filter((entry) => entry['key'] === 'tax.export_full')).toEqual([
    { key: 'tax.export_full', step_up_tier: 'totp', operations: [] },
  ]);
});

it('[AC-CT-24zi#3] 创建请求含 tax_withdrawals 分支：filters 必填 quarter，可带 unmasked、reason', () => {
  const doc = contract();
  const request = body(doc, exportsPath);
  expect(list(request['oneOf'])).toContainEqual({ $ref: taxRequest });

  const branch = resolve(doc, { $ref: taxRequest });
  expect(branch['additionalProperties']).toBe(false);
  required(branch, ['resource', 'filters']);
  expect(at(branch, 'properties')).toHaveProperty('unmasked');
  expect(at(branch, 'properties')).toHaveProperty('reason');
  enumField(doc, branch, 'resource', ['tax_withdrawals']);

  const filters = field(doc, branch, 'filters');
  required(filters, ['quarter']);
  accepts(
    doc,
    filters,
    [{ quarter: '2026-Q4' }],
    [{}, { quarter: '2026-Q5' }, { quarter: '2026Q4' }],
  );

  accepts(
    doc,
    branch,
    [masked, full],
    [
      { ...masked, note: '多余字段' },
      { ...masked, resource: 'users' },
      { filters: masked.filters },
      { resource: masked.resource },
    ],
  );
  accepts(doc, request, [masked, full], [{ ...masked, filters: { quarter: '2026Q4' } }]);
});

it('[AC-CT-24zi#4] adminCreateExport 的描述写明 tax.export_full、fund.view 与 BR-WDR-21', () => {
  const doc = contract();
  expect(op(doc, exportsPath)['operationId']).toBe('adminCreateExport');
  const text = description(doc, exportsPath);
  expect(text).toContain('tax.export_full');
  expect(text).toContain('fund.view');
  expect(text).toContain('BR-WDR-21');
});

it('[AC-CT-24zi#5] 任务列表、下载、重试的描述都写明 tax.export_full', () => {
  const doc = contract();
  for (const [method, path, operationId] of taskRoutes) {
    expect(op(doc, path, method)['operationId']).toBe(operationId);
    expect(description(doc, path, method), operationId).toContain('tax.export_full');
  }
});
