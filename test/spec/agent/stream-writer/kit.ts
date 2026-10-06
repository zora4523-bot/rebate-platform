// B3-03a helpers: contract fixtures, an independent schema check and an SSE reader. Expected
// results stay in the rule tests. Shapes: contracts/agent-stream.schema.json (04 §8.1–8.2).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';
import type {
  MetaData,
  StreamSink,
} from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';

export type Line =
  { event: string; id: number; data: Record<string, unknown> } | { comment: 'ping' };

const ROOT = new URL('../../../../', import.meta.url);

/** Every fixture that is one run from its first frame (normal-earnings-history is a reload row). */
export const RUN_FIXTURES = [
  'normal',
  'normal-page-guide',
  'normal-earnings',
  'tool-failed',
  'cancelled',
  'disconnected',
  'unknown-card',
  'unknown-card-page-guide',
  'error',
  'fallback',
] as const;

export function readFixture(name: string): Line[] {
  const text = readFileSync(
    new URL(`contracts/fixtures/agent-streams/${name}.ndjson`, ROOT),
    'utf8',
  );
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Line);
}

export function readSchema(): Record<string, unknown> {
  const text = readFileSync(new URL('contracts/agent-stream.schema.json', ROOT), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

type Validate = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvLike {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validate;
}

let compiled: Validate | undefined;

/** The test's own Ajv2020 check of one frame against the contract (dependencies of @couli/api). */
export function frameIsValid(frame: unknown): boolean {
  if (compiled === undefined) {
    const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
    const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
      Ajv2020: new (options: { strict: true; allErrors: true }) => AjvLike;
    };
    const addFormats = apiRequire('ajv-formats') as (ajv: AjvLike) => void;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    ajv.addFormat('int32', {
      type: 'number',
      validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
    });
    ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
    compiled = ajv.compile(readSchema());
  }
  return compiled(frame);
}

export interface RecordingSink extends StreamSink {
  readonly chunks: string[];
}

export function recordingSink(): RecordingSink {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => void chunks.push(chunk) };
}

/**
 * Reads SSE text strictly in the 04 §8.1 layout: blocks end with a blank line; a frame block is
 * exactly `event:`, `id:`, `data:` in that order; a ping block is exactly `: ping`.
 */
export function readSse(text: string): Line[] {
  expect(text, 'no raw CR anywhere').not.toMatch(/\r/);
  expect(text.endsWith('\n\n'), 'output ends with a blank line').toBe(true);
  return text
    .slice(0, -2)
    .split('\n\n')
    .map((block): Line => {
      if (block === ': ping') return { comment: 'ping' };
      const lines = block.split('\n');
      expect(lines, `frame block has three lines: ${JSON.stringify(block)}`).toHaveLength(3);
      const [event, id, data] = lines as [string, string, string];
      expect(event).toMatch(/^event: [a-z.]+$/);
      expect(id).toMatch(/^id: [1-9][0-9]*$/);
      expect(data.startsWith('data: ')).toBe(true);
      return {
        event: event.slice('event: '.length),
        id: Number(id.slice('id: '.length)),
        data: JSON.parse(data.slice('data: '.length)) as Record<string, unknown>,
      };
    });
}

/** Non-throwing variant of readSse for property bodies: undefined when the layout is broken. */
export function tryReadSse(text: string): Line[] | undefined {
  if (/\r/.test(text) || !text.endsWith('\n\n')) return undefined;
  const out: Line[] = [];
  for (const block of text.slice(0, -2).split('\n\n')) {
    if (block === ': ping') {
      out.push({ comment: 'ping' });
      continue;
    }
    const lines = block.split('\n');
    if (lines.length !== 3) return undefined;
    const [event, id, data] = lines as [string, string, string];
    if (!/^event: [a-z.]+$/.test(event) || !/^id: [1-9][0-9]*$/.test(id)) return undefined;
    if (!data.startsWith('data: ')) return undefined;
    try {
      out.push({
        event: event.slice('event: '.length),
        id: Number(id.slice('id: '.length)),
        data: JSON.parse(data.slice('data: '.length)) as Record<string, unknown>,
      });
    } catch {
      return undefined;
    }
  }
  return out;
}

/**
 * The caller's input for a fixture frame: a deep copy of its data without seq, so the writer never
 * touches the fixture objects that serve as the expected result.
 */
export function inputOf(line: { data: Record<string, unknown> }): Record<string, unknown> {
  const rest = structuredClone(line.data);
  delete rest['seq'];
  return rest;
}

export const META: MetaData = {
  session_id: '019a0000-0000-7000-8000-00000000a001',
  run_id: '019a0000-0000-7000-8000-00000000a101',
  message_id: '019a0000-0000-7000-8000-00000000a201',
  prompt_version: 'demo-prompt-v1',
  model_label: '演示模型',
  ai_label: '内容由 AI 生成，仅供参考',
};
