// Generated from contracts/openapi.yaml by risk/application/scripts/generate-min-version-routes.ts.
// Do not edit by hand. Regenerate after contract changes.
export const CONTRACT_MIN_VERSION_ROUTES = [
  {
    "operationId": "getHealthz",
    "method": "GET",
    "path": "/healthz",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "registerDevice",
    "method": "POST",
    "path": "/v1/devices",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "reportPushToken",
    "method": "POST",
    "path": "/v1/devices/push-token",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "sendSmsCode",
    "method": "POST",
    "path": "/v1/auth/sms-codes",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "loginBySms",
    "method": "POST",
    "path": "/v1/auth/login/sms",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "createOauthAttempt",
    "method": "POST",
    "path": "/v1/auth/oauth-attempts",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "loginByWechat",
    "method": "POST",
    "path": "/v1/auth/login/wechat",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "loginByApple",
    "method": "POST",
    "path": "/v1/auth/login/apple",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "loginByHuawei",
    "method": "POST",
    "path": "/v1/auth/login/huawei",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "mergeAccount",
    "method": "POST",
    "path": "/v1/auth/merge",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "stepUp",
    "method": "POST",
    "path": "/v1/auth/step-up",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "refreshToken",
    "method": "POST",
    "path": "/v1/auth/refresh",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "logout",
    "method": "POST",
    "path": "/v1/auth/logout",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "recordConsent",
    "method": "POST",
    "path": "/v1/consents",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "issueH5Token",
    "method": "POST",
    "path": "/v1/auth/h5-token",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listUnionBindings",
    "method": "GET",
    "path": "/v1/unions/bindings",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getUnionAuthUrl",
    "method": "GET",
    "path": "/v1/unions/:platform/auth-url",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "bindUnion",
    "method": "POST",
    "path": "/v1/unions/:platform/bindings",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "listOrders",
    "method": "GET",
    "path": "/v1/orders",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listPendingTracks",
    "method": "GET",
    "path": "/v1/orders/pending-tracks",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "dismissPendingTrack",
    "method": "POST",
    "path": "/v1/orders/pending-tracks/:link_id/dismiss",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getOrder",
    "method": "GET",
    "path": "/v1/orders/:order_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listArticles",
    "method": "GET",
    "path": "/v1/articles",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getArticle",
    "method": "GET",
    "path": "/v1/articles/:article_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "checkAppVersion",
    "method": "GET",
    "path": "/v1/app-versions/check",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getPage",
    "method": "GET",
    "path": "/v1/pages/:page_key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "previewPage",
    "method": "GET",
    "path": "/v1/pages/:page_key/preview",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getMessage",
    "method": "GET",
    "path": "/v1/messages/:message_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getWalletSummary",
    "method": "GET",
    "path": "/v1/wallet/summary",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getEarningsSummary",
    "method": "GET",
    "path": "/v1/earnings/summary",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listWalletLedger",
    "method": "GET",
    "path": "/v1/wallet/ledger",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getWithdrawRules",
    "method": "GET",
    "path": "/v1/withdrawals/rules",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listWithdrawals",
    "method": "GET",
    "path": "/v1/withdrawals",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createWithdrawal",
    "method": "POST",
    "path": "/v1/withdrawals",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getWithdrawal",
    "method": "GET",
    "path": "/v1/withdrawals/:withdrawal_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getMe",
    "method": "GET",
    "path": "/v1/me",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "updateMe",
    "method": "PATCH",
    "path": "/v1/me",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "bindPhone",
    "method": "POST",
    "path": "/v1/me/phone",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "bindInviter",
    "method": "POST",
    "path": "/v1/me/inviter",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getMyInvite",
    "method": "GET",
    "path": "/v1/invites/me",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "sendLandingSmsCode",
    "method": "POST",
    "path": "/v1/landing/sms-codes",
    "gate": false,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "landingRegister",
    "method": "POST",
    "path": "/v1/invites/landing-register",
    "gate": false,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getPayoutAccount",
    "method": "GET",
    "path": "/v1/me/payout-account",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "savePayoutAccount",
    "method": "PUT",
    "path": "/v1/me/payout-account",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getTips",
    "method": "GET",
    "path": "/v1/me/tips",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "markTipRead",
    "method": "POST",
    "path": "/v1/me/tips/:tip_key/read",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "resetTip",
    "method": "DELETE",
    "path": "/v1/me/tips/:tip_key",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getDeletion",
    "method": "GET",
    "path": "/v1/me/deletion",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "requestDeletion",
    "method": "POST",
    "path": "/v1/me/deletion",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": true
  },
  {
    "operationId": "cancelDeletion",
    "method": "POST",
    "path": "/v1/me/deletion/cancel",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "listAppeals",
    "method": "GET",
    "path": "/v1/me/appeals",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "submitAppeal",
    "method": "POST",
    "path": "/v1/me/appeals",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "abandonIdempotencyKey",
    "method": "POST",
    "path": "/v1/idempotency-keys/abandon",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getConfig",
    "method": "GET",
    "path": "/v1/config",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "searchProducts",
    "method": "GET",
    "path": "/v1/products/search",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getProduct",
    "method": "GET",
    "path": "/v1/products/:product_key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getProductPriceTrend",
    "method": "GET",
    "path": "/v1/products/:product_key/price-trend",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listFavorites",
    "method": "GET",
    "path": "/v1/me/favorites",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "addFavorite",
    "method": "PUT",
    "path": "/v1/me/favorites/:platform/:product_key",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "removeFavorite",
    "method": "DELETE",
    "path": "/v1/me/favorites/:platform/:product_key",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "batchDeleteFavorites",
    "method": "POST",
    "path": "/v1/me/favorites/batch-delete",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "parseInput",
    "method": "POST",
    "path": "/v1/inputs/parse",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "openLink",
    "method": "POST",
    "path": "/v1/links/:link_id/open",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "convertLink",
    "method": "POST",
    "path": "/v1/links/convert",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getLink",
    "method": "GET",
    "path": "/v1/links/:link_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getSharePage",
    "method": "GET",
    "path": "/v1/share-pages/:link_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getShareTpwd",
    "method": "POST",
    "path": "/v1/share-pages/:link_id/tpwd",
    "gate": false,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminLogin",
    "method": "POST",
    "path": "/admin/v1/auth/login",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminChangeInitialPassword",
    "method": "POST",
    "path": "/admin/v1/auth/password",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetTotpBindingSecret",
    "method": "POST",
    "path": "/admin/v1/auth/totp/secret",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminBindTotp",
    "method": "POST",
    "path": "/admin/v1/auth/totp/bind",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminVerifyTotp",
    "method": "POST",
    "path": "/admin/v1/auth/totp",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminLogout",
    "method": "POST",
    "path": "/admin/v1/auth/logout",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSendStepUpSms",
    "method": "POST",
    "path": "/admin/v1/auth/step-up/sms-codes",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminStepUp",
    "method": "POST",
    "path": "/admin/v1/auth/step-up",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetMyPermissions",
    "method": "GET",
    "path": "/admin/v1/me/permissions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListAdmins",
    "method": "GET",
    "path": "/admin/v1/admins",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetAdmin",
    "method": "GET",
    "path": "/admin/v1/admins/:admin_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUsers",
    "method": "GET",
    "path": "/admin/v1/users",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminLookupUser",
    "method": "GET",
    "path": "/admin/v1/users/lookup",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetUser",
    "method": "GET",
    "path": "/admin/v1/users/:user_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRevealUserField",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/reveal",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateUserRiskState",
    "method": "PUT",
    "path": "/admin/v1/users/:user_id/risk-state",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminResetUserUnionBinding",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/reset",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminDisableUserUnionBinding",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/disable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminEnableUserUnionBinding",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/enable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPlatformIcons",
    "method": "GET",
    "path": "/admin/v1/platform-icons",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPlatformIconVersions",
    "method": "GET",
    "path": "/admin/v1/platform-icons/:key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreatePlatformIconVersion",
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUploadPlatformIcon",
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/uploads",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdatePlatformIconVersion",
    "method": "PATCH",
    "path": "/admin/v1/platform-icons/:key/versions/:version",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminPublishPlatformIcon",
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/publish",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRestoreBuiltinPlatformIcon",
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/restore-builtin",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPageConfigs",
    "method": "GET",
    "path": "/admin/v1/pages",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetPageConfig",
    "method": "GET",
    "path": "/admin/v1/pages/:page_key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPageConfigVersions",
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreatePageConfigVersion",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetPageConfigVersion",
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions/:version",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminPublishPageConfig",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/publish",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdatePageConfigGray",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/gray",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRollbackPageConfig",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/rollback",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreatePagePreviewToken",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/preview-tokens",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListKillSwitches",
    "method": "GET",
    "path": "/admin/v1/kill-switches",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateKillSwitch",
    "method": "PUT",
    "path": "/admin/v1/kill-switches/:key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListConfigItems",
    "method": "GET",
    "path": "/admin/v1/config-items",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminBatchUpdateConfigItems",
    "method": "POST",
    "path": "/admin/v1/config-items/batch",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetConfigItem",
    "method": "GET",
    "path": "/admin/v1/config-items/:key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateConfigItem",
    "method": "PUT",
    "path": "/admin/v1/config-items/:key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListConfigItemVersions",
    "method": "GET",
    "path": "/admin/v1/config-items/:key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRollbackConfigItem",
    "method": "POST",
    "path": "/admin/v1/config-items/:key/rollback",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createAgentSession",
    "method": "POST",
    "path": "/v1/agent/sessions",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getCurrentAgentSession",
    "method": "GET",
    "path": "/v1/agent/sessions/current",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listAgentSessionMessages",
    "method": "GET",
    "path": "/v1/agent/sessions/:id/messages",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "sendAgentMessage",
    "method": "POST",
    "path": "/v1/agent/sessions/:id/messages",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "cancelAgentRun",
    "method": "POST",
    "path": "/v1/agent/runs/:run_id/cancel",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "setAgentMessageFeedback",
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/feedback",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "reportAgentMessage",
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/report",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  }
] as const;
