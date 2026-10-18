import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { createInviteRelationHitWriter as CreateWriter } from '../../../../apps/api/src/modules/risk/application/invite-relation-hits.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

// 从唯一公开出口加载；计算路径避免将 Nest 装饰器带入 erasable-only 测试项目。
export const { createInviteRelationHitWriter } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as { createInviteRelationHitWriter: typeof CreateWriter };

export { FixedClock };
export const AT = '2026-10-18T03:04:05.678Z';
export const HASH = 'abcdef0123456789'.repeat(4);
export const CASES = [
  { rule_id: 'inv_08_self', dimension: 'user_id' },
  { rule_id: 'inv_08_descendant', dimension: 'user_id' },
  { rule_id: 'inv_08_same_device', dimension: 'device_id_hash' },
  { rule_id: 'inv_09_same_device', dimension: 'device_id_hash' },
] as const;

export async function seedUser(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${id}, ${appId}, 'fixture', 'fixture', ${randomBytes(3).toString('hex')},
      ${randomBytes(4).toString('hex')}, 'L1', 'sms', 'normal')`.execute(db);
  return id;
}

export function hits(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('risk_hits')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

export function rules(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('risk_rules')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('rule_id')
    .execute();
}
