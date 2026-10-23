import * as domain from '@couli/domain';
import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../../packages/domain/scripts/state-machines.ts';
import * as stateMachines from '../../../../../packages/domain/src/state-machines/index.ts';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../../../state-machines/order/kit.ts';

// 依据：B2-04dc §9（编排 D10-93 S7 选 A），不是 BR-FUND-04 已有的迁移表。
// 代理自定技术命名：START 入库、COMPLETE 完成、FAIL 失败；SJ1–SJ3 是迁移 ID。
// 独立预期不从待测 YAML / 生成物派生，避免实现漏行时测试也漏测。
const STATES = ['running', 'done', 'failed'] as const;
const EVENTS = ['START', 'COMPLETE', 'FAIL'] as const;
const ROWS = [
  { id: 'SJ1', from: null, event: 'START', to: 'running' },
  { id: 'SJ2', from: 'running', event: 'COMPLETE', to: 'done' },
  { id: 'SJ3', from: 'running', event: 'FAIL', to: 'failed' },
] as const;
const ENTRIES = ['public', 'barrel', 'generated'] as const;
const ILLEGAL = { ok: false, reason: 'illegal', id: null };
const YAML_PATH = 'specs/state-machines/settle-job.yaml';
const GENERATED_PATH = 'packages/domain/src/state-machines/settle-job.gen.ts';

function machine(): Machine {
  const source = readRequired(YAML_PATH);
  expect(() => parseYamlLite(source)).not.toThrow();
  const doc = parseYamlLite(source);
  expect(doc).toMatchObject({
    name: 'settle-job',
    field: 'status',
    states: expect.any(Array),
    events: expect.any(Array),
    transitions: expect.any(Array),
  });
  return doc as Machine;
}

function entryExports(entry: (typeof ENTRIES)[number]): Record<string, unknown> {
  if (entry === 'public') return domain;
  if (entry === 'barrel') return stateMachines;
  return generatedExports(readRequired(GENERATED_PATH));
}

function transition(entry: (typeof ENTRIES)[number]) {
  const fn = entryExports(entry).transitionSettleJob;
  // 先断言再调用：先红只能来自断言，不得来自缺模块或 TypeError。
  expect(fn, `${entry}: transitionSettleJob`).toEqual(expect.any(Function));
  return fn as (from: string | null, event: string) => unknown;
}

it('[AC-B2-04dc#1] YAML 仅有入库 running、完成 done、失败 failed 三条迁移', () => {
  const doc = machine();
  expect([...doc.states].sort()).toEqual([...STATES].sort());
  expect([...doc.events].sort()).toEqual([...EVENTS].sort());
  expect(doc.transitions).toHaveLength(3);
  for (const expected of ROWS) {
    const row = doc.transitions.find((candidate) => candidate.id === expected.id);
    expect(row).toMatchObject({
      ...expected,
      from: [expected.from],
      guard: expect.any(String),
      test_id: expect.stringMatching(/^(SM-SJ-\d+|AC-B2-04dc#\d+)$/),
    });
    expect(row?.guard.trim().length).toBeGreaterThan(0);
    expect(row?.kind === undefined || row.kind === 'transition').toBe(true);
    expect(row).not.toHaveProperty('alternatives');
  }
});

it('[AC-B2-04dc#2] 状态集合与 settle_jobs_status_check 的数据库快照一致', () => {
  const doc = machine();
  const schema = readRequired('db/schema.sql');
  const constraint = schema.match(/CONSTRAINT settle_jobs_status_check CHECK[^\n]+/);
  expect(constraint, 'settle_jobs.status 的唯一取值来源').not.toBeNull();
  const values = [...(constraint?.[0] ?? '').matchAll(/'([^']+)'::text/g)].map((match) => match[1]);
  expect(values.sort()).toEqual([...STATES].sort());
  expect([...doc.states].sort()).toEqual(values);
});

it('[AC-B2-04dc#3] YAML 标注代理自定及待回写位置，不冒充既有业务迁移表', () => {
  const source = readRequired(YAML_PATH);
  const header = source.split(/^name:/m)[0] ?? '';
  expect(header).toMatch(/^\s*#.*代理自定，待 04 §4 回写/m);
  expect(header).toContain('settle_jobs.status');
});

it('[AC-B2-04dc#4] 生成文件逐字匹配生成器，两个入口完整转出状态、事件、迁移表和函数', () => {
  const doc = machine();
  const source = readRequired(YAML_PATH);
  const target = readRequired(GENERATED_PATH);
  expect(MACHINES).toContain('settle-job');
  expect(() => renderStateMachine(source)).not.toThrow();
  expect(target).toBe(renderStateMachine(source));
  for (const entry of ENTRIES) {
    const exports = entryExports(entry);
    expect(exports.SETTLE_JOB_STATES).toEqual(doc.states);
    expect(exports.SETTLE_JOB_EVENTS).toEqual(doc.events);
    expect(exports.SETTLE_JOB_TRANSITIONS).toEqual(doc.transitions);
    expect(exports.transitionSettleJob).toEqual(expect.any(Function));
  }
  expect(entryExports('barrel').transitionSettleJob).toBe(
    entryExports('public').transitionSettleJob,
  );
});

it.each(ROWS)('[AC-B2-04dc#5] $id 允许 $from + $event → $to', ({ id, from, event, to }) => {
  for (const entry of ENTRIES) {
    expect(transition(entry)(from, event)).toEqual({ ok: true, to, id, noop: false });
  }
});

const ILLEGAL_PAIRS = [null, ...STATES].flatMap((from) =>
  EVENTS.filter((event) => !ROWS.some((row) => row.from === from && row.event === event)).map(
    (event) => ({ from, event }),
  ),
);

it.each(ILLEGAL_PAIRS)(
  '[AC-B2-04dc#6] 表外 $from + $event 拒绝，终态不能重跑、互转或重复完成',
  ({ from, event }) => {
    for (const entry of ENTRIES) {
      expect(transition(entry)(from, event)).toEqual(ILLEGAL);
    }
  },
);

it.each([null, ...STATES])('[AC-B2-04dc#7] %s 拒绝未知事件和重跑事件', (from) => {
  for (const entry of ENTRIES) {
    const move = transition(entry);
    for (const event of ['', 'RETRY', 'RESUME', 'start', 'DONE', '__proto__', 'constructor']) {
      expect(move(from, event)).toEqual(ILLEGAL);
    }
  }
});

it('[AC-B2-04dc#8] 失败后的新执行只能从新行首态开始，不复活原失败行', () => {
  for (const entry of ENTRIES) {
    const move = transition(entry);
    expect(move(null, 'START')).toEqual({ ok: true, to: 'running', id: 'SJ1', noop: false });
    expect(move('running', 'FAIL')).toEqual({ ok: true, to: 'failed', id: 'SJ3', noop: false });
    expect(move('failed', 'START')).toEqual(ILLEGAL);
    expect(move('failed', 'COMPLETE')).toEqual(ILLEGAL);
    expect(move(null, 'START')).toEqual({ ok: true, to: 'running', id: 'SJ1', noop: false });
    expect(move('running', 'COMPLETE')).toEqual({ ok: true, to: 'done', id: 'SJ2', noop: false });
    expect(move('done', 'FAIL')).toEqual(ILLEGAL);
  }
});
