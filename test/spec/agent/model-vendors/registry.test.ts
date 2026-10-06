// BR-AI-14 细则「多厂商接入」：厂商登记（线上 / 离线用途分开）。取值依据见 08，本文件只断言登记结果。
import { expect, it } from 'vitest';
import {
  assertOnlineVendor,
  vendorRegistry,
  VendorError,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type {
  OnlineVendorCall,
  OnlineVendorId,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';

it('[BR-AI-14 多厂商接入#1] 登记表只有规划已登记的千问与智谱 GLM，不新增厂商，每家带 09 能力条目', () => {
  const vendors = vendorRegistry().map((r) => r.vendor);
  expect([...vendors].sort()).toEqual(['glm', 'qwen']);
  expect(new Set(vendors).size).toBe(vendors.length);
  // 每家先在规划/09 登记能力验证条目，登记里必须带条目编号。
  for (const r of vendorRegistry()) expect(r.capability).toMatch(/^CAP-X-\d+$/);
});

it('[BR-AI-14 多厂商接入#2] 千问登记线上 + 离线，经百炼接入，能力条目 CAP-X-07', () => {
  const qwen = vendorRegistry().find((r) => r.vendor === 'qwen');
  expect(qwen).toBeDefined();
  expect([...(qwen?.purposes ?? [])].sort()).toEqual(['offline', 'online']);
  expect(qwen?.accessPaths).toEqual(['bailian']);
  expect(qwen?.capability).toBe('CAP-X-07');
  // 千问离线先用、不设预算上限（负责人 2026-10-05）。
  expect(qwen?.offlineBudgetRequired).toBe(false);
});

it('[BR-AI-14 多厂商接入#3] GLM 只登记离线，两条接入路径都登记，能力条目 CAP-X-19，离线付费须先定额度', () => {
  const glm = vendorRegistry().find((r) => r.vendor === 'glm');
  expect(glm).toBeDefined();
  expect(glm?.purposes).toEqual(['offline']);
  expect([...(glm?.accessPaths ?? [])].sort()).toEqual(['bailian', 'zhipu_open']);
  expect(glm?.capability).toBe('CAP-X-19');
  expect(glm?.offlineBudgetRequired).toBe(true);
});

it('[BR-AI-14 多厂商接入#4] 改写样本外发许可按接入路径与用途分别登记，登记表不带厂商级的总许可字段', () => {
  const registry = vendorRegistry();
  expect(registry.length).toBe(2);
  for (const r of registry) {
    expect(Object.keys(r).sort()).toEqual([
      'accessPaths',
      'capability',
      'offlineBudgetRequired',
      'purposes',
      'vendor',
    ]);
  }
});

it('[BR-AI-14 多厂商接入#5] 只有登记了线上用途的厂商才在线上可用：登记表中线上厂商只有千问', () => {
  const online = vendorRegistry()
    .filter((r) => r.purposes.includes('online'))
    .map((r) => r.vendor);
  expect(online).toEqual(['qwen']);
});

it('[BR-AI-14 多厂商接入#6] 类型层拦截：OnlineVendorId 只接受千问，离线厂商不能写进线上调用', () => {
  const ok: OnlineVendorId = 'qwen';
  // @ts-expect-error GLM 只登记离线，不能作为线上厂商
  const glm: OnlineVendorId = 'glm';
  const call: OnlineVendorCall = {
    purpose: 'online',
    // @ts-expect-error 线上调用的 vendor 只能是线上登记的厂商
    vendor: 'glm',
    model: 'm',
    dataClass: 'user_input',
    body: {},
  };
  // 类型检查是本测试的主体；运行时也必须拒绝（见 #7）。
  expect(assertOnlineVendor(ok)).toBe('qwen');
  expect([glm, call.vendor]).toEqual(['glm', 'glm']);
});

it.each(['glm', 'deepseek', 'doubao', 'QWEN', ''])(
  '[BR-AI-14 多厂商接入#7] 运行时拦截：%j 不是线上登记的厂商，assertOnlineVendor 拒绝',
  (vendor) => {
    let thrown: unknown;
    try {
      assertOnlineVendor(vendor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VendorError);
    expect((thrown as VendorError).code).toBe(
      vendor === 'glm' ? 'vendor_not_online' : 'vendor_unknown',
    );
  },
);
