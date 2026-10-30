// B2-04l: settlement's rights command and R11 admin hold / unhold (orders' rights ports, B1-09c).
// Module-internal entry; settlement's index.ts re-exports it for app.module.
// 生产装配维权端口的任务须 deps B2-04lb（TODO(规划/11 §4.2): 入账前部分维权 N_new 落库与 WAIT_COMMISSION 入账前关闭 — blocked on B2-04lb（D10-470））。
export { createRightsCommandPort } from './rights-command.ts';
export type { RightsCommandDependencies } from './rights-command.ts';
export { createRebateAdminCommandPort } from './admin-hold.ts';
export type { RebateAdminDependencies } from './admin-hold.ts';
