// contracts/texts.default.json (bundled default texts, 08 BR-TEXT-12 / BR-TEXT-14): an independent
// reading of the rules that scripts/texts.ts enforces in `pnpm contracts:check`, plus the keys
// the contract ledger rows b1-40, b2-27, b3-37, b4-31 and b5-28 name (CT-16e).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { errorCodes } from './index.ts';

type TextsFile = {
  version: number;
  texts: Record<string, string>;
  fallbacks: Record<string, string>;
};

const file = JSON.parse(
  readFileSync(new URL('../../../contracts/texts.default.json', import.meta.url), 'utf8'),
) as TextsFile;
const { texts, fallbacks } = file;

/** BR-TEXT-14 table A rows marked 「—」: handled silently, no text. */
const SILENT = [10002, 10402, 30505, 44003];

it('has the expected shape, sorted keys and non-empty texts', () => {
  expect(Object.keys(file).sort()).toEqual(['fallbacks', 'texts', 'version']);
  expect(file.version).toBe(1);
  const keys = Object.keys(texts);
  expect(keys).toEqual([...keys].sort());
  for (const [key, value] of Object.entries(texts)) {
    expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*$/);
    expect(typeof value).toBe('string');
    expect(value.trim()).toBe(value);
    expect(value.length).toBeGreaterThan(0);
  }
});

it('fallbacks belong to texts with a placeholder and carry none themselves', () => {
  for (const [key, value] of Object.entries(fallbacks)) {
    expect(texts[key]).toMatch(/\{[a-z0-9_]+\}/);
    expect(value).not.toMatch(/[{}]/);
  }
  expect(fallbacks['error.30416']).toBe('账户有待扣回金额，抵扣回正后才能注销');
  expect(texts['error.30416']).toBe('账户有待扣回金额 {amount}，抵扣回正后才能注销');
});

it('every live MVP error code has error.<code>, silent codes have none', () => {
  for (const [code, def] of Object.entries(errorCodes)) {
    const key = `error.${code}`;
    if (SILENT.includes(Number(code))) expect(texts[key]).toBeUndefined();
    else if (!def.deprecated && def.phase === null) expect(texts[key], key).toBeTypeOf('string');
    if (def.deprecated) expect(texts[key]).toBeUndefined();
  }
  for (const key of Object.keys(texts).filter((k) => k.startsWith('error.'))) {
    const [, code, reason] = key.split('.');
    const def = errorCodes[Number(code) as keyof typeof errorCodes];
    expect(def, key).toBeDefined();
    if (reason !== undefined) expect(def.data, key).toHaveProperty('reason');
  }
});

