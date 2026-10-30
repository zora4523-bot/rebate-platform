// 拼多多查询身份的推广位只读入口（B1-04x；BR-ATTR-08：按 scene 取 active 推广位，找不到不改用
// 其他场景）。只做一条 SELECT：不校验超级账号、不写审计、不缓存（每次调用重查，退役立即生效），
// 适用只读库账号。同场景多个 active（D10-231 后各账号可各有一条）时取 updated_at 最早的一条，
// 相同再按 created_at、id 升序（D10-427 ③，确定性）；候选多于一条时写一条 info 日志：app_id、
// 所选 union_pid 的 id 与 union_account_id、候选条数（同一条 SELECT 的 count(*) over () 得出），
// 不含 pid 或任何凭据。
// TODO(规划/11 §4.5): 多个拼多多账号按账号选查询位 — blocked on 账号选取口径（FU-PDD-QUERY-ACCT）
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { RootLogger } from '../../platform/index.ts';

/** 当前 app 的 pdd / query / active 推广位；没有则 null。给了 logger 时候选多于一条记一条日志。 */
export async function readActivePddQueryPid(
  db: Kysely<DB>,
  appId: string,
  logger?: RootLogger,
): Promise<string | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('union_pids')
    .select([
      'id',
      'pid',
      'union_account_id',
      sql<number>`(count(*) over ())::int`.as('candidates'),
    ])
    .where('app_id', '=', appId)
    .where('platform', '=', 'pdd')
    .where('pid_scene', '=', 'query')
    .where('status', '=', 'active')
    .orderBy('updated_at', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return null;
  if (logger !== undefined && row.candidates > 1) {
    logger.info(
      {
        app_id: appId,
        union_pid_id: row.id,
        union_account_id: row.union_account_id,
        candidates: row.candidates,
      },
      'pdd_query_pid_selected',
    );
  }
  return row.pid;
}
