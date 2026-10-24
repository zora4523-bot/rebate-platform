// 不连库的常量与纯函数；连库的夹具在 db-kit.ts，数据库生命周期只在 *.int.test.ts 管理。
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';

export const NOTE = '用户反映订单异常，先暂停核实';
export const IP = '192.0.2.31';
export const ADMIN_NAME = '测试客服';
/** 20902 with data.resource=order: every refusal of R11, same state, open pending, stale version. */
export const CONFLICT = { code: 20902, data: { resource: 'order' } } as const;
export const fieldsError = (field: string) => ({ code: 20001, data: { fields: [field] } });
/** Holds order.claim and no risk.* point: the derived reason code is CS. */
export const CS_GRANTS: readonly string[] = ['order.view', 'order.hold', 'order.claim'];

export type Mode = 'hold' | 'unhold';

/** The order a mode accepts: not held for hold, a manual CS hold for unhold. */
export function acceptable(mode: Mode): Partial<Insertable<DB['orders']>> {
  return mode === 'hold' ? { hold: false, hold_reason: null } : { hold: true, hold_reason: 'CS' };
}
