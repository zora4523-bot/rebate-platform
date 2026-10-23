// B3-09e (BR-AI-22, D10-175): real PG as the business role couli_app; fixtures only. The
// one-shot database is created by each *.int.test.ts (createTestDatabase passed in): this kit
// imports nothing from the database testing package, neither as a value nor as a type.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createAgentDataPurge,
  type PurgeAgentDataInput,
  type PurgeAgentDataResult,
} from '../../../../apps/api/src/modules/agent/deletion/index.ts';

export const APP = 'synthetic-agent-purge-app';
export const OTHER_APP = 'synthetic-agent-purge-other-app';
export const KEY = 'synthetic-agent-user-hash-key';
export const OTHER_KEY = 'synthetic-agent-user-hash-key-rotated';
/** The fixed agent_cards.fallback_text placeholder (0073 header; purgedCardText()). */
export const PLACEHOLDER = '内容已删除';
/** When the fixture conversation happened (BR-AI-22 example: a 2026-11-20 run). */
export const SEEDED = new FixedClock('2026-11-20T02:00:00.000Z').now();
/** When the account deletion completes. */
export const AT = new FixedClock('2026-12-01T00:00:00.000Z').now();
export const LATER = new FixedClock('2026-12-02T00:00:00.000Z').now();
export const IP = JSON.stringify(['ip', '192.0.2.10']);

export const TABLES = [
  'agent_sessions',
  'agent_runs',
  'agent_messages',
  'agent_tool_calls',
  'agent_cards',
  'agent_result_sets',
  'agent_result_deliveries',
  'agent_result_chains',
  'agent_clarify_asks',
] as const;
export type Table = (typeof TABLES)[number];
export type Row = Record<string, unknown>;
export type Snapshot = Record<Table, Row[]>;

const ORDER: Record<Table, string> = {
  agent_sessions: 'id',
  agent_runs: 'id',
  agent_messages: 'id',
  agent_tool_calls: 'id',
  agent_cards: 'id',
  agent_result_sets: 'id',
  agent_result_deliveries: 'session_id, card_id',
  agent_result_chains: 'session_id, seq',
  agent_clarify_asks: 'session_id, chain_id, slot',
};

/** The one-shot database a test file creates (createTestDatabase, passed in by *.int.test.ts). */
export interface FixtureDatabase {
  urlFor(role: string): string;
  drop(): Promise<void>;
}

export interface Conversation {
  appId: string;
  userId: string | null;
  deviceId: string;
  sessionId: string;
  /** r1: done, member only; r2: error frames, device + member; r3: open, end_draft only. */
  runIds: readonly [string, string, string];
  resultSetId: string;
}

/** HMAC-SHA256(key utf8, userId utf8), lowercase hex — computed independently of the port. */
export function expectedHash(key: string, userId: string): string {
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(userId, 'utf8').digest('hex');
}

export function memberSubject(id: string): string {
  return JSON.stringify(['member', id]);
}

export function deviceSubject(deviceId: string): string {
  return JSON.stringify(['device', deviceHash(deviceId)]);
}

function deviceHash(deviceId: string): string {
  return deviceId.replaceAll('-', '').repeat(2);
}

/** Free text a user typed or the model wrote; carries the owner's id so leaks are visible. */
export function secret(label: string, owner: string | null): string {
  return `合成${label} ${owner ?? 'guest'}`;
}

export function doneFrame() {
  return { type: 'done', data: { finish_reason: 'stop', quota_left: 3 } };
}

/** Contract agent-stream $defs/error: msg and fallback_q are the free text. */
export function errorFrame(owner: string | null) {
  return {
    type: 'error',
    data: {
      code: 50302,
      msg: secret('生成回答', owner),
      retryable: true,
      fallback: 'search_page',
      fallback_q: secret('搜索词', owner),
    },
  };
}

/** An end draft without fallback_q: only msg may be cleared, no key may be added. */
export function draftWithoutQuery(owner: string | null) {
  return {
    type: 'error',
    data: { code: 50001, msg: secret('草稿回答', owner), retryable: false, fallback: null },
  };
}

export function omit(row: Row, names: readonly string[]): Row {
  const copy = { ...row };
  for (const name of names) delete copy[name];
  return copy;
}

/** The error a refused call raised; it must be a real refusal, not the skeleton. */
export async function rejection(call: () => Promise<unknown>): Promise<Error> {
  let caught: unknown;
  let resolved = false;
  try {
    await call();
    resolved = true;
  } catch (error) {
    caught = error;
  }
  expect(resolved, 'the call must be refused').toBe(false);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message, 'refused by the port, not the skeleton').not.toMatch(
    /NotImplemented/,
  );
  return caught as Error;
}

function insert(db: Kysely<DB>, table: string, row: Row) {
  const names = Object.keys(row);
  return sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
}

