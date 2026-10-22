// B3-09c: PG result persistence and independent trace writer. Wiring is a later task.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ResultSetStore } from '../../orchestrator/results/types.ts';
import type { CardInput } from '../../stream/writer/index.ts';

export interface ToolCallRecord {
  readonly seq: number;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>> | null;
  readonly result_digest: string | null;
  readonly status: 'ok' | 'failed' | 'rejected';
  readonly latency_ms: number | null;
}

export interface AgentTraceWriter {
  recordCards(
    appId: string,
    sessionId: string,
    runId: string,
    cards: readonly CardInput[],
  ): Promise<void>;
  recordToolCalls(appId: string, runId: string, calls: readonly ToolCallRecord[]): Promise<void>;
}

export function createPgResultSetStore(deps: { db: Kysely<DB> }): Required<ResultSetStore> {
  void deps;
  throw new Error('NotImplemented: createPgResultSetStore');
}

export function createPgAgentTraceWriter(deps: {
  db: Kysely<DB>;
  newId: () => string;
}): AgentTraceWriter {
  void deps;
  throw new Error('NotImplemented: createPgAgentTraceWriter');
}
