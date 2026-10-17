// 状态机生成器（规划/04 §4；CT-04a）：读 specs/state-machines/<name>.yaml，生成
// packages/domain/src/state-machines/<name>.gen.ts（枚举常量、只读迁移表与 transition<Name>()）。
//   node packages/domain/scripts/state-machines.ts            写出生成物
//   node packages/domain/scripts/state-machines.ts --verify   只比对，生成物过期时退出 1，不写文件
// renderStateMachine(yamlText) 是纯函数：同一输入总是得到同一文本；守卫只当文字写进表里，不求值。
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';

export const MACHINES = ['order-platform', 'order-rebate'] as const;

const GENERATE_COMMAND = 'node packages/domain/scripts/state-machines.ts';
const SPECIAL_KINDS = ['backward', 'same_state'] as const;
const ROW_KINDS = ['transition', ...SPECIAL_KINDS] as const;
const TOP_KEYS = ['name', 'field', 'states', 'events', 'transitions', 'stages', 'event_states'];
const ROW_KEYS = ['id', 'kind', 'from', 'event', 'to', 'guard', 'test_id'];
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const ID_RE = /^[A-Z][A-Za-z0-9]*$/;

type RowKind = (typeof ROW_KINDS)[number];

interface Row {
  id: string;
  kind: RowKind | undefined;
  from: (string | null)[];
  event: string | null;
  to: string;
  guard: string;
  test_id: string;
}

interface Machine {
  name: string;
  field: string;
  states: string[];
  events: string[];
  transitions: Row[];
  stages: string[] | undefined;
  eventStates: [string, string][] | undefined;
}

export class StateMachineSpecError extends Error {
  constructor(message: string) {
    super(`state-machines: ${message}`);
    this.name = 'StateMachineSpecError';
  }
}

function fail(message: string): never {
  throw new StateMachineSpecError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') fail(`${where} must be a non-empty string`);
  return value;
}

function codeList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${where} must be a non-empty list`);
  const out = value.map((item, i) => {
    const code = stringOf(item, `${where}[${i}]`);
    if (!CODE_RE.test(code)) fail(`${where}[${i}] "${code}" must be UPPER_SNAKE_CASE`);
    return code;
  });
  if (new Set(out).size !== out.length) fail(`${where} has duplicates`);
  return out;
}

function onlyKeys(record: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key}"`);
  }
}

function parseRow(value: unknown, i: number, states: string[], events: string[]): Row {
  const where = `transitions[${i}]`;
  if (!isRecord(value)) fail(`${where} must be a mapping`);
  onlyKeys(value, ROW_KEYS, where);
  const id = stringOf(value['id'], `${where}.id`);
  if (!ID_RE.test(id)) fail(`${where}.id "${id}" is not a transition number`);
  const rawKind = value['kind'];
  let kind: RowKind | undefined;
  if (rawKind !== undefined) {
    kind = ROW_KINDS.find((k) => k === rawKind);
    if (kind === undefined) fail(`${where}.kind must be one of ${ROW_KINDS.join(', ')}`);
  }
  const guard = value['guard'];
  if (typeof guard !== 'string') fail(`${where}.guard must be a string (use '—' for none)`);
  const testId = stringOf(value['test_id'], `${where}.test_id`);
  const to = stringOf(value['to'], `${where}.to`);
  const rawFrom = value['from'];
  if (!Array.isArray(rawFrom) || rawFrom.length === 0) {
    fail(`${where}.from must be a non-empty list`);
  }
  const from = rawFrom.map((item, j): string | null => {
    if (item === null) return null;
    return stringOf(item, `${where}.from[${j}]`);
  });
  if (new Set(from).size !== from.length) fail(`${where}.from has duplicates`);
  const special = kind === 'backward' || kind === 'same_state';
  let event: string | null;
  if (special) {
    if (from.length !== 1 || from[0] !== '*') fail(`${where}: a ${kind} row must have from ['*']`);
    if (value['event'] !== null) fail(`${where}: a ${kind} row is not an event (event: null)`);
    if (to !== 'same') fail(`${where}: a ${kind} row must have to: same`);
    event = null;
  } else {
    event = stringOf(value['event'], `${where}.event`);
    if (!events.includes(event)) fail(`${where}.event "${event}" is not in events`);
    for (const state of from) {
      if (state !== null && !states.includes(state)) {
        fail(`${where}.from "${state}" is not in states`);
      }
    }
    if (to !== 'same' && !states.includes(to)) fail(`${where}.to "${to}" is not in states`);
    if (to === 'same' && from.includes(null)) fail(`${where}: to: same needs an existing state`);
  }
  return { id, kind, from, event, to, guard, test_id: testId };
}

