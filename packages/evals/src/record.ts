import type { EvalCase, Problem } from './cases.ts';
import type { AgentPorts, AgentUnderTest, Recording, Report, RunMeta } from './types.ts';

export interface EvalClock {
  now(): Date;
}

export interface EvalIds {
  next(): string;
}

export function fixedClock(iso: string): EvalClock {
  void iso;
  throw new Error('NotImplemented: fixedClock');
}

export function sequentialIds(prefix: string): EvalIds {
  void prefix;
  throw new Error('NotImplemented: sequentialIds');
}

export function redactRecorded(value: unknown): unknown {
  void value;
  throw new Error('NotImplemented: redactRecorded');
}

export interface RecordingWriter {
  wrap(ports: AgentPorts): AgentPorts;
  lines(): Recording[];
  problems(): Problem[];
  toJsonl(): string;
}

export function createRecordingWriter(opts: { clock: EvalClock }): RecordingWriter {
  void opts;
  throw new Error('NotImplemented: createRecordingWriter');
}

export function runRecord(opts: {
  cases: EvalCase[];
  agent: AgentUnderTest;
  live: AgentPorts;
  meta: RunMeta;
  clock: EvalClock;
  timeoutMs?: number;
}): Promise<{ report: Report; recordings: Recording[]; problems: Problem[] }> {
  void opts;
  throw new Error('NotImplemented: runRecord');
}