function where(table: Table, appId: string, sessionIds: readonly string[]) {
  const ids = [...sessionIds];
  if (table === 'agent_sessions') return sql`t.app_id = ${appId} AND t.id = ANY(${ids}::uuid[])`;
  if (table === 'agent_tool_calls' || table === 'agent_result_sets') {
    return sql`t.app_id = ${appId} AND t.run_id IN (SELECT r.id FROM app.agent_runs r
      WHERE r.app_id = ${appId} AND r.session_id = ANY(${ids}::uuid[]))`;
  }
  return sql`t.app_id = ${appId} AND t.session_id = ANY(${ids}::uuid[])`;
}

export function databaseKit(createDatabase: () => Promise<FixtureDatabase>) {
  let database: FixtureDatabase | undefined;
  let pool: Kysely<DB> | undefined;
  beforeAll(async () => {
    database = await createDatabase();
    pool = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  }, 180_000);
  afterAll(async () => {
    if (pool) await destroyDb(pool);
    if (database) await database.drop();
  });

  function db(): Kysely<DB> {
    expect(pool, 'PG fixture is ready').toBeDefined();
    return pool!;
  }

  async function user(appId = APP): Promise<string> {
    const id = randomUUID();
    await insert(db(), 'users', {
      id,
      app_id: appId,
      nickname: 'fixture',
      avatar: 'fixture',
      invite_code: randomBytes(6).toString('hex'),
      attr_code: randomBytes(6).toString('hex'),
      level: 'L1',
      register_method: 'sms',
      status: 'normal',
    });
    return id;
  }

  async function device(appId: string): Promise<string> {
    const id = randomUUID();
    await insert(db(), 'devices', {
      id,
      app_id: appId,
      user_id: null,
      install_secret_cipher: Buffer.from('synthetic-install-secret'),
      device_hash: deviceHash(id),
      id_source: 'idfv',
      platform: 'ios',
      app_version: 'synthetic@1',
      last_seen_at: SEEDED,
    });
    return id;
  }

  /** One session with three runs, messages, tool calls, cards, a result set and chains. */
  async function conversation(options: {
    userId: string | null;
    appId?: string;
    deviceId?: string;
  }): Promise<Conversation> {
    const appId = options.appId ?? APP;
    const owner = options.userId;
    const deviceId = options.deviceId ?? (await device(appId));
    const sessionId = randomUUID();
    const runIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    const resultSetId = randomUUID();
    const at = { created_at: SEEDED };
    await insert(db(), 'agent_sessions', {
      id: sessionId,
      app_id: appId,
      user_id: owner,
      device_id: deviceId,
      started_at: SEEDED,
      last_active_at: SEEDED,
      card_seq: 2,
      created_at: SEEDED,
      updated_at: SEEDED,
    });
    const guest = deviceSubject(deviceId);
    const subjects = owner
      ? [[memberSubject(owner)], [guest, memberSubject(owner)], [guest, IP]]
      : [[guest, IP], [guest, IP], [guest, IP]];
    const runBase = {
      app_id: appId,
      session_id: sessionId,
      prompt_version: 'synthetic@1',
      model: 'synthetic-model',
      accepted_at: SEEDED,
      deadline_at: SEEDED,
      created_at: SEEDED,
      updated_at: SEEDED,
    };
    await insert(db(), 'agent_runs', {
      ...runBase,
      id: runIds[0],
      user_text: secret('提问一', owner),
      intent: 'search',
      input_tokens: 10,
      output_tokens: 20,
      finish_reason: 'stop',
      final_event: JSON.stringify(doneFrame()),
      ended_at: SEEDED,
      end_reason: 'stop',
      card_delivered: true,
      settle_result: 'counted',
      settled_at: SEEDED,
      quota_subjects: subjects[0],
    });
    await insert(db(), 'agent_runs', {
      ...runBase,
      id: runIds[1],
      user_text: secret('提问二', owner),
      intent: 'search',
      finish_reason: 'error',
      final_event: JSON.stringify(errorFrame(owner)),
      end_draft: JSON.stringify(errorFrame(owner)),
      ended_at: SEEDED,
      end_reason: 'error',
      settle_result: 'refunded',
      settled_at: SEEDED,
      quota_subjects: subjects[1],
    });
    await insert(db(), 'agent_runs', {
      ...runBase,
      id: runIds[2],
      user_text: secret('提问三', owner),
      end_draft: JSON.stringify(draftWithoutQuery(owner)),
      end_reason: 'error',
      quota_subjects: subjects[2],
    });
    for (const [index, runId] of runIds.entries()) {
      await insert(db(), 'agent_messages', {
        ...at,
        id: randomUUID(),
        app_id: appId,
        session_id: sessionId,
        run_id: runId,
        client_msg_id: `synthetic-client-${String(index + 1)}`,
        role: 'user',
        text: secret(`用户消息${String(index + 1)}`, owner),
        updated_at: SEEDED,
      });
    }
    for (const [index, runId] of runIds.slice(0, 2).entries()) {
      await insert(db(), 'agent_messages', {
        ...at,
        id: randomUUID(),
        app_id: appId,
        session_id: sessionId,
        run_id: runId,
        role: 'assistant',
        text: secret(`助手回答${String(index + 1)}`, owner),
        card_ids: [`c${String(index + 1)}`],
        feedback: 'up',
        feedback_at: SEEDED,
        reported: true,
        reported_at: SEEDED,
        report_status: 'pending',
        report_reason: secret('举报理由', owner),
        report_note: secret('举报备注', owner),
        updated_at: SEEDED,
      });
      await insert(db(), 'agent_tool_calls', {
        ...at,
        id: randomUUID(),
        app_id: appId,
        run_id: runId,
        seq: 1,
        name: 'search_products',
        args: JSON.stringify({ q: secret('工具参数', owner), platforms: ['jd'] }),
        result_digest: 'synthetic-result-digest',
        status: 'ok',
        latency_ms: 12,
      });
      await insert(db(), 'agent_tool_calls', {
        ...at,
        id: randomUUID(),
        app_id: appId,
        run_id: runId,
        seq: 2,
        name: 'get_rebate_quote',
        args: null,
        result_digest: null,
        status: 'rejected',
        latency_ms: null,
      });
    }
    await insert(db(), 'agent_cards', {
      ...at,
      id: randomUUID(),
      app_id: appId,
      session_id: sessionId,
      run_id: runIds[0],
      card_id: 'c1',
      type: 'notice',
      schema_version: 1,
      data: JSON.stringify({ level: 'info', text: secret('卡片正文', owner) }),
      link_id: null,
      fallback_text: secret('卡片兜底', owner),
    });
    await insert(db(), 'agent_cards', {
      ...at,
      id: randomUUID(),
      app_id: appId,
      session_id: sessionId,
      run_id: runIds[1],
      card_id: 'c2',
      type: 'product_list',
      schema_version: 2,
      data: JSON.stringify({ items: [{ title: secret('商品标题', owner) }] }),
      link_id: null,
      fallback_text: secret('商品兜底', owner),
    });
    await insert(db(), 'agent_result_sets', {
      ...at,
      id: resultSetId,
      app_id: appId,
      run_id: runIds[0],
      conditions: JSON.stringify({ q: secret('搜索条件', owner), chain_id: 'synthetic-chain-1' }),
    });
    await insert(db(), 'agent_result_deliveries', {
      ...at,
      app_id: appId,
      session_id: sessionId,
      run_id: runIds[0],
      result_set_id: resultSetId,
      position: 1,
      card_id: 'c1',
      product_key: 'jd:synthetic-product-1',
      platform: 'jd',
      final_price_fen: 1990,
      card: JSON.stringify({ title: secret('投递卡片', owner), price_fen: 1990 }),
    });
    await insert(db(), 'agent_result_chains', {
      ...at,
      app_id: appId,
      session_id: sessionId,
      seq: 1,
      chain_id: 'synthetic-chain-1',
      status: 'has_products',
      conditions: JSON.stringify({ chain_id: 'synthetic-chain-1', q: secret('链条件', owner) }),
    });
    await insert(db(), 'agent_result_chains', {
      ...at,
      app_id: appId,
      session_id: sessionId,
      seq: 2,
      chain_id: 'synthetic-chain-2',
      status: 'awaiting_price',
      conditions: JSON.stringify({ chain_id: 'synthetic-chain-2', spec: secret('规格', owner) }),
    });
    await insert(db(), 'agent_clarify_asks', {
      ...at,
      app_id: appId,
      session_id: sessionId,
      chain_id: 'synthetic-chain-2',
      slot: 'price',
    });
    return { appId, userId: owner, deviceId, sessionId, runIds, resultSetId };
  }

  async function rows(
    table: Table,
    sessionIds: readonly string[],
    appId: string = APP,
  ): Promise<Row[]> {
    const result = await sql<Row>`SELECT t.* FROM ${sql.table(`app.${table}`)} AS t
      WHERE ${where(table, appId, sessionIds)} ORDER BY ${sql.raw(ORDER[table])}`.execute(db());
    return result.rows;
  }

  async function snapshot(sessionIds: readonly string[], appId: string = APP): Promise<Snapshot> {
    const entries = await Promise.all(
      TABLES.map(async (table) => [table, await rows(table, sessionIds, appId)] as const),
    );
    return Object.fromEntries(entries) as Snapshot;
  }

  /** Per agent_* table, how many rows of the app still contain the text anywhere. */
  async function occurrences(needle: string, appId: string = APP): Promise<Record<Table, number>> {
    const entries = await Promise.all(
      TABLES.map(async (table) => {
        const result = await sql<{ n: number }>`SELECT count(*)::int AS n
          FROM ${sql.table(`app.${table}`)} AS t
          WHERE t.app_id = ${appId} AND strpos(to_jsonb(t)::text, ${needle}) > 0`.execute(db());
        return [table, result.rows[0]?.n ?? -1] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<Table, number>;
  }

  /** The port on the caller's transaction, as the deletion cleanup (B1-15g) calls it. */
  async function purge(input: PurgeAgentDataInput, key = KEY): Promise<PurgeAgentDataResult> {
    const port = createAgentDataPurge({ userHashKey: key });
    return db()
      .transaction()
      .execute((trx) => port.purgeAgentDataForUser(trx, input));
  }

  return { db, user, device, conversation, rows, snapshot, occurrences, purge };
}
