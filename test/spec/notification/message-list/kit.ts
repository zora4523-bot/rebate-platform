// B1-12k fixtures and response validation only; no pagination or read-state implementation.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contract } from '../../risk/signature/kit.ts';
export { seedUser } from '../../identity/registration/kit.ts';
export { messagesOf, newAppId, normalised } from '../message-read/kit.ts';

export const TIMEOUT = 60_000;
export const NOW = '2026-10-21T03:04:05.678Z';
export const OPERATIONS = [
  { id: 'listMessages', method: 'get', path: '/v1/messages' },
  { id: 'markMessagesRead', method: 'post', path: '/v1/messages/read' },
  { id: 'getUnreadMessageCount', method: 'get', path: '/v1/messages/unread-count' },
] as const;
export type Operation = (typeof OPERATIONS)[number]['id'];

/** Raw timestamp strings preserve PG microseconds; JS Date would erase the test boundary. */
export async function seedMessage(
  db: Kysely<DB>,
  owner: { app_id: string; user_id: string },
  values: {
    message_id?: string;
    created_at?: string;
    read_at?: string | null;
    route?: { route: string; params: Record<string, unknown> } | null;
    row_version?: number;
  } = {},
): Promise<string> {
  const id = values.message_id ?? randomUUID();
  const created = values.created_at ?? '2026-10-02T01:30:00.000Z';
  await db
    .withSchema('app')
    .insertInto('inbox_messages')
    .values({
      ...owner,
      message_id: id,
      code: 'WITHDRAW_PAID',
      title: '提现已到账',
      body: '你的提现已到账',
      route: values.route == null ? null : JSON.stringify(values.route),
      created_at: sql<Date>`${created}::timestamptz`,
      updated_at: sql<Date>`${created}::timestamptz`,
      read_at: values.read_at == null ? null : sql<Date>`${values.read_at}::timestamptz`,
      row_version: values.row_version ?? 0,
    })
    .execute();
  return id;
}

type Validator = ((value: unknown) => boolean) & { errors?: unknown };
const validators = new Map<string, Validator>();
export async function expectSchema(
  operation: Operation,
  part: '200' | '4XX' | 'data',
  value: unknown,
): Promise<void> {
  const key = `${operation}:${part}`;
  let check = validators.get(key);
  if (check === undefined) {
    const spec = OPERATIONS.find((op) => op.id === operation)!;
    const op = (await contract()).paths[spec.path]![spec.method]! as {
      responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
    };
    const response =
      op.responses[part === 'data' ? '200' : part]!.content['application/json']!.schema;
    const schema =
      part === 'data'
        ? (response as { properties: Record<string, JsonSchema> }).properties['data']!
        : response;
    check = createValidatorCompiler()({ schema, httpPart: 'body' }) as Validator;
    validators.set(key, check);
  }
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}
