import { expect, it } from 'vitest';
import { at, list, object, read, yaml } from './kit.ts';

// 字典键按 BR-TEXT-25 的表字段路径；枚举名按本任务明确分配的六个名称。
const catalogs = [
  ['order_sync_mode', 'order_sync_requests.mode', { window: '按时间窗', order_nos: '按订单号' }],
  [
    'order_sync_status',
    'order_sync_requests.status',
    {
      queued: '排队中',
      running: '同步中',
      done: '已完成',
      failed: '失败',
    },
  ],
  [
    'rights_import_kind',
    'rights_imports.kind',
    { rights: '维权单', punish: '违规单', channel: '渠道单' },
  ],
  [
    'rights_import_time_basis',
    'rights_imports.time_basis',
    { paid: '付款时间', received: '收货时间' },
  ],
  [
    'rights_import_status',
    'rights_imports.status',
    {
      queued: '排队中',
      running: '导入中',
      done: '已完成',
      failed: '失败',
    },
  ],
  [
    'rights_import_failure_reason',
    'rights_import_failure_reason',
    {
      invalid_row: '行格式不对',
      order_not_found: '订单不在本系统',
      sub_order_no_missing: '缺子订单号',
      received_at_missing: '无收货时间',
      platform_mismatch: '平台不符',
    },
  ],
] as const;

it.each(catalogs)('[AC-CT-24n#18] %s 的取值全集和 %s 默认中文名', (name, dict, expected) => {
  const catalogs = ['contracts/enums/order.yaml', 'contracts/enums/admin.yaml'].map((path) =>
    at(yaml(path), 'enums'),
  );
  const definitions = catalogs.filter((catalog) => Object.hasOwn(catalog, name));
  expect(definitions, `${name} 应有且只有一份定义`).toHaveLength(1);
  const values = at(definitions[0], name, 'values');
  expect(Object.keys(values).toSorted()).toEqual(Object.keys(expected).toSorted());
  const texts = at(object(JSON.parse(read('contracts/texts.admin.default.json'))), 'texts');
  for (const [value, label] of Object.entries(expected)) {
    expect(texts[`admin_dict.${dict}.${value}`]).toBe(label);
  }
});

it('[AC-CT-24n#19] 30156 独立登记为 HTTP 422，data.platform 标识暂停的平台', () => {
  // 任务要求先核号：本地 main 到 30153；工作树已有 30154；B3-lane notices
  // 2026-10-22 CT-24h 预占 30155，D10-176 指定本任务顺延 30156。
  const codes = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  const matches = codes.filter((code) => code['code'] === 30156);
  expect(matches).toHaveLength(1);
  const entry = object(matches[0]);
  expect(entry['http']).toBe(422);
  expect([undefined, false]).toContain(entry['deprecated']);
  expect(at(entry, 'data')).toHaveProperty('platform');
  expect(entry['meaning']).toMatch(/授权|authoriz/i);
  expect(entry['meaning']).toMatch(/暂停|paused|suspend/i);
});

it('[AC-CT-24n#20] 20001 登记三个指派目标拒绝原因，冲突复用现有 resource', () => {
  const codes = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  const invalid = codes.find((entry) => entry['code'] === 20001);
  expect(list(at(invalid, 'data')['reason'])).toEqual(
    expect.arrayContaining(['target_banned', 'target_deleting', 'target_deleted']),
  );
  const conflict = codes.find((entry) => entry['code'] === 20902);
  expect(list(at(conflict, 'data')['resource'])).toEqual(
    expect.arrayContaining(['order', 'order_attribution']),
  );
});
