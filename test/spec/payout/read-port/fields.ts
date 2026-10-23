// B2-05l constants shared by the static and the PG rule tests (no database imports here).

export const PORT_PATH = '../../../../apps/api/src/modules/payout/ports/withdrawal-notification.ts';
export const INDEX_PATH = '../../../../apps/api/src/modules/payout/index.ts';
export const READ_PATH = '../../../../apps/api/src/modules/payout/read.ts';

/** The exact key set of WithdrawalNotificationView (task §9 item 2), sorted. */
export const VIEW_KEYS = [
  'amount_fen',
  'created_at',
  'fail_code',
  'fee_fen',
  'net_fen',
  'paid_at',
  'payout_channel',
  'reject_reason_code',
  'status',
  'tax_fen',
  'user_id',
  'withdrawal_id',
] as const;

/** Personal / payee / internal columns of withdrawals that must never leave the port. */
export const PRIVATE_KEYS = [
  'payee_name',
  'payee_account_cipher',
  'payee_hmac',
  'bank_name',
  'wechat_app_id',
  'wechat_launch_cipher',
  'reject_note',
] as const;
