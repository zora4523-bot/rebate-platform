// Unit tests of the Agent section of a personal information copy without a database: Kysely runs
// on a scripted driver that answers by table and records each statement. The SQL runs against
// PostgreSQL in the rule tests (test/spec/identity/data-copies-content).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  agentTraceRetentionDays,
  agentTraceRetentionKey,
  createPersonalDataCopyAgentReader,
} from './personal-data-copy-read.ts';

const NOW = '2026-10-24T04:00:00.000Z';
const SUBJECT = { appId: 'app_unit', userId: '3f0c6a52-2b1e-4c55-9d3a-6c1d2f8e9a10' };
const SESSION = '0b6f3c1e-8a52-4d8e-9f10-2c3d4e5f6a7b';

function scripted(answers: { sessions?: unknown[]; messages?: unknown[] }) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      const rows = compiled.sql.includes('"agent_sessions"')
        ? (answers.sessions ?? [])
        : compiled.sql.includes('"agent_messages"')
          ? (answers.messages ?? [])
          : [];
      return Promise.resolve({ rows } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

function sessionStatement(statements: readonly CompiledQuery[]): CompiledQuery {
  const found = statements.find((statement) => statement.sql.includes('"agent_sessions"'));
  if (found === undefined) throw new Error('no session statement');
  return found;
}

it('[AC-B1-27f-UNIT#1] agent.trace.retention_days 的解析：整数且不小于 184 天按配置，缺省、非整数或小于 184 天按 190 天', () => {
  const cases: [unknown, number][] = [
    [200, 200],
    [184, 184],
    [undefined, 190],
    [null, 190],
    [183, 190],
    [190.5, 190],
    ['200', 190],
    [{ days: 200 }, 190],
  ];
  for (const [value, days] of cases) {
    expect(agentTraceRetentionDays(value), String(value)).toBe(days);
  }
  expect(agentTraceRetentionKey()).toBe('agent.trace.retention_days');
});

it('[AC-B1-27f-UNIT#2] 读取器按调用方给的留存天数取会话（截止点由注入时钟作参数绑定），不给时按 190 天；会话为空时不再读消息', async () => {
  for (const [given, days] of [
    [200, 200],
    [100, 190],
    [undefined, 190],
  ] as const) {
    const { db, statements } = scripted({});
    const read = createPersonalDataCopyAgentReader({ clock: new FixedClock(NOW) });
    const options = given === undefined ? undefined : { retentionDays: given };
    expect(await read(db, SUBJECT, options)).toEqual([]);
    expect(statements).toHaveLength(1);
    const sessions = sessionStatement(statements);
    expect(sessions.sql).toContain('make_interval');
    expect(sessions.parameters, String(given)).toContain(days);
    expect(sessions.parameters).toContainEqual(new Date(NOW));
    expect(sessions.parameters).toContain(SUBJECT.appId);
    expect(sessions.parameters).toContain(SUBJECT.userId);
  }
});

it('[AC-B1-27f-UNIT#3] 消息按会话归组、按时间先后，只带角色、正文与时间', async () => {
  const startedAt = new Date('2026-10-20T00:00:00.000Z');
  const lastActiveAt = new Date('2026-10-20T01:00:00.000Z');
  const asked = new Date('2026-10-20T00:10:00.000Z');
  const answered = new Date('2026-10-20T00:11:00.000Z');
  const { db, statements } = scripted({
    sessions: [{ id: SESSION, started_at: startedAt, last_active_at: lastActiveAt }],
    messages: [
      { session_id: SESSION, role: 'user', text: 'question', created_at: asked },
      { session_id: SESSION, role: 'assistant', text: null, created_at: answered },
    ],
  });
  const read = createPersonalDataCopyAgentReader({ clock: new FixedClock(NOW) });
  expect(await read(db, SUBJECT)).toEqual([
    {
      session_id: SESSION,
      started_at: startedAt,
      last_active_at: lastActiveAt,
      messages: [
        { role: 'user', text: 'question', created_at: asked },
        { role: 'assistant', text: null, created_at: answered },
      ],
    },
  ]);
  const messages = statements.find((statement) => statement.sql.includes('"agent_messages"'));
  expect(messages?.parameters).toContain(SUBJECT.appId);
  expect(messages?.parameters).toContain(SESSION);
  expect(messages?.sql).not.toMatch(/report|feedback/);
});
