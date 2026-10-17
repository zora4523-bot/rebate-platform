// B1-12d rule-test kit: GET /v1/messages/{message_id} (getMessage), the push-click lookup
// (BR-ID-10 细则「推送点击的落点」; 编排者裁定 B1–B5). Fixture rows are written straight into
// inbox_messages (couli_app may INSERT); every read under test goes through notification's
// createMessageReader or the real api entry. Real PostgreSQL through the shared
// TEST_PG_ADMIN_URL harness (registration kit's openKit). No rule of the lookup lives here.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  createMessageReader,
  type InboxMessageView,
} from '../../../../apps/api/src/modules/notification/application/message-read.ts';
import { openKit, closeKit, seedUser, type Kit } from '../../identity/registration/kit.ts';
import { contract } from '../../risk/signature/kit.ts';

export { openKit as openSuite, closeKit as closeSuite, seedUser, type Kit as Suite };

export const PATH = '/v1/messages/{message_id}';
export const DB_TIMEOUT = 60_000;

export interface SeedMessage {
  readonly app_id: string;
  readonly user_id: string;
  readonly message_id?: string;
  readonly code?: string;
  readonly title?: string;
  readonly body?: string;
  readonly route?: { route: string; params: Record<string, unknown> } | null;
  readonly read_at?: string | null;
  readonly created_at?: string;
}

/** Inserts one inbox_messages row; returns its message_id. */
export async function seedMessage(db: Kysely<DB>, values: SeedMessage): Promise<string> {
  const id = values.message_id ?? randomUUID();
  const created = values.created_at ?? '2026-10-02T01:30:00.000Z';
  await db
    .insertInto('inbox_messages')
    .values({
      message_id: id,
      app_id: values.app_id,
      user_id: values.user_id,
      code: values.code ?? 'WITHDRAW_PAID',
      title: values.title ?? '提现已到账',
      body: values.body ?? '你的提现已到账',
      route:
        values.route === null || values.route === undefined ? null : JSON.stringify(values.route),
      read_at:
        values.read_at === null || values.read_at === undefined ? null : new Date(values.read_at),
      created_at: new Date(created),
      updated_at: new Date(created),
    })
    .execute();
  return id;
}

/** Every inbox_messages row of an app, all columns, in a stable order. */
export function messagesOf(db: Kysely<DB>, app: string) {
  return db
    .selectFrom('inbox_messages')
    .selectAll()
    .where('app_id', '=', app)
    .orderBy('message_id')
    .execute();
}

export function readerOver(db: Kysely<DB>) {
  return createMessageReader({ db });
}

/** A fresh app id per fixture (X-App-Id pattern ^[a-z0-9_]+$). */
export function newAppId(prefix = 'msg'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** The view with its two instants normalised to ISO-8601 UTC for literal comparison. */
export function normalised(view: InboxMessageView | null) {
  if (view === null) return null;
  return {
    ...view,
    created_at: new Date(view.created_at).toISOString(),
    read_at: view.read_at === null ? null : new Date(view.read_at).toISOString(),
  };
}

type Validator = ((value: unknown) => boolean) & { errors?: unknown };
let validators: Promise<Map<string, Validator>> | undefined;

/** Compiled validators of getMessage: '200' (InboxMessageResponse), 'data' (InboxMessage), '4XX'. */
async function compiled(): Promise<Map<string, Validator>> {
  validators ??= (async () => {
    const operation = (await contract()).paths[PATH]!.get! as {
      responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
    };
    const compile = createValidatorCompiler();
    const body = (schema: JsonSchema) => compile({ schema, httpPart: 'body' }) as Validator;
    const ok = operation.responses['200']!.content['application/json']!.schema;
    const data = (ok as { properties: Record<string, JsonSchema> }).properties['data']!;
    return new Map([
      ['200', body(ok)],
      ['data', body(data)],
      ['4XX', body(operation.responses['4XX']!.content['application/json']!.schema)],
    ]);
  })();
  return validators;
}

/** The value passes the named getMessage schema ('200', 'data' or '4XX'). */
export async function expectSchema(name: '200' | 'data' | '4XX', value: unknown): Promise<void> {
  const check = (await compiled()).get(name)!;
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}
