import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Synthetic users, written through the same business role the application uses. */
export async function seedUser(
  db: Kysely<DB>,
  appId = 'couli',
  options: { status?: 'normal' | 'deleted'; attrCode?: string } = {},
) {
  const id = randomUUID();
  const attrCode = options.attrCode ?? randomBytes(4).toString('hex');
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: '身份端口测试用户',
      avatar: 'synthetic-avatar',
      invite_code: randomUUID(),
      attr_code: attrCode,
      level: 'normal',
      status: options.status ?? 'normal',
      register_method: 'sms',
    })
    .execute();
  return { id, appId, attrCode };
}
