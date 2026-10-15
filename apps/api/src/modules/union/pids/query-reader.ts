// 拼多多查询身份的推广位只读入口（B1-04x；BR-ATTR-08：按 scene 取 active 推广位，找不到不改用
// 其他场景）。只做一条 SELECT：不校验超级账号、不写审计、不缓存（每次调用重查，退役立即生效），
// 适用只读库账号。暂按每个 app 只有一个拼多多账号的查询位处理；同场景多个 active 时取法与
// service.ts 的 getActivePid 一致（最早更新的一条）。
// TODO(规划/11 §4.5): 多个拼多多账号按账号选查询位 — blocked on 账号选取口径（见 B1-19d 做法）
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** 当前 app 的 pdd / query / active 推广位；没有则 null。 */
export async function readActivePddQueryPid(db: Kysely<DB>, appId: string): Promise<string | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('union_pids')
    .select('pid')
    .where('app_id', '=', appId)
    .where('platform', '=', 'pdd')
    .where('pid_scene', '=', 'query')
    .where('status', '=', 'active')
    .orderBy('updated_at', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(1)
    .executeTakeFirst();
  return row?.pid ?? null;
}