function parseMachine(yamlText: string): Machine {
  const doc = parseYamlLite(yamlText);
  if (!isRecord(doc)) fail('document must be a mapping');
  onlyKeys(doc, TOP_KEYS, 'document');
  const name = stringOf(doc['name'], 'name');
  if (!NAME_RE.test(name)) fail(`name "${name}" must be kebab-case`);
  const field = stringOf(doc['field'], 'field');
  const states = codeList(doc['states'], 'states');
  const events = codeList(doc['events'], 'events');
  const rawRows = doc['transitions'];
  if (!Array.isArray(rawRows) || rawRows.length === 0) fail('transitions must be a non-empty list');
  const transitions = rawRows.map((row, i) => parseRow(row, i, states, events));

  const seen = new Map<string, string>();
  for (const row of transitions) {
    if (row.event === null) continue;
    for (const from of row.from) {
      const key = `${String(from)} + ${row.event}`;
      const previous = seen.get(key);
      if (previous !== undefined) fail(`${key} is claimed by both ${previous} and ${row.id}`);
      seen.set(key, row.id);
    }
  }
  for (const kind of SPECIAL_KINDS) {
    if (transitions.filter((row) => row.kind === kind).length > 1) {
      fail(`at most one ${kind} row is allowed`);
    }
  }

  const hasSpecial = transitions.some(
    (row) => row.kind === 'backward' || row.kind === 'same_state',
  );
  let stages: string[] | undefined;
  let eventStates: [string, string][] | undefined;
  if (doc['stages'] !== undefined || doc['event_states'] !== undefined || hasSpecial) {
    stages = codeList(doc['stages'], 'stages');
    for (const stage of stages) {
      if (!states.includes(stage)) fail(`stages "${stage}" is not in states`);
    }
    const rawEventStates = doc['event_states'];
    if (!isRecord(rawEventStates)) fail('event_states must be a mapping of event to state');
    eventStates = Object.entries(rawEventStates).map(([event, state]) => {
      if (!events.includes(event)) fail(`event_states "${event}" is not in events`);
      const target = stringOf(state, `event_states.${event}`);
      if (!states.includes(target)) fail(`event_states.${event} "${target}" is not in states`);
      return [event, target];
    });
  }
  return { name, field, states, events, transitions, stages, eventStates };
}

