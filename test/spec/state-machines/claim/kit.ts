import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../order/kit.ts';

export interface ExpectedRow {
  id: string;
  from: string | null;
  event: string;
  to: string;
}

export interface Spec {
  name: string;
  field: string;
  enumName: string;
  prefix: string;
  fn: string;
  testPrefix: string;
  states: readonly string[];
  events: readonly string[];
  legal: readonly ExpectedRow[];
  rowCount: number;
}

// 独立预期：CT-04e 编排补充口径 1、2（BR-ATTR-17/18；12 §3.3）。
// 不从待测 YAML 或生成表计算任何期望迁移。
export const CLAIM: Spec = {
  name: 'claim',
  field: 'status',
  enumName: 'claim_status',
  prefix: 'CLAIM',
  fn: 'transitionClaim',
  testPrefix: 'SM-CLM',
  states: ['submitted', 'auto_matched', 'manual_review', 'approved', 'rejected', 'cancelled'],
  events: [
    'SUBMIT',
    'EVIDENCE_ALL_STRONG',
    'EVIDENCE_NOT_ALL_STRONG',
    'RESOLVE_APPROVED',
    'RESOLVE_REJECTED',
    'RESOLVE_CANCELLED',
  ],
  legal: [
    { id: 'C1', from: null, event: 'SUBMIT', to: 'submitted' },
    { id: 'C2', from: 'submitted', event: 'EVIDENCE_ALL_STRONG', to: 'auto_matched' },
    { id: 'C3', from: 'submitted', event: 'EVIDENCE_NOT_ALL_STRONG', to: 'manual_review' },
    { id: 'C4', from: 'auto_matched', event: 'RESOLVE_APPROVED', to: 'approved' },
    { id: 'C4', from: 'manual_review', event: 'RESOLVE_APPROVED', to: 'approved' },
    { id: 'C5', from: 'auto_matched', event: 'RESOLVE_REJECTED', to: 'rejected' },
    { id: 'C5', from: 'manual_review', event: 'RESOLVE_REJECTED', to: 'rejected' },
    { id: 'C6', from: 'auto_matched', event: 'RESOLVE_CANCELLED', to: 'cancelled' },
    { id: 'C6', from: 'manual_review', event: 'RESOLVE_CANCELLED', to: 'cancelled' },
  ],
  rowCount: 6,
};

export const CLAIM_ITEM: Spec = {
  name: 'claim-item',
  field: 'decision',
  enumName: 'claim_item_decision',
  prefix: 'CLAIM_ITEM',
  fn: 'transitionClaimItem',
  testPrefix: 'SM-CLI',
  states: ['approved', 'rejected', 'cancelled'],
  events: ['APPROVE', 'REJECT', 'CANCEL'],
  legal: [
    { id: 'I1', from: null, event: 'APPROVE', to: 'approved' },
    { id: 'I2', from: null, event: 'REJECT', to: 'rejected' },
    { id: 'I3', from: null, event: 'CANCEL', to: 'cancelled' },
  ],
  rowCount: 3,
};

export const SPECS = [CLAIM, CLAIM_ITEM];

export function source(spec: Spec): string {
  return `specs/state-machines/${spec.name}.yaml`;
}

export function target(spec: Spec): string {
  return `packages/domain/src/state-machines/${spec.name}.gen.ts`;
}

export function machine(spec: Spec): Machine {
  const parsed = parseYamlLite(readRequired(source(spec)));
  expect(parsed).toMatchObject({
    name: spec.name,
    field: spec.field,
    states: expect.any(Array),
    events: expect.any(Array),
    transitions: expect.any(Array),
  });
  return parsed as Machine;
}

export function publicExports(): Record<string, unknown> {
  return domain;
}

export function transitionFunction(
  exports: Record<string, unknown>,
  spec: Spec,
): (from: unknown, event: unknown) => unknown {
  const fn = exports[spec.fn];
  // 缺少导出先断言，避免模块加载错误或 TypeError 造成无效先红。
  expect(fn).toEqual(expect.any(Function));
  return fn as ReturnType<typeof transitionFunction>;
}

export const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: (spec: Spec) => generatedExports(readRequired(target(spec))) },
];

export function rowKeys(rows: readonly ExpectedRow[]): string[] {
  return rows.map(({ id, from, event, to }) => JSON.stringify([id, from, event, to])).sort();
}
