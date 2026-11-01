// 淘宝订单推广位的只读入口（B1-04zn，D10-530；D10-488 ③；BR-ATTR-02：pending / active / retired
// 都计入白名单）：按 appId 读 union_pids 中 platform = taobao 的全部推广位（不按 status、不按场景过滤），
// 返回 PID 文本列表（mm_<memberid>_<siteid>_<adzoneid>）。只做一条 SELECT，不缓存（每次调用重查），
// 不写、不审计；读失败原样抛出，由调用方（listOrders）按既有口径处理。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Every Taobao PID registered for `appId` in union_pids, whatever its status or scene. */
export function readTaobaoOrderSlots(db: Kysely<DB>, appId: string): Promise<readonly string[]> {
  void db;
  void appId;
  throw new Error('NotImplemented: readTaobaoOrderSlots');
}
