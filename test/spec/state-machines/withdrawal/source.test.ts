import * as domain from '@couli/domain';
import { expect, it } from 'vitest';
import { EVENTS, RULES, STATES } from './cases.ts';
import { GENERATED, machine, readRequired, yamlText } from './kit.ts';

it('[AC-CT-04d#1] YAML 只有原文七态，顺序一致，事件与 W1–W11 无增漏', () => {
  const doc = machine();
  expect(doc.name).toBe('withdrawal');
  expect(doc.field).toBe('status');
  expect(doc.states).toEqual(STATES);
  expect([...doc.events].sort()).toEqual([...EVENTS].sort());
  expect(doc.transitions.map((row) => row.id)).toEqual([
    'W1',
    'W2',
    'W3',
    'W4',
    'W5',
    'W6',
    'W7',
    'W8',
    'W9',
    'W10',
    'W11',
  ]);
});

it.each(RULES)('[AC-CT-04d#2] [SM-WDR-$id] 起止状态、事件、守卫逐行转写', (rule) => {
  const rows = machine().transitions.filter((row) => row.id === rule.id);
  expect(rows).toHaveLength(1);
  for (const row of rows) {
    expect(row.from).toEqual(rule.from);
    expect(row.event).toBe(rule.event);
    expect(rule.targets).toContain(row.to);
    expect(row.test_id).toBe(`SM-WDR-${rule.id}`);
    expect(row.kind === undefined || row.kind === 'transition').toBe(true);
    expect(row.guard).toContain(rule.guard);
    for (const qualifier of rule.qualifiers) expect(row.guard).toContain(qualifier);
  }
});

it('[AC-CT-04d#3] 保留目标旁注与 W10 双结果，自动审核执行不另增状态', () => {
  const text = yamlText();
  for (const term of [
    '排入查询；T+24h 置 needs_manual 并停止自动查询',
    '写 hold_reason、hold_at；清空 executor_id、executed_at',
    'PAID_API / FAILED',
    '写成功分录，BR-WDR-09；追加一条 kind=query、result=success 的尝试记录，不改原记录',
  ])
    expect(text).toContain(term);
  // actor 作为说明（guard 或本行注释）保留；沿用 CT-04a schema，不引入新字段。
  for (const id of ['W2', 'W4']) {
    const block = text.match(
      new RegExp(`(?:^|\\n)((?:  #[^\\n]*\\n)*  - id: ${id}\\n[\\s\\S]*?)(?=\\n  (?:#|-) |$)`),
    );
    expect(block?.[1], `${id} 自动执行说明`).toContain('actor=system:auto_payout');
  }
});

it('[AC-CT-04d#4] 包入口公开状态、事件和只读表，与 YAML 及生成文件一致', () => {
  const doc = machine();
  const exports: Record<string, unknown> = domain;
  expect(exports['WITHDRAWAL_STATES']).toEqual(STATES);
  expect(exports['WITHDRAWAL_EVENTS']).toEqual(doc.events);
  expect(exports['WITHDRAWAL_TRANSITIONS']).toEqual(doc.transitions);
  const generated = readRequired(GENERATED);
  expect(generated).toContain('生成物，勿手改');
  expect(generated).toContain('specs/state-machines/withdrawal.yaml');
  expect(generated).toContain('export type WithdrawalState');
  expect(generated).toContain('export type WithdrawalEvent');
  expect(generated).toContain('readonly WithdrawalTransitionRow[]');
});
