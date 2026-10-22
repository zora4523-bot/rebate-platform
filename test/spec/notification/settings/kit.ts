// B1-12m: fixtures and contract validation only. Sending is outside this task.
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contract } from '../../risk/signature/kit.ts';
export { seedUser } from '../../identity/registration/kit.ts';
export { newAppId } from '../message-read/kit.ts';

export type Settings = Schema<'NotificationSettings'>;
export interface Owner {
  app_id: string;
  user_id: string;
}
export const PATH = '/v1/me/notification-settings';
export const NOW = '2026-10-22T03:04:05.678Z';
export const TIMEOUT = 60_000;
export const ON: Settings = {
  service_push: true,
  subscription_push: true,
  marketing_push: true,
};
export const OFF: Settings = {
  service_push: false,
  subscription_push: false,
  marketing_push: false,
};
export const COMBINATIONS: Settings[] = [false, true].flatMap((service_push) =>
  [false, true].flatMap((subscription_push) =>
    [false, true].map((marketing_push) => ({
      service_push,
      subscription_push,
      marketing_push,
    })),
  ),
);
export const OPERATIONS = [
  { id: 'getNotificationSettings', method: 'get', verb: 'GET' },
  { id: 'updateNotificationSettings', method: 'put', verb: 'PUT' },
] as const;
export type Operation = (typeof OPERATIONS)[number]['id'];

export function settingsOf(db: Kysely<DB>, owner: Owner) {
  return db
    .withSchema('app')
    .selectFrom('notification_settings')
    .selectAll()
    .where('app_id', '=', owner.app_id)
    .where('user_id', '=', owner.user_id)
    .execute();
}

export async function seedSettings(db: Kysely<DB>, owner: Owner, settings: Settings) {
  await db
    .withSchema('app')
    .insertInto('notification_settings')
    .values({ ...owner, ...settings })
    .execute();
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
    const op = (await contract()).paths[PATH]![spec.method]! as {
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