function pascal(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function literal(value: string | null): string {
  return value === null ? 'null' : `'${JSON.stringify(value).slice(1, -1).replace(/'/g, "\\'")}'`;
}

function union(values: string[]): string {
  return values.map((v) => `  | ${literal(v)}`).join('\n');
}

function list(values: (string | null)[]): string {
  return `[${values.map(literal).join(', ')}]`;
}

function renderRow(row: Row): string {
  const lines = [`    id: ${literal(row.id)},`];
  if (row.kind !== undefined) lines.push(`    kind: ${literal(row.kind)},`);
  lines.push(
    `    from: ${list(row.from)},`,
    `    event: ${literal(row.event)},`,
    `    to: ${literal(row.to)},`,
    `    guard: ${literal(row.guard)},`,
    `    test_id: ${literal(row.test_id)},`,
  );
  return `  {\n${lines.join('\n')}\n  },`;
}

function renderSpecial(m: Machine, constant: string): string[] {
  const backward = m.transitions.find((row) => row.kind === 'backward');
  const same = m.transitions.find((row) => row.kind === 'same_state');
  if ((backward === undefined && same === undefined) || !m.stages || !m.eventStates) return [];
  const out = [
    '  // 表内没有的组合：先按「事件对应的状态」判定同状态与倒退，其余为表外事件。',
    "  if (from === null) return { ok: false, reason: 'illegal', id: null };",
    `  const reported = ${constant}_EVENT_STATES[event];`,
  ];
  if (same !== undefined) {
    out.push(
      `  if (reported === from) return { ok: true, to: from, id: ${literal(same.id)}, noop: true };`,
    );
  }
  if (backward !== undefined) {
    out.push(
      `  const current = ${constant}_STAGES.indexOf(from);`,
      `  const reportedStage = reported === undefined ? -1 : ${constant}_STAGES.indexOf(reported);`,
      '  if (current >= 0 && reportedStage >= 0 && reportedStage < current) {',
      `    return { ok: false, reason: 'backward', id: ${literal(backward.id)} };`,
      '  }',
    );
  }
  return out;
}

export function renderStateMachine(yamlText: string): string {
  const m = parseMachine(yamlText);
  const base = pascal(m.name);
  const constant = m.name.toUpperCase().replace(/-/g, '_');
  const state = `${base}State`;
  const event = `${base}Event`;
  const row = `${base}TransitionRow`;
  const result = `${base}TransitionResult`;
  const parts: string[] = [
    `// 生成物，勿手改。来源：specs/state-machines/${m.name}.yaml（字段 ${m.field}）。`,
    `// 改 yaml 后重新生成：${GENERATE_COMMAND}（--verify 只比对）。`,
    '// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。',
    '',
    `export type ${state} =\n${union(m.states)};`,
    '',
    `export const ${constant}_STATES: readonly ${state}[] = ${list(m.states)};`,
    '',
    `export type ${event} =\n${union(m.events)};`,
    '',
    `export const ${constant}_EVENTS: readonly ${event}[] = ${list(m.events)};`,
    '',
    `export interface ${row} {`,
    '  readonly id: string;',
    `  readonly kind?: ${ROW_KINDS.map(literal).join(' | ')};`,
    `  readonly from: readonly (${state} | null | '*')[];`,
    `  readonly event: ${event} | null;`,
    `  readonly to: ${state} | 'same';`,
    '  readonly guard: string;',
    '  readonly test_id: string;',
    '}',
    '',
    `export const ${constant}_TRANSITIONS: readonly ${row}[] = [`,
    ...m.transitions.map(renderRow),
    '];',
    '',
  ];
  if (m.stages && m.eventStates) {
    parts.push(
      `const ${constant}_STAGES: readonly ${state}[] = ${list(m.stages)};`,
      '',
      `const ${constant}_EVENT_STATES: Partial<Record<${event}, ${state}>> = {`,
      ...m.eventStates.map(([e, s]) => `  ${e}: ${literal(s)},`),
      '};',
      '',
    );
  }
  parts.push(
    `export type ${result} =`,
    `  | { ok: true; to: ${state}; id: string; noop: boolean }`,
    `  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };`,
    '',
    `export function transition${base}(from: ${state} | null, event: ${event}): ${result} {`,
    `  for (const row of ${constant}_TRANSITIONS) {`,
    "    if (row.kind === 'backward' || row.kind === 'same_state') continue;",
    '    if (row.event !== event || !row.from.includes(from)) continue;',
    "    if (row.to === 'same') {",
    `      return { ok: true, to: from as ${state}, id: row.id, noop: true };`,
    '    }',
    '    return { ok: true, to: row.to, id: row.id, noop: false };',
    '  }',
    ...renderSpecial(m, constant),
    "  return { ok: false, reason: 'illegal', id: null };",
    '}',
    '',
  );
  return parts.join('\n');
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

function main(argv: string[]): number {
  const verify = argv.includes('--verify');
  const unknown = argv.filter((arg) => arg !== '--verify');
  if (unknown.length > 0) {
    console.error(`state-machines: unknown argument(s): ${unknown.join(' ')}`);
    return 2;
  }
  const root = repoRoot();
  let stale = 0;
  for (const name of MACHINES) {
    const source = `specs/state-machines/${name}.yaml`;
    const target = `packages/domain/src/state-machines/${name}.gen.ts`;
    const expected = renderStateMachine(readFileSync(join(root, source), 'utf8'));
    const targetPath = join(root, target);
    const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
    if (current === expected) continue;
    if (verify) {
      console.error(`state-machines: ${target} is out of date; run ${GENERATE_COMMAND}`);
      stale++;
    } else {
      writeFileSync(targetPath, expected);
      console.log(`state-machines: wrote ${target}`);
    }
  }
  return stale === 0 ? 0 : 1;
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
