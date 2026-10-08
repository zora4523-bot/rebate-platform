// Generated from contracts/openapi.yaml by platform/validation/scripts/generate-signing-routes.ts.
// Do not edit by hand. Regenerate after contract changes.
export const CONTRACT_SIGNING_ROUTES = [
  {
    "method": "GET",
    "path": "/healthz",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/devices",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/devices/push-token",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/auth/sms-codes",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/sms",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/oauth-attempts",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/wechat",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/apple",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/huawei",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/step-up",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/refresh",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/logout",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/consents",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/auth/h5-token",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/unions/bindings",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/unions/:platform/auth-url",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/unions/:platform/bindings",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/orders",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/orders/pending-tracks",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/orders/pending-tracks/:link_id/dismiss",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/orders/:order_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/articles",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/articles/:article_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/app-versions/check",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/pages/:page_key/preview",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/messages/:message_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/wallet/summary",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/earnings/summary",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/wallet/ledger",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals/rules",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/withdrawals",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals/:withdrawal_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/phone",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/me/payout-account",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/v1/me/payout-account",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/me/tips",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/tips/:tip_key/read",
    "signed": false
  },
  {
    "method": "DELETE",
    "path": "/v1/me/tips/:tip_key",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/deletion",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/deletion",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/me/deletion/cancel",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/appeals",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/appeals",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/idempotency-keys/abandon",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/config",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/products/search",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/products/:product_key",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/inputs/parse",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/links/:link_id/open",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/links/convert",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/links/:link_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/share-pages/:link_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/share-pages/:link_id/tpwd",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/login",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/password",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp/secret",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp/bind",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/logout",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/step-up/sms-codes",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/step-up",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/me/permissions",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/admins",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/admins/:admin_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/agent/sessions",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/agent/sessions/current",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/agent/sessions/:id/messages",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/agent/runs/:run_id/cancel",
    "signed": false
  }
] as const;