it('covers the keys of contract ledger rows b1-40 … b5-28', () => {
  const required = [
    // b1-40
    'error.20004',
    'error.50305',
    'error.20004.identity_mismatch',
    'error.30104.credential_invalid',
    'external_page.product_unresolved',
    'external_page.union_host_blocked',
    'link_landing.owner_hint',
    'link_landing.invalid',
    'share_page.open_in_app',
    'share_page.open_in_browser_hint',
    'share_page.copy_tpwd',
    'share_page.copy_tpwd.done',
    'download_guide.download',
    'download_guide.reopen',
    'invite.bind_phone_guide.title',
    'invite.bind_phone_guide.body',
    'invite.bind_phone_guide.body_before_buy',
    'invite.before_buy_tip',
    // b2-27
    'no_rebate.price_compare',
    'no_rebate.price_compare.confirm',
    'no_rebate.price_compare.similar',
    'order.price_compare.hint',
    'order_list.history_hint',
    'claim.guide.entry',
    'claim.guide.order_no',
    'claim.guide.paid_date',
    'claim.guide.window',
    'claim.guide.caution',
    'invite.notice_inviter',
    'login.help_entry',
    'external_page.download_blocked',
    'external_page.download_unsupported',
    'external_page.open_in_browser',
    'error.20001.phone_invalid',
    'error.30303.payout_account_verify_limit',
    'error.20903',
    'pending_confirm.title',
    'pending_confirm.withdraw.desc',
    'pending_confirm.withdraw.action',
    'pending_confirm.withdraw.abandon',
    'pending_confirm.payout_account.desc',
    'pending_confirm.phone_change.desc',
    'pending_confirm.deletion.desc',
    'pending_confirm.abandon',
    'pending_confirm.abandon.confirm',
    'pending_confirm.abandon.ok',
    'pending_confirm.abandon.cancel',
    'pending_confirm.abandoned',
    'pending_confirm.abandon_busy',
    'pending_confirm.already_done',
    'pending_confirm.retry_later',
    'pending_confirm.cannot_confirm',
    // b3-37
    'error.10405',
    'error.10403.h5_read_only',
    'error.10405.no_account',
    'app_update.go_store',
    'app_update.later',
    'app_update.privacy_policy',
    'app_update.delete_account',
    'app_update.cancel_deletion',
    'login.wechat_unavailable',
    'share.wechat_unavailable',
    'cs.wechat_unavailable',
    'cs.copy_link',
    'cs.go_help',
    'perm.push.card_hint',
    'perm.push.cta',
    'perm.photos.purpose',
    'perm.go_settings',
    'perm.btn.continue',
    // b4-31
    'error.50304.search_disabled',
    'buy.opening',
    'buy.opening.cancel',
    'jump.taobao_sdk_unavailable',
    'auth_manage.title',
    'order_status_group.all',
    'order_status_group.estimating',
    'order_status_group.credited',
    'order_status_group.no_rebate',
    'order_list.filter.platform',
    'order_list.filter.month',
    'order_list.search.placeholder',
    'order_list.search.placeholder_share',
    'order_list.deposit_amount',
    'order_list.other_product',
    'order_timeline.deposit_paid',
    'order_timeline.final_paid',
    'order_detail.view_product',
    'amount_mask.hide',
    'amount_mask.show',
    'agent.notice.search_disabled',
    'error.30201',
    // b5-28 (37 keys)
    'withdraw_detail.trade_no',
    'withdraw_detail.copy',
    'withdraw_detail.copied',
    'withdraw.balance_line',
    'withdraw.remaining_counts',
    'withdraw.max_line',
    'withdraw.all',
    'withdraw.estimate',
    'withdraw.estimate.net_only',
    'withdraw.estimate.calculating',
    'withdraw.rules_link',
    'ledger.balance_after',
    'share.copy_full',
    'share.copy_tpwd_only',
    'share.copy_link_only',
    'share.copied',
    'share.open_wechat',
    'share.save_images',
    'share.saved',
    'external_page.load_failed',
    'external_page.retry',
    'external_page.close',
    'settings.clear_cache',
    'settings.clear_cache.size',
    'settings.clear_cache.confirm',
    'settings.clear_cache.confirm_ok',
    'settings.clear_cache.confirm_cancel',
    'settings.clear_cache.done',
    'about.copy_diagnostics',
    'about.copy_diagnostics.done',
    'privacy.system_permissions.title',
    'privacy.system_permissions.hint',
    'privacy.system_permissions.status.granted',
    'privacy.system_permissions.status.denied',
    'privacy.system_permissions.status.not_asked',
    'app_update.unavailable',
    'app_update.retry',
  ];
  for (const key of required) expect(texts[key], key).toBeTypeOf('string');
  expect(Object.keys(texts).filter((k) => k.startsWith('earnings.'))).toHaveLength(17);
  // b4-31: 30201 no longer tells a missing order from a hidden share order (BR-ATTR-17).
  expect(texts['error.30201']).toBe(
    '没有找到可以找回的订单，请核对订单号；刚下单的订单可能还未同步，请稍后再试',
  );
  // Not in the user-side dictionary (ledger notes).
  expect(texts['pending_confirm.expired']).toBeUndefined();
  expect(texts['error.20001.invalid_device_hash']).toBeUndefined();
});
