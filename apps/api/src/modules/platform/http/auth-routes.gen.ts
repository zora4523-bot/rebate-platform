// Generated from contracts/openapi.yaml by platform/http/scripts/generate-auth-routes.ts.
// Do not edit by hand. Regenerate after contract changes.
export const CONTRACT_AUTH_ROUTES = [
  {
    "method": "GET",
    "path": "/healthz",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/devices",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/devices/push-token",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/auth/sms-codes",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/sms",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/oauth-attempts",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/wechat",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/apple",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/huawei",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/step-up",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/auth/refresh",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/logout",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/consents",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/auth/h5-token",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/unions/bindings",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/unions/:platform/auth-url",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/unions/:platform/bindings",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/orders",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/orders/pending-tracks",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/orders/pending-tracks/:link_id/dismiss",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/orders/:order_id",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/articles",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/articles/:article_id",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/app-versions/check",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/pages/:page_key/preview",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/messages/:message_id",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/wallet/summary",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/earnings/summary",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/wallet/ledger",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals/rules",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/withdrawals",
    "auth": "realname"
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals/:withdrawal_id",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/phone",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/payout-account",
    "auth": "realname"
  },
  {
    "method": "PUT",
    "path": "/v1/me/payout-account",
    "auth": "realname"
  },
  {
    "method": "GET",
    "path": "/v1/me/tips",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/tips/:tip_key/read",
    "auth": "login"
  },
  {
    "method": "DELETE",
    "path": "/v1/me/tips/:tip_key",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/deletion",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/deletion",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/deletion/cancel",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/appeals",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/appeals",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/idempotency-keys/abandon",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/config",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/products/search",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/products/:product_key",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/inputs/parse",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/links/:link_id/open",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/links/convert",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/links/:link_id",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/share-pages/:link_id",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/share-pages/:link_id/tpwd",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/login",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/password",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp/secret",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp/bind",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/logout",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/step-up/sms-codes",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/step-up",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/me/permissions",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/admins",
    "auth": "super"
  },
  {
    "method": "GET",
    "path": "/admin/v1/admins/:admin_id",
    "auth": "super"
  }
] as const;
