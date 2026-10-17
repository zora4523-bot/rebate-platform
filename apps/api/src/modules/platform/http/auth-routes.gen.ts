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
    "path": "/v1/auth/merge",
    "auth": "login"
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
    "path": "/v1/pages/:page_key",
    "auth": "optional"
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
    "method": "PATCH",
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
    "method": "GET",
    "path": "/v1/products/:product_key/price-trend",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/me/favorites",
    "auth": "login"
  },
  {
    "method": "PUT",
    "path": "/v1/me/favorites/:platform/:product_key",
    "auth": "login"
  },
  {
    "method": "DELETE",
    "path": "/v1/me/favorites/:platform/:product_key",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/favorites/batch-delete",
    "auth": "login"
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
  },
  {
    "method": "GET",
    "path": "/admin/v1/users",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/lookup",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/reveal",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/users/:user_id/risk-state",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/reset",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/disable",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/enable",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/platform-icons",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/platform-icons/:key/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/uploads",
    "auth": "admin"
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/platform-icons/:key/versions/:version",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/publish",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/restore-builtin",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/versions",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions/:version",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/publish",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/gray",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/rollback",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/preview-tokens",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/kill-switches",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/kill-switches/:key",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/config-items/batch",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items/:key",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/config-items/:key",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items/:key/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/config-items/:key/rollback",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/v1/agent/sessions",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/agent/sessions/current",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/agent/sessions/:id/messages",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/agent/sessions/:id/messages",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/agent/runs/:run_id/cancel",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/feedback",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/report",
    "auth": "optional"
  }
] as const;
