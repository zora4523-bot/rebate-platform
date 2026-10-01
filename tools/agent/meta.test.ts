// Tests for meta.ts: event-stream facts and the JSON helper used by the bash wrappers.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyValueFlags, eventFacts } from './meta.ts';
import { AGENT_DIR, REPO } from './testing/fixture.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = join(
    REPO,
    '.tmp',
    `agent-meta-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function metaCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(process.execPath, [join(AGENT_DIR, 'meta.ts'), ...args], {
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const STARTED = '{"type":"thread.started","thread_id":"0199abcd-0000-7000-8000-00000000000a"}';
const COMPLETED = '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}';

it('eventFacts reads the last event type and the thread id', () => {
  expect(eventFacts(`${STARTED}\n{"type":"turn.started"}\n${COMPLETED}\n\n`, '')).toEqual({
    lastType: 'turn.completed',
    threadId: '0199abcd-0000-7000-8000-00000000000a',
    capacity: false,
  });
  expect(eventFacts('', '')).toEqual({ lastType: 'none', threadId: '', capacity: false });
  // A stream that stops in the middle of a line did not end with turn.completed.
  expect(eventFacts(`${COMPLETED}\n{"type":"item.comp`, '').lastType).toBe('invalid');
  expect(
    eventFacts(`${COMPLETED}\n{"type":"turn.failed","error":{"message":"x"}}\n`, '').lastType,
  ).toBe('turn.failed');
});

it('eventFacts sees a capacity error only in error events or on stderr', () => {
  const text = 'Selected model is at capacity. Please try a different model.';
  expect(eventFacts(`{"type":"error","message":"${text}"}\n`, '').capacity).toBe(true);
  expect(eventFacts(`{"type":"turn.failed","error":{"message":"${text}"}}\n`, '').capacity).toBe(
    true,
  );
  expect(eventFacts('', `ERROR: ${text}\n`).capacity).toBe(true);
  const quoted = `{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"${text}"}}\n`;
  expect(eventFacts(quoted, '').capacity).toBe(false);
});

it('applyValueFlags builds typed values and returns what it did not understand', () => {
  const doc: Record<string, unknown> = {};
  const rest = applyValueFlags(doc, [
    '--str',
    'path=/a=b/我的项目',
    '--num',
    'exit_code=124',
    '--bool',
    'timed_out=1',
    '--bool',
    'has_output=false',
    '--null',
    'finished_at',
    '--list',
    'changed=head,index',
    '--list',
    'none=',
    '--json',
    'gate={"allowed":false}',
    '--json',
    'raw=not json',
    'leftover',
  ]);
  expect(rest).toEqual(['leftover']);
  expect(doc).toEqual({
    path: '/a=b/我的项目',
    exit_code: 124,
    timed_out: true,
    has_output: false,
    finished_at: null,
    changed: ['head', 'index'],
    none: [],
    gate: { allowed: false },
    raw: 'not json',
  });
  expect(() => applyValueFlags({}, ['--num', 'n=abc'])).toThrow(/not an integer/);
  expect(() => applyValueFlags({}, ['--bool', 'b=maybe'])).toThrow(/expected true/);
  expect(() => applyValueFlags({}, ['--str', 'novalue'])).toThrow(/needs <key>=<value>/);
});

it('CLI: merge writes and updates a file, get reads nested keys, emit prints one line', () => {
  const dir = scratch();
  const file = join(dir, 'meta.json');
  const copy = join(dir, 'meta.impl.json');
  const lines = join(dir, 'lines.txt');
  writeFileSync(lines, 'invalid: a\n\ninvalid: b\n');

  expect(
    metaCli(['merge', '--new', '--file', file, '--str', 'mode=impl', '--null', 'exit_code']).status,
  ).toBe(0);
  expect(
    metaCli([
      'merge',
      '--file',
      file,
      '--copy-to',
      copy,
      '--num',
      'exit_code=10',
      '--lines',
      `messages=${lines}`,
    ]).status,
  ).toBe(0);
  const expected = { mode: 'impl', exit_code: 10, messages: ['invalid: a', 'invalid: b'] };
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expected);
  expect(JSON.parse(readFileSync(copy, 'utf8'))).toEqual(expected);

  expect(metaCli(['get', '--file', file, 'exit_code']).stdout).toBe('10\n');
  expect(metaCli(['get', '--file', file, 'missing']).stdout).toBe('\n');
  writeFileSync(file, JSON.stringify({ attempts: { impl: 2 }, spec_commit: null }));
  expect(metaCli(['get', '--file', file, 'attempts.impl']).stdout).toBe('2\n');
  expect(metaCli(['get', '--file', file, 'spec_commit']).stdout).toBe('\n');

  const emitted = metaCli([
    'emit',
    '--str',
    'action=dispatched',
    '--num',
    'pid=42',
    '--str',
    'run=/r/我',
  ]);
  expect(emitted.stdout).toBe('{"action":"dispatched","pid":42,"run":"/r/我"}\n');

  expect(metaCli(['merge', '--file', join(dir, 'absent.json'), '--str', 'a=b']).status).toBe(2);
  expect(metaCli(['merge', '--new', '--file', file, 'stray']).status).toBe(2);
  expect(metaCli(['bogus']).status).toBe(2);
});

it('CLI: events prints shell-readable facts', () => {
  const dir = scratch();
  const events = join(dir, 'events.jsonl');
  writeFileSync(events, `${STARTED}\n${COMPLETED}\n`);
  const res = metaCli(['events', '--events', events, '--err', join(dir, 'no-err.txt')]);
  expect(res.status).toBe(0);
  expect(res.stdout).toBe(
    'last_type=turn.completed\nthread_id=0199abcd-0000-7000-8000-00000000000a\ncapacity=0\n',
  );
  expect(metaCli(['events', '--events', join(dir, 'absent.jsonl')]).stdout).toContain(
    'last_type=none',
  );
});
