// B1-04zg（D10-529）：京东 validCode 的两处日志判定，纯函数，不改映射与表外码流程。
// 码到事件的映射在 specs/order-status-map/jd.csv；这里只回答这一行要不要额外写 warn、要不要省掉 warn。
export { isOrderSourceMismatch, isAwaitingPaymentDrop } from './platform-rules/jd-status.ts';
