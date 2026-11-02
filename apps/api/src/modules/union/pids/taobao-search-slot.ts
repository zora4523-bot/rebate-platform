// 淘宝官方搜索的推广位只读入口（B1-04zx，D10-582；BR-PROD-07：检索固定用 query 场景推广位）。骨架：
// 实现轮填写。按 appId 读 union_pids 中 platform = taobao、pid_scene = query、status = active 的 PID。
// 只做一条 SELECT，不缓存（每次调用重查，退役立即生效），不写、不审计；没有这样的推广位 → null。
// 多个账号各有一条时按 union_account_id 升序取第一条，结果稳定。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** The active Taobao query PID of `appId`, or null when it has none. */
export function readTaobaoSearchSlot(db: Kysely<DB>, appId: string): Promise<string | null> {
  void db;
  void appId;
  throw new Error('NotImplemented: readTaobaoSearchSlot');
}
