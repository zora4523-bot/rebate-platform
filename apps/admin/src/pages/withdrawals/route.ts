// 提现审核的路由：菜单 id 与详情地址 withdrawals/{withdrawal_id}（只认 UUID，契约 AdminWithdrawalIdPath）。
export const WITHDRAWALS_MENU_ID = 'withdrawals';

const DETAIL = /^withdrawals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The withdrawal_id of a detail address (/withdrawals/<withdrawal_id>), else undefined. */
export function withdrawalIdOf(path: string): string | undefined {
  return DETAIL.exec(path)?.[1];
}
