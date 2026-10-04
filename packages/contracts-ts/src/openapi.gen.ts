// GENERATED FILE. Do not edit by hand.
// Source: contracts/openapi.yaml
// Regenerate: pnpm contracts:codegen (drift is checked by pnpm contracts:check)

export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Liveness probe
         * @description Returns 200 as soon as the process has finished initialising. It checks no
         *     dependency (database, cache, queue). Served by every HTTP entry.
         */
        get: operations["getHealthz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register a device
         * @description Issues `device_id` and `install_secret` after the user has agreed to the privacy policy
         *     (BR-ID-09). The client stores install_secret only in Keychain / Keystore / HUKS and signs
         *     later requests with it. Not signed: the device has no secret yet.
         *     `device_hash` is lowercase_hex(SHA-256(UTF-8 bytes of the identifier with surrounding
         *     whitespace removed, lower-cased)) and `id_source` names the identifier (BR-ID-09 细则
         *     「设备标识的无效值」; MVP Android uses ANDROID_ID only). The client never hashes an invalid
         *     identifier (empty, all zeros, wrong format). A hash of the wrong format, or one on the
         *     invalid-hash list (config device.invalid_hashes), is 20001 with `data.fields=[device_hash]`
         *     and no device_id is issued; the client shows nothing and reads the identifier again
         *     instead of retrying the same value. Reaching the per-IP hourly registration limit is 42901
         *     with Retry-After (BR-ID-05 细则「发码与设备注册的风控默认值」).
         *     `id_source` is required (04 §6.1, §3.2 devices). Making it required is not a breaking
         *     change: the operation is still planned (no route, no caller), and the oasdiff check leaves
         *     planned operations out of the base contract (tools/ci/oasdiff-base.ts).
         *     Version gate: not applied (session recovery, BR-ID-01 细则 interface table). Session scopes:
         *     accepts deletion_only (BR-ID-01 细则「受限会话」).
         */
        post: operations["registerDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/devices/push-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Report the push token of this device
         * @description Writes push_tokens through the notification module. The token value and its binding are
         *     written only when the calling session is the latest login session of this device;
         *     otherwise the report is ignored. A token value already registered on another device row
         *     is taken over or not according to device registration order and session creation time;
         *     a holder row that changed hands within the conflict window is frozen and reports during
         *     the freeze are not written (BR-ID-07 细则「推送令牌与会话」). Every case answers success.
         *     The client reports once after each successful login with the new session. provider is a
         *     string until the push provider is chosen (orchestrator decision D-14).
         */
        post: operations["reportPushToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sms-codes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send an SMS verification code
         * @description Order of checks: signature 10401 / 10402 → 20001 → 44001 → 44003 → 42901 (BR-ID-05). Limits per
         *     phone: 1 per 60 s, 10 per natural day (+08:00); a code is 6 digits and valid 5 minutes.
         *     `phone` is normalised by the server (BR-ID-05 细则「手机号规范化」); when the result is not
         *     a mainland mobile number the answer is 20001 with `data.fields=[phone]` and
         *     `data.reason=phone_invalid`, no SMS is sent and nothing counts towards the limits.
         *     Version gate (conditional, the table of BR-ID-01 细则 rules): not applied when purpose=login,
         *     or purpose=step_up with action=account_deletion; applied otherwise (purpose=bind, or step_up
         *     without action or with another action). Session scopes: a deletion_only session is accepted
         *     only for purpose=login and for purpose=step_up with action=account_deletion. Both conditions
         *     follow BR-ID-01 细则, which wins on any difference.
         */
        post: operations["sendSmsCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login/sms": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Log in (or register) with an SMS code
         * @description Creates the account on first login. The request carries the legal versions the user
         *     agreed to and the time of agreement (BR-ID-04). An `invite_code` is ignored for an
         *     existing account; `invite_bind` is present only when a non-empty invite_code was sent
         *     (BR-INV-06). Errors: 20002 wrong code, 20003 expired code (BR-ID-05). `phone` is
         *     normalised by the server; a number that does not normalise to a mainland mobile number is
         *     20001 with `data.fields=[phone]`, `data.reason=phone_invalid` (BR-ID-05 细则「手机号规范化」).
         *     Creating the account checks the same-device registration limit (44001, BR-ID-05).
         *     Version gate: not applied (session recovery). A client below the minimum version gets a
         *     restricted login (BR-ID-01 细则「受限会话」): only an existing account is logged in, invite_code is
         *     ignored (BR-INV-06 handling for an existing account), nothing is created or bound, and no
         *     existing account → 10405 with data.reason=no_account; the response carries
         *     session_scope=deletion_only. Session scopes: accepts deletion_only.
         */
        post: operations["loginBySms"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/oauth-attempts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Get a one-time third-party authorization attempt
         * @description Called before every WeChat, Apple or Huawei authorization (BR-ID-04 细则「第三方身份只信
         *     服务端换取或验签的结果」). The attempt is bound to the provider, the purpose and this
         *     device_id (purpose=step_up also to the user and `action`); it is valid once and for the
         *     configured lifetime (auth.oauth_attempt_ttl_sec). A submission checks it first and
         *     consumes it only after every check passed. The client passes `nonce` to the provider SDK.
         *     purpose=step_up requires a logged-in user (otherwise 10001) and `action`; it is issued only
         *     to an account without a bound phone (a bound phone → 20001 with `data.fields=[provider]`,
         *     BR-ID-08). purpose=step_up with action=account_deletion is inside the 10006 whitelist
         *     (BR-ID-31). Storage unavailable → 50001.
         *     Version gate (conditional): not applied when purpose=login, or purpose=step_up with
         *     action=account_deletion; applied otherwise. Session scopes: a deletion_only session is
         *     accepted only for purpose=login and for purpose=step_up with action=account_deletion. Both
         *     per BR-ID-01 细则, which wins on any difference.
         */
        post: operations["createOauthAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login/wechat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Log in (or register) with WeChat
         * @description Besides the fields every login carries, the body takes only `attempt_id` and the
         *     authorization `code`; any other field (union_id, open_id, nickname, avatar, phone…) is
         *     20001 and no account is created. The identity is what the server obtains with the code,
         *     which is valid once (BR-ID-04 细则). A code or attempt that is invalid, expired, used or does
         *     not match is 20004 (reasons are not told apart); the provider being unavailable, or its
         *     answer lacking the unionid, is 50305 with `data.provider`. A first login creates the account
         *     and checks the same-device registration limit (44001, BR-ID-05). Restricted login for clients
         *     below the minimum version (10405) is added by CT-17a.
         *     Version gate: not applied (session recovery). A client below the minimum version gets a
         *     restricted login: only an account already bound to this identity is logged in, none → 10405
         *     with data.reason=no_account, no account is created (BR-ID-01 细则「受限会话」). Session scopes:
         *     accepts deletion_only.
         */
        post: operations["loginByWechat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login/apple": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Log in (or register) with Sign in with Apple
         * @description Besides the fields every login carries, the body takes only `attempt_id`,
         *     `identity_token` and `authorization_code`; no client nonce. The identity is the one in the
         *     identity token the server obtains by exchanging the authorization code, verified for
         *     signature, iss, aud, exp and the attempt's nonce; the submitted identity_token is checked
         *     the same way and its subject must equal that one, otherwise 20004 (BR-ID-04 细则). Otherwise
         *     as WeChat login.
         *     Version gate: not applied (session recovery); restricted login below the minimum version as
         *     for WeChat login (10405 data.reason=no_account). Session scopes: accepts deletion_only.
         */
        post: operations["loginByApple"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login/huawei": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Log in (or register) with a Huawei account
         * @description Phase M-公开. Besides the fields every login carries, the body takes only `attempt_id` and
         *     `authorization_code`; otherwise as WeChat login (BR-ID-04 细则). Whether Huawei supports
         *     PKCE or returns the nonce is still to be checked (specs/oauth/huawei.md, CT-15i); no field
         *     for it is declared until then.
         *     Version gate: not applied (session recovery); restricted login below the minimum version as
         *     for WeChat login (10405 data.reason=no_account). Session scopes: accepts deletion_only.
         */
        post: operations["loginByHuawei"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/step-up": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Second verification for a sensitive operation
         * @description Returns a step_up_token bound to `action` (BR-ID-08); the client sends it as the
         *     X-Step-Up-Token header of the matching operation (04 §5 step-up row). Exactly one way:
         *     an SMS code (`action`, `code`; only for an account with a bound phone; 20002 wrong code,
         *     20003 expired), or a new third-party authorization (`action`, `provider`, `attempt_id` and
         *     the credential fields of that provider's login: WeChat `code`, Apple `identity_token` and
         *     `authorization_code`, Huawei `authorization_code`), which is open only to an account
         *     without a bound phone (a bound phone → 20001). The server checks the credential as at
         *     login and accepts only an attempt with purpose=step_up and the same user and action; an
         *     identity other than the one this account bound for that provider is 20004 with
         *     `data.reason=identity_mismatch`, an invalid credential or attempt is 20004, the provider
         *     being unavailable is 50305.
         *     Version gate (conditional): not applied when action=account_deletion; applied otherwise.
         *     Session scopes: a deletion_only session is accepted only for action=account_deletion. Both
         *     per BR-ID-01 细则, which wins on any difference.
         */
        post: operations["stepUp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate the token pair
         * @description Every refresh rotates the refresh token (BR-ID-07). Resubmitting a rotated token outside
         *     the 30-second grace revokes the whole session chain and returns 10404. Clients refresh
         *     single-flight: N concurrent 10002 trigger one refresh.
         *     Version gate: not applied (session recovery). The scope of the refreshed session is decided
         *     again from this request (X-Platform, X-Channel, X-App-Version), not inherited; the session
         *     chain (sid) is unchanged (BR-ID-01 细则「受限会话」). Session scopes: accepts deletion_only.
         */
        post: operations["refreshToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/h5-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Exchange the native session for an h5_token
         * @description The native app gets an h5_token (aud=h5) for its trusted H5 pages; lifetime and scope per
         *     BR-ID-32. A read_only token calling anything but GET is 10403 with
         *     data.reason=h5_read_only, decided by the server from the HTTP method. Version gate:
         *     applied (BR-ID-01 细则 interface table). Session scopes: not marked, so a deletion_only
         *     session gets 10405.
         */
        post: operations["issueH5Token"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/unions/bindings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Authorization state per platform
         * @description One item per platform. A platform with an unreleased binding gives that binding's status;
         *     otherwise released when a released binding exists, otherwise unbound. Pinduoduo reports
         *     the authorization of the self-purchase promotion slot. No released_at, cooldown_until,
         *     account name, nickname or avatar (BR-ID-17 细则「授权方式」「授权管理页」; how the page
         *     shows each status is in BR-ID-17 细则).
         */
        get: operations["listUnionBindings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/unions/{platform}/auth-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the authorization link of a platform
         * @description Returns auth_url, state and the ordered auth_methods (Taobao: configured per platform of
         *     the device record; the client uses the first one it can run, BR-ID-17 细则「授权方式」).
         *     For platform=pdd the response carries auth_jump instead of auth_methods (executed like a
         *     purchase jump plan, h5 steps in the system browser, no link_jump report). No self-service
         *     rebinding or unbinding. A blocked binding of a user who is not banned is 30153 and no
         *     auth_url is issued (BR-ID-17 细则「授权管理页」). While the site's own union authorization
         *     is unavailable the request gets the same code as a purchase would (30101 for unbound,
         *     pending_auth or released, 30102 for invalid) with data.reason=auth_unavailable and no
         *     auth_url; the client only shows the notice.
         */
        get: operations["getUnionAuthUrl"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/unions/{platform}/bindings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Bind after the user authorized
         * @description Taobao body: exactly one of {state, auth_method: web_code, code} and
         *     {state, auth_method: sdk_token, access_token, expires_in}; no nickname, avatar or account
         *     name, and any undefined field is 20001. The server checks first and consumes later: uid,
         *     device_id, the platform of the device record (X-Platform is only a claim) and the issued
         *     method must all match before the state is marked used; then the configured app exchanges
         *     or uses the credential. A method that was not issued, is closed or does not match the
         *     device is 30104 with data.reason=method_not_allowed (the state stays unused); an invalid
         *     credential, or one the upstream says is not for this app, is 30104 with
         *     data.reason=credential_invalid; an expired or used state is 30104 without reason. Every
         *     binding attempt (new state or new credential) uses a new Idempotency-Key; only a transport
         *     retry of the same request keeps it (BR-ID-17 细则「授权方式」). While the site's own union
         *     authorization is unavailable the request gets 30101 (unbound, pending_auth or released) or
         *     30102 (invalid) with data.reason=auth_unavailable and no auth_url (BR-ID-24 ④).
         */
        post: operations["bindUnion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/orders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My orders (self-purchase or shared)
         * @description Orders of the current account in the visible range, newest paid first. scope=self gives the
         *     full order_no (copyable); scope=share gives only masked_order_no, and an item whose bought
         *     product is not the shared one (is_other_product=true) has title and image_url null — both
         *     trimmed by the server. Shared orders exclude referral-commission orders. status_group
         *     groups display_status on the server; q matches a self-purchase order by its exact parent or
         *     child order number, otherwise titles; shared orders are matched by the visible title only.
         *     Grouping, search and projection rules are only in BR-TEXT-02 细则「订单列表的状态分组与查找」
         *     「订单的检索范围与分享单的投影」. earliest_visible_date is the first day in range
         *     (null when unlimited; BR-ID-30 细则「订单类记录」). For a pre-sale order in DEPOSIT_PAID,
         *     pay_amount_fen is the deposit paid, null when the platform does not report it
         *     (BR-TEXT-02 细则「预售单的付款金额」, wording pending CAP-*-07).
         */
        get: operations["listOrders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/orders/pending-tracks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Pending-track cards
         * @description One card per platform at most, chosen per open attempt (link_open_attempts): attempts with
         *     a jump report first, the latest open wins; jumped_at is that attempt's open time; whether a
         *     card shows, disappears or offers the claim entry is decided by the server (BR-ATTR-21 细则
         *     「待跟单卡按实际外跳选」「待跟单卡的完成与关闭按尝试」). dismissed tells whether the user
         *     closed this attempt's card.
         */
        get: operations["listPendingTracks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/orders/pending-tracks/{link_id}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close a pending-track card
         * @description Closes only the attempt named in the body (link_open_attempts.dismissed_at, written once);
         *     other attempts of the same link are untouched. Repeating the call is harmless (no
         *     Idempotency-Key). A missing attempt_id, or one that is not the current user's or not of
         *     the link in the path, is 20001 with data.fields=[attempt_id] and nothing is written
         *     (BR-ATTR-21 细则「待跟单卡的完成与关闭按尝试」). Version gate: applied.
         */
        post: operations["dismissPendingTrack"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/orders/{order_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Order detail
         * @description Same projection as the list (scope by order ownership): full order_no for my own purchase,
         *     masked_order_no for a shared order; is_other_product=true trims title, image_url and
         *     product_key. product_key is set only for my own purchase and a shared order with
         *     is_other_product=false. timeline lists the nodes of BR-TEXT-02 细则「时间线」 (a pre-sale
         *     order starts with deposit_paid); a node that has not happened has at null. reason and
         *     reason_action explain a missing rebate directly, without AI (拍板第二批 AI-09). An order
         *     outside the visible range, not the user's, or unknown is 30701 (BR-ID-30 细则).
         */
        get: operations["getOrder"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Current user
         * @description Nickname and default avatar, invite code, whether an inviter is bound (only yes / no),
         *     invite_backfill (whether the invite code can still be filled in, BR-INV-07), identity level (BR-ID-01), single-balance summary, union authorization states, real-name
         *     state, `need_reconsent` (BR-ID-12) and the risk state for the ban / freeze page. No
         *     user level (拍板第二批 OPS-20).
         *     Session scopes: accepts deletion_only (step-up method choice on the force-update and
         *     deletion pages, BR-ID-01 细则「受限会话」).
         */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/phone": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Bind or change the phone number
         * @description Binds a phone number to the account, or changes it. code is a purpose=bind SMS code sent to
         *     the new number. Order of checks (BR-ID-06): 44001 (number blacklisted) → 30411 (number
         *     belongs to another account of this app, including one in the deletion cooling period or
         *     processing). Accounts are never merged here; the one exception is a third-party account
         *     without phone that meets the BR-ID-06 merge conditions: 30411 then carries
         *     data.reason=mergeable and data.merge_ticket and the client asks before calling
         *     POST /v1/auth/merge (拍板第二批 OPS-04). Step-up applies to a change only: changing a bound
         *     number needs X-Step-Up-Token for action phone_change (an SMS to the old number,
         *     BR-ID-08); a first binding does not. With account.phone_change_enabled=false a change
         *     (not a first binding) is 30414. Wrong or expired code: 20002 / 20003 (BR-ID-05). An
         *     Idempotency-Key that was abandoned (POST /v1/idempotency-keys/abandon) is 20903 at the
         *     idempotency check, without comparing the body or running the business; a business write
         *     that finds the key abandoned is rolled back and also returns 20903 (04 §5「幂等」). The
         *     client fetches GET /v1/me again after success. Version gate: applied.
         */
        post: operations["bindPhone"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/payout-account": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My current payout account (masked)
         * @description Only payout_method, masked_account, bank_name (bank card only), masked_payee_name and
         *     change_remaining_this_month (changes left this natural month, BR-WDR-02 ④, never below 0);
         *     an empty object when nothing is bound. Never the ID number, the full logon id or card
         *     number, the card BIN or the full name; masking is done by the server (BR-ID-33 细则
         *     「收款账号的脱敏格式」).
         */
        get: operations["getPayoutAccount"];
        /**
         * Bind or change my payout account
         * @description Body by payout_method (withdraw.payout_methods decides which are open): alipay with the
         *     logon id and payee_name, bank_card with card number, bank name and payee_name. payee_name
         *     and the real name are both normalised before comparing; different → 30307 (BR-WDR-02 ①).
         *     A bank card must be a debit card of the user: 12–19 digits with Luhn, else 20001
         *     data.fields=[card_no]; three-element verification mismatch → 30307 (⑥). An Alipay logon id
         *     in phone form that does not normalise is 20001 with data.reason=phone_invalid (BR-WDR-02
         *     细则). Account held by another user → 30308; blacklisted → 44001. Changes per natural
         *     month over the limit → 30303 data.reason=payout_account_change_limit (④); the paid
         *     verification reserves the day's quota before calling the vendor and a full quota is 30303
         *     data.reason=payout_account_verify_limit without a vendor call (⑦). A verification of the
         *     same account still in flight or under recheck → 40901; vendor timeout → 50401 (the same
         *     account is first rechecked by the original request id on the next submit); a matching result
         *     within its validity is reused. Resubmitting with the same Idempotency-Key reuses that key's
         *     verification record (in flight or recheck 40901, match saves, mismatch the original 30307,
         *     still unknown at the deadline 50401) without a new verification or charge (BR-WDR-02 细则
         *     「核验次数上限」). Needs X-Step-Up-Token for action payout_account_change (BR-WDR-02 ③; also
         *     on the first binding). An abandoned Idempotency-Key is 20903 at the idempotency check,
         *     without comparing the body or running the business; a business write that finds it
         *     abandoned is rolled back with 20903 (04 §5「幂等」). Not realname → 30304; after a blocking
         *     precondition the request is not replayed, the user saves again on the payout-account page
         *     (BR-WDR-07 细则「前置步骤的回流」). Version gate: applied.
         */
        put: operations["savePayoutAccount"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/tips": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read states of the one-time tips
         * @description jump_tip is read per platform (a platform without a record is absent or null);
         *     inviter_before_buy is not per platform (BR-INV-03 细则). Fetched with /v1/config after
         *     login; after a login on another device a tip already read on the same platform is not
         *     shown again (BR-ATTR-21, AC-S1-17).
         */
        get: operations["getTips"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/tips/{tip_key}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark a tip as read
         * @description tip_key=jump_tip needs a body {platform}; without it → 20001 with data.fields=[platform].
         *     tip_key=inviter_before_buy sends no body. Repeating the call is harmless:
         *     an existing record keeps its read_at. Version gate: applied.
         */
        post: operations["markTipRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/tips/{tip_key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Show a tip again
         * @description Settings「重新显示下单须知」: clears the read records of jump_tip on every platform. Only
         *     tip_key=jump_tip is accepted (the path parameter allows only that value; another value is
         *     20001). Version gate: applied.
         */
        delete: operations["resetTip"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/deletion": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Progress of my account deletion
         * @description The latest deletion request of the account (deletion_requests; flow in BR-ID-27); data is
         *     null when there has never been one. can_cancel follows BR-ID-27: cooling and now before
         *     cooling_until. Session scopes: accepts deletion_only (BR-ID-01 细则「受限会话」).
         */
        get: operations["getDeletion"];
        put?: never;
        /**
         * Apply for account deletion
         * @description Needs X-Step-Up-Token for action account_deletion (BR-ID-08). The client shows balance and
         *     estimated earnings first and the user ticks the waiver (BR-ID-27, wording BR-TEXT-01). A
         *     withdrawal in PENDING_REVIEW, APPROVED or PAYING is 30412 (not for a withdrawal frozen by
         *     a ban, BR-ID-31); a negative balance is 30416 with data.amount_fen (拍板第二批 §8 ADD-07).
         *     Success starts the 7-day cooling period and returns the request. An abandoned
         *     Idempotency-Key is 20903 at the idempotency check, without comparing the body or running
         *     the business; a business write that finds it abandoned is rolled back with 20903
         *     (04 §5「幂等」). Version gate: not applied (申请注销, BR-ID-01 细则). Session scopes:
         *     accepts deletion_only.
         */
        post: operations["requestDeletion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/deletion/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Withdraw my account deletion
         * @description Allowed while now < apply_at + 7×24 hours, judged by time and not by whether the scheduled
         *     job has run; later → 10007 (BR-ID-27). Repeating a successful cancel returns the cancelled
         *     request. Version gate: not applied (撤销注销, BR-ID-01 细则). Session scopes: accepts
         *     deletion_only.
         */
        post: operations["cancelDeletion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/idempotency-keys/abandon": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Abandon the idempotency key of a sensitive operation whose result is unknown
         * @description Only for the pending state of the four x-step-up operations (04 §5 step-up row) after a
         *     send whose result is unknown; the user chose to give up instead of confirming (BR-ID-10
         *     细则「敏感操作的幂等键」). The server locates the idempotency record from the token's app_id
         *     and user, the method and path that `action` maps to (the x-step-up table in
         *     info.description) and `idempotency_key`:
         *     - no record for the key → writes an abandoned record, `outcome=abandoned`, `original=null`;
         *     - already abandoned → `outcome=abandoned` again (repeated calls give the same result);
         *     - a completed record → `outcome=completed` and `original` = the stored response envelope
         *       `{code, msg, data}` unchanged (success or a 3xxxx business error); nothing is abandoned;
         *     - the original request is still processing → 40901 (the client stays pending).
         *     Afterwards a request with that key returns 20903. `action` or a key outside the formats →
         *     20001 (`data.fields`). Takes no Idempotency-Key header and needs no step-up. Allowed for
         *     frozen and deleting accounts (inside the 10006 and 10007 whitelists, BR-ID-31,
         *     BR-ID-27); passing them checks login, signature and subject only and grants no right to
         *     run the original operation. Single writer: platform. x-min-version-gate and
         *     x-session-scopes are added by CT-17a.
         *     Version gate (conditional): not applied when action=account_deletion (abandoning an unknown
         *     deletion request); applied otherwise. Session scopes: a deletion_only session is accepted
         *     only for action=account_deletion. Both per BR-ID-01 细则, which wins on any difference.
         */
        post: operations["abandonIdempotencyKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Client configuration
         * @description Configuration, client switches, texts and the derived per-platform purchase status
         *     (04 §10.1, excerpt). Clients keep the last good response (LKG) and fall back to it and
         *     then to the bundled default when the request fails (03 §4.3). Keys whose inner shape is
         *     not fixed by 04 yet are free-form objects and get typed by the task that consumes them.
         *     x-auth is optional (04 §6.2): h5_release buckets by user_id when logged in (拍板第二批
         *     TECH-28) and agent availability depends on the whitelist user (BR-AI-12).
         *     Session scopes: accepts deletion_only (BR-ID-01 细则「受限会话」).
         */
        get: operations["getConfig"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/products/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search one platform
         * @description Keyword search on one platform (04 §6.3). Coupon-price and rebate sorting reorder only
         *     the current page (拍板第二批 TRADE-20). The cursor is opaque and carries only the search
         *     session and page (BR-PROD-08); no_rebate items are filtered out (BR-PRICE-08). With no
         *     result the response carries `fallback_items` (the platform's first 10 feed items). Union
         *     failure without a usable cache returns 50304 with `data.platform` (BR-PROD-07); the
         *     product pool is never served as search results. Cards only register a link_id with its
         *     quote snapshot and are not converted (BR-PRICE-12): buying goes through
         *     `POST /v1/links/{link_id}/open`. `x-auth` is optional although 04 §6.3 lists none:
         *     rebate amounts are computed for the current user and links are registered per user
         *     (BR-PRICE-11, BR-PRICE-12; 08 wins over 04).
         *     When the search switch search.enabled.<platform> is off the answer is 50304 with
         *     data.reason=search_disabled (BR-PROD-10 细则「按平台的搜索开关」).
         */
        get: operations["searchProducts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/products/{product_key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Product detail
         * @description Coupon, final price, estimated rebate and quote time of one product (BR-PRICE-05,
         *     BR-PRICE-11), with a freshly registered `link_id` (BR-PRICE-12). On union failure the
         *     server may answer with the product-pool price and `stale=true` (拍板第二批 TRADE-12).
         *     A response whose derived key differs from the requested one, or cannot be derived, is
         *     30143 ref_expired (BR-PROD-03, BR-PROD-05). `item_ref` of the card the user tapped is
         *     passed through unchanged (BR-PROD-11). x-auth optional for the same reason as search.
         */
        get: operations["getProduct"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inputs/parse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Recognise pasted links, tokens or share text
         * @description Shared by clipboard, search box, share extension and Agent (04 §8.5). At most 3 links or
         *     tokens of one text are handled, one card each; the same product key yields one card
         *     (BR-PROD-08 ⑤). Cards only register a link_id with the quote snapshot and are never
         *     converted here (拍板第二批 TRADE-03); a pasted link without rebate still yields a card
         *     with `rebate_basis=no_rebate` (BR-PRICE-08). Nothing recognisable as a concrete product
         *     returns 30132 without candidate cards (拍板第二批 TRADE-07); a recognised product
         *     whose key cannot be derived returns 30131 (BR-PROD-03). How a platform turns a link or
         *     token into a product is the union adapter's business and is not visible here. x-auth is
         *     optional although 04 §6.3 lists none, for the same reason as search.
         */
        post: operations["parseInput"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/links/{link_id}/open": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Buy — re-check the price and convert
         * @description The only entry for a purchase tap (拍板第二批 TRADE-03): converts in real time with the
         *     identity fixed in the link snapshot and re-checks the price before the jump
         *     (BR-PRICE-13; ownership rules BR-ATTR-05). `price_changed=true` means the client asks
         *     the user before jumping; whenever the new price differs, `new_link_id` replaces the card
         *     (BR-PRICE-12). Re-check failure with a cached link of this user ≤ 900 s jumps with
         *     `requote_failed=true`; without cache, 50303. Share links open anonymously; other links
         *     need login (10001). amount_unknown cards are converted without price re-check
         *     (BR-PRICE-08). The client waits at most 8 s and retries with the same Idempotency-Key
         *     (拍板第二批 TRADE-22). Every call writes a link_log `open` row (BR-ATTR-14). When the
         *     rebate drops from > 0 to 0 (new_rebate_max_fen = 0) the client also asks before jumping,
         *     even with price_changed=false (BR-PRICE-13).
         *     A request stopped by 30101, 30102 or 30111 and sent again after the user authorized is a
         *     new request with a new Idempotency-Key; the original key is only for retrying the same
         *     request (BR-ID-10 细则). 30101 / 30102 carry auth_url, state and auth_methods; 30111
         *     carries auth_jump.
         */
        post: operations["openLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/links/convert": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register and convert in one call (entries without a link_id)
         * @description Only for entries that have no link_id, such as the H5 bridge method
         *     `trade.convertAndOpen` (scene=h5): registers the link and then
         *     re-checks and converts exactly like open, returning `link_id` plus the open result
         *     (拍板第二批 TRADE-03). Pass `product_key` with the tapped card's `item_ref` (a missing
         *     item_ref is not an error, BR-PROD-11), or `url`. A url whose product key cannot be
         *     derived is 30131 and nothing is registered (BR-PROD-03). A missing or invalid `scene`
         *     is 20001 (BR-ATTR-08). Writes a link_log `convert` row (BR-ATTR-14).
         *     A request stopped by 30101, 30102 or 30111 and sent again after the user authorized is a
         *     new request with a new Idempotency-Key; the original key is only for retrying the same
         *     request (BR-ID-10 细则). 30101 / 30102 carry auth_url, state and auth_methods; 30111
         *     carries auth_jump.
         */
        post: operations["convertLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * @description Process entry that produced the response (ADR-0001 §2).
         * @enum {string}
         */
        EntryName: "api" | "stream" | "admin" | "worker" | "payout";
        HealthzData: {
            /** @enum {string} */
            status: "ok";
            entry: components["schemas"]["EntryName"];
            /**
             * Format: date-time
             * @description Current instant of the process clock (follows CLOCK_NOW outside prod).
             */
            now: string;
        };
        /** @description Response envelope of 规划/04 §5 carrying the health payload. */
        HealthzResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["HealthzData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * Format: int32
         * @description 0 means success.
         * @enum {integer}
         */
        SuccessCode: 0;
        /** @description Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID. */
        TraceId: string;
        /** @description Entity id, a UUIDv7 string (04 §5). */
        Id: string;
        /** @description `<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02). */
        ProductKey: string;
        /** @description Server-signed opaque product reference; passed through unchanged (BR-PROD-11). */
        ItemRef: string;
        /**
         * Format: int64
         * @description Amount in fen (ADR-0001 §4.2 item 3).
         */
        Fen: number;
        /**
         * Format: int64
         * @description Amount in fen, null when unknown.
         */
        NullableFen: number | null;
        /**
         * @description Platform (contracts/enums/platform.yaml platform).
         * @enum {string}
         */
        PlatformCode: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
        /**
         * @description Client platform (contracts/enums/platform.yaml client_platform).
         * @enum {string}
         */
        ClientPlatformCode: "ios" | "android" | "harmony" | "h5" | "admin";
        /**
         * @description Install channel (contracts/enums/platform.yaml install_channel).
         * @enum {string}
         */
        InstallChannelCode: "appstore" | "official" | "huawei" | "agc";
        /**
         * @description Search sort (contracts/enums/trade.yaml sort).
         * @enum {string}
         */
        SortCode: "relevance" | "sales_desc" | "final_price_asc" | "rebate_desc";
        /**
         * @description Why a card or an open result has no rebate (enum no_rebate_cause).
         * @enum {string}
         */
        NoRebateCause: "price_compare";
        /**
         * @description contracts/enums/trade.yaml rebate_basis. The three 查返利 states are derived from
         *     coupon_fen and rebate_basis only (BR-PRICE-21); amount_unknown and login_required are
         *     outside them.
         * @enum {string}
         */
        RebateBasis: "normal" | "price_compare_risk" | "no_rebate" | "amount_unknown" | "login_required";
        /**
         * @description contracts/enums/trade.yaml availability.
         * @enum {string}
         */
        Availability: "ok" | "off_shelf" | "coupon_gone" | "ref_expired" | "price_unavailable" | "unknown";
        /**
         * @description Whether the platform app is installed, as detected by the client (BR-ATTR-27 ①); the
         *     strings "true" / "false" / "unknown" (enum installed_state).
         * @enum {string}
         */
        InstalledState: "true" | "false" | "unknown";
        JumpStep: {
            /**
             * @description contracts/enums/trade.yaml jump_type.
             * @enum {string}
             */
            type: "sdk" | "scheme" | "universal_link" | "h5" | "copy_tpwd";
            /** @description URL, scheme or token to execute; produced by the server only. */
            value: string;
        };
        /**
         * @description Executed strictly in order; clients never build schemes or add fallbacks themselves
         *     (BR-ATTR-27, 03 §4.5). The client jumps only after a user tap (BR-ATTR-21).
         */
        JumpPlan: {
            primary: components["schemas"]["JumpStep"];
            fallbacks: components["schemas"]["JumpStep"][];
            /**
             * Format: date-time
             * @description Until when the returned union URL can be used directly (BR-ATTR-05); it does not
             *     limit opening the link_id again.
             */
            expire_at: string;
        };
        /** @description Value of the Idempotency-Key header (04 §5「幂等」). */
        IdempotencyKey: string;
        /**
         * @description scp of an access token (enum session_scope; meaning in BR-ID-01 细则「受限会话」).
         * @enum {string}
         */
        SessionScope: "full" | "deletion_only";
        /**
         * @description Scope of an h5_token (enum h5_token_scope; BR-ID-32 细则「只读作用域」).
         * @enum {string}
         */
        H5TokenScope: "standard" | "read_only";
        IssueH5TokenRequest: {
            /**
             * @description Filled by the native app from its force-update state; H5 cannot choose it. The value
             *     used when it is absent is set in BR-ID-32 细则「只读作用域」.
             */
            scope?: components["schemas"]["H5TokenScope"];
        };
        H5TokenData: {
            token: string;
            /** Format: date-time */
            expire_at: string;
            scope: components["schemas"]["H5TokenScope"];
        };
        H5TokenResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["H5TokenData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).
         * @enum {string}
         */
        StepUpAction: "withdraw" | "payout_account_change" | "phone_change" | "account_deletion";
        /**
         * @description Result of POST /v1/idempotency-keys/abandon (04 §6.1).
         * @enum {string}
         */
        IdempotencyAbandonOutcome: "abandoned" | "completed";
        AbandonIdempotencyKeyRequest: {
            action: components["schemas"]["StepUpAction"];
            idempotency_key: components["schemas"]["IdempotencyKey"];
        };
        /**
         * @description `original` is null exactly when `outcome=abandoned`. The oneOf branches declare the
         *     properties they constrain (strict Ajv2020, ADR-0001 §4.2 #15).
         */
        AbandonIdempotencyKeyData: {
            outcome: components["schemas"]["IdempotencyAbandonOutcome"];
            /**
             * @description The response envelope stored with the completed idempotency record, unchanged
             *     (`code` 0 or a 3xxxx business code; 1xxxx and 2xxxx results are never stored,
             *     BR-WDR-07). `data` keeps the shape of the original operation, so it is left open.
             */
            original: {
                /** Format: int32 */
                code: number | 0;
                msg: string;
                data?: {
                    [key: string]: unknown;
                };
            } | null;
        } & ({
            /** @enum {string} */
            outcome: "abandoned";
            original: null;
        } | {
            /** @enum {string} */
            outcome: "completed";
            original: {
                [key: string]: unknown;
            };
        });
        AbandonIdempotencyKeyResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["AbandonIdempotencyKeyData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Error response (04 §5, §7). `data` is present only for codes that define it; its fields
         *     per code are listed in contracts/error-codes.yaml, so it is left open here.
         */
        ErrorEnvelope: {
            /** Format: int32 */
            code: number;
            /** @description Fallback text only; clients show the dictionary text error.<code>. */
            msg: string;
            data?: {
                [key: string]: unknown;
            };
            trace_id: components["schemas"]["TraceId"];
        };
        /** @description Configuration block whose inner shape is not fixed by 规划/04 yet. */
        FreeForm: {
            [key: string]: unknown;
        };
        /**
         * @description Which device identifier was hashed (enum device_id_source, BR-ID-09).
         * @enum {string}
         */
        DeviceIdSource: "idfv" | "android_id" | "oaid" | "odid";
        RegisterDeviceRequest: {
            /**
             * @description lowercase_hex(SHA-256(UTF-8 bytes of the identifier, trimmed and lower-cased)) of IDFV
             *     (iOS), ANDROID_ID (Android, MVP) or ODID (Harmony) (BR-ID-09 细则「设备标识的无效值」).
             */
            device_hash: string;
            id_source: components["schemas"]["DeviceIdSource"];
        };
        RegisterDeviceData: {
            device_id: components["schemas"]["Id"];
            /** @description Signing secret, stored only in Keychain / Keystore / HUKS. */
            install_secret: string;
        };
        RegisterDeviceResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["RegisterDeviceData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The
         *     server normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile
         *     number is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty
         *     string included). No length bound in the schema: any spacing of a valid number must reach
         *     the normaliser, and adding a bound to a request property is a breaking change (oasdiff).
         */
        Phone: string;
        SendSmsCodeRequest: {
            phone: components["schemas"]["Phone"];
            /**
             * @description contracts/enums/identity.yaml sms_purpose.
             * @enum {string}
             */
            purpose: "login" | "bind" | "step_up";
            /** @description Human-verification token, required after 44003 (BR-ID-05). */
            captcha_token?: string;
            /**
             * @description With purpose=step_up the client always sends the action the code is for; the version
             *     gate and the session scope are decided from it (BR-ID-01 细则): only
             *     action=account_deletion is exempt, and a step_up request without action is gated.
             *     purpose=login is exempt regardless of action; purpose=bind is gated.
             */
            action?: components["schemas"]["StepUpAction"];
        };
        SendSmsCodeData: {
            /**
             * Format: int32
             * @description Seconds until another code may be requested (60, BR-ID-05).
             */
            resend_after_sec: number;
            /**
             * Format: int32
             * @description Validity of the code in seconds (300, BR-ID-05).
             */
            expires_in_sec: number;
        };
        SendSmsCodeResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["SendSmsCodeData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /** @description Versions of the privacy policy and user agreement the user agreed to (BR-ID-04). */
        LegalVersions: {
            /** Format: int32 */
            privacy: number;
            /** Format: int32 */
            agreement: number;
        };
        LoginBySmsRequest: {
            phone: components["schemas"]["Phone"];
            code: string;
            legal_versions: components["schemas"]["LegalVersions"];
            /**
             * Format: date-time
             * @description When the box was ticked or the confirm dialog accepted (client clock).
             */
            consent_at: string;
            /** @description Optional invite code; ignored for an existing account (BR-INV-06). */
            invite_code?: string;
        };
        /**
         * @description Third-party identity provider (enum login_provider, BR-ID-04).
         * @enum {string}
         */
        LoginProvider: "wechat" | "apple" | "huawei";
        /**
         * @description What a third-party authorization attempt is for (enum oauth_attempt_purpose).
         * @enum {string}
         */
        OauthAttemptPurpose: "login" | "step_up";
        /**
         * @description `action` is required exactly for purpose=step_up. The oneOf branches declare the
         *     properties they constrain (strict Ajv2020, ADR-0001 §4.2 #15).
         */
        CreateOauthAttemptRequest: {
            provider: components["schemas"]["LoginProvider"];
            purpose: components["schemas"]["OauthAttemptPurpose"];
            action?: components["schemas"]["StepUpAction"];
        } & ({
            /** @enum {string} */
            purpose: "login";
        } | {
            /** @enum {string} */
            purpose: "step_up";
            action: components["schemas"]["StepUpAction"];
        });
        OauthAttemptData: {
            attempt_id: components["schemas"]["Id"];
            /** @description At least 128 random bits, passed to the provider SDK (BR-ID-04 细则). */
            nonce: string;
            /** Format: date-time */
            expire_at: string;
        };
        OauthAttemptResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["OauthAttemptData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /** @description An authorization credential from the provider SDK; never stored or logged. */
        OauthCredential: string;
        LoginByWechatRequest: {
            attempt_id: components["schemas"]["Id"];
            code: components["schemas"]["OauthCredential"];
            legal_versions: components["schemas"]["LegalVersions"];
            /** Format: date-time */
            consent_at: string;
        };
        LoginByAppleRequest: {
            attempt_id: components["schemas"]["Id"];
            identity_token: components["schemas"]["OauthCredential"];
            authorization_code: components["schemas"]["OauthCredential"];
            legal_versions: components["schemas"]["LegalVersions"];
            /** Format: date-time */
            consent_at: string;
        };
        LoginByHuaweiRequest: {
            attempt_id: components["schemas"]["Id"];
            authorization_code: components["schemas"]["OauthCredential"];
            legal_versions: components["schemas"]["LegalVersions"];
            /** Format: date-time */
            consent_at: string;
        };
        StepUpBySmsRequest: {
            action: components["schemas"]["StepUpAction"];
            code: string;
        };
        StepUpByWechatRequest: {
            action: components["schemas"]["StepUpAction"];
            /** @enum {string} */
            provider: "wechat";
            attempt_id: components["schemas"]["Id"];
            code: components["schemas"]["OauthCredential"];
        };
        StepUpByAppleRequest: {
            action: components["schemas"]["StepUpAction"];
            /** @enum {string} */
            provider: "apple";
            attempt_id: components["schemas"]["Id"];
            identity_token: components["schemas"]["OauthCredential"];
            authorization_code: components["schemas"]["OauthCredential"];
        };
        StepUpByHuaweiRequest: {
            action: components["schemas"]["StepUpAction"];
            /** @enum {string} */
            provider: "huawei";
            attempt_id: components["schemas"]["Id"];
            authorization_code: components["schemas"]["OauthCredential"];
        };
        /**
         * @description Exactly one way of second verification: an SMS code, or a new authorization with one
         *     provider carrying that provider's login credential fields (BR-ID-08). Each branch is a
         *     closed object, so a body mixing two ways matches none.
         */
        StepUpRequest: components["schemas"]["StepUpBySmsRequest"] | components["schemas"]["StepUpByWechatRequest"] | components["schemas"]["StepUpByAppleRequest"] | components["schemas"]["StepUpByHuaweiRequest"];
        StepUpData: {
            step_up_token: string;
            /** Format: date-time */
            expire_at: string;
        };
        StepUpResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["StepUpData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Token pair of a login or a refresh. session_scope is the scp of the access token, decided
         *     from this request (BR-ID-01 细则「受限会话」): deletion_only when the client is below the
         *     minimum supported version.
         */
        TokenPair: {
            session_scope: components["schemas"]["SessionScope"];
            access_token: string;
            /** Format: date-time */
            access_expires_at: string;
            refresh_token: string;
            /** Format: date-time */
            refresh_expires_at: string;
        };
        /** @description Result of binding the invite code sent at registration (BR-INV-06). */
        InviteBind: {
            /** @enum {string} */
            result: "bound" | "failed" | "ignored_existing_user";
            /**
             * Format: int32
             * @description Error code when result=failed (50001 = internal binding error).
             * @enum {integer|null}
             */
            code: 30401 | 30403 | 30408 | 42901 | 50001 | null;
        };
        LoginData: {
            user_id: components["schemas"]["Id"];
            is_new_user: boolean;
            tokens: components["schemas"]["TokenPair"];
            invite_bind?: components["schemas"]["InviteBind"];
        };
        LoginResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["LoginData"];
            trace_id: components["schemas"]["TraceId"];
        };
        RefreshTokenRequest: {
            refresh_token: string;
        };
        TokenPairResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["TokenPair"];
            trace_id: components["schemas"]["TraceId"];
        };
        /** @description Summary of the single balance (拍板第二批 §8 ADD-06); meanings per BR-FUND-18. */
        MeBalance: {
            available_fen: components["schemas"]["Fen"];
            withdrawable_fen: components["schemas"]["Fen"];
            estimated_total_fen: components["schemas"]["Fen"];
        };
        UnionBindingState: {
            platform: components["schemas"]["PlatformCode"];
            /**
             * @description contracts/enums/identity.yaml union_binding_status.
             * @enum {string}
             */
            status: "unbound" | "pending_auth" | "active" | "invalid" | "released" | "blocked";
        };
        /**
         * @description Taobao authorization method (enum auth_method; BR-ID-17 细则「授权方式」).
         * @enum {string}
         */
        AuthMethod: "web_code" | "sdk_token";
        AuthJumpStep: {
            /**
             * @description A subset of jump_type; an h5 step opens in the system browser, not in the app.
             * @enum {string}
             */
            type: "scheme" | "universal_link" | "h5";
            value: string;
        };
        /**
         * @description Authorization jump of 30111 and of the Pinduoduo auth-url (04 §7 30111): primary and
         *     fallbacks chosen by the server from the device record and installed (BR-ID-22 细则,
         *     BR-ATTR-27); executed in order by the same executor as a purchase jump plan, but not
         *     reported as link_jump and not a purchase jump (BR-ATTR-21).
         */
        AuthJumpPlan: {
            primary: components["schemas"]["AuthJumpStep"];
            fallbacks: components["schemas"]["AuthJumpStep"][];
            /** Format: date-time */
            expire_at: string;
        };
        UnionBindingsData: {
            items: components["schemas"]["UnionBindingState"][];
        };
        UnionBindingsResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["UnionBindingsData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Exactly one of auth_methods (Taobao, ordered) and auth_jump (Pinduoduo); the oneOf branches
         *     declare the property they require (strict Ajv2020).
         */
        UnionAuthUrlData: {
            /** Format: uri */
            auth_url: string;
            state: string;
            auth_methods?: components["schemas"]["AuthMethod"][];
            auth_jump?: components["schemas"]["AuthJumpPlan"];
        } & ({
            auth_methods: unknown[];
        } | {
            auth_jump: {
                [key: string]: unknown;
            };
        });
        UnionAuthUrlResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["UnionAuthUrlData"];
            trace_id: components["schemas"]["TraceId"];
        };
        BindUnionByWebCode: {
            state: string;
            /** @enum {string} */
            auth_method: "web_code";
            code: string;
        };
        BindUnionBySdkToken: {
            state: string;
            /** @enum {string} */
            auth_method: "sdk_token";
            access_token: string;
            /**
             * Format: int64
             * @description Lifetime of the access token in seconds, as the SDK returned it.
             */
            expires_in: number;
        };
        /**
         * @description Exactly one authorization method (BR-ID-17 细则「授权方式」); each branch is closed, so
         *     undefined fields are 20001.
         */
        BindUnionRequest: components["schemas"]["BindUnionByWebCode"] | components["schemas"]["BindUnionBySdkToken"];
        UnionBindingResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["UnionBindingState"];
            trace_id: components["schemas"]["TraceId"];
        };
        /** @enum {string} */
        OrderScope: "self" | "share";
        /**
         * @description Status group of the order list (enum order_status_group; members in BR-TEXT-02 细则).
         * @enum {string}
         */
        OrderStatusGroup: "all" | "estimating" | "credited" | "no_rebate";
        /**
         * @description User-visible order status (enum display_status; BR-FUND-17); unknown codes map to UNKNOWN.
         * @enum {string}
         */
        OrderDisplayStatus: "PAID" | "DEPOSIT_PAID" | "WAITING" | "CREDITING" | "REVIEWING" | "RIGHTS_PENDING" | "CREDITED" | "CREDITED_PART_CLAWED" | "NO_REBATE" | "INVALID" | "CLAWED_BACK";
        /**
         * @description Order reason code (enum order_reason); texts and actions come from /v1/dict.
         * @enum {string}
         */
        OrderReasonCode: "REFUND" | "RIGHTS" | "PUNISH" | "PRESALE_UNPAID" | "COMMISSION_ZERO" | "OTHER" | "BLACKLIST" | "PART_REFUND" | "PRICE_COMPARE" | "PRICE_PROTECT" | "SETTLE_DIFF" | "NOT_TRACKED" | "EXPIRED_CLICK" | "OTHER_TLJ" | "RELATION_INVALID" | "CANCELLED";
        /**
         * @description Timeline node of the order detail (enum order_timeline_node; BR-TEXT-02 细则「时间线」):
         *     a pre-sale order starts with deposit_paid and has final_paid instead of paid; invalid /
         *     clawed_back / part_clawed_back only when the order reached that state.
         * @enum {string}
         */
        OrderTimelineNode: "deposit_paid" | "paid" | "final_paid" | "received" | "credit_expected" | "credited" | "invalid" | "clawed_back" | "part_clawed_back";
        /**
         * @description One row of GET /v1/orders. Exactly one of order_no (my own purchase) and masked_order_no (a
         *     shared order); the oneOf branches declare the property they require (strict Ajv2020). A
         *     shared order with is_other_product=true has title and image_url null and never the full
         *     order_no (BR-TEXT-02 细则
         *     「订单的检索范围与分享单的投影」). OrderDetail repeats these fields (kept as two closed
         *     objects; redocly's example check closes every allOf member, so no shared allOf base).
         */
        OrderSummary: {
            order_id: components["schemas"]["Id"];
            platform: components["schemas"]["PlatformCode"];
            title: string | null;
            /** Format: uri */
            image_url: string | null;
            pay_amount_fen: components["schemas"]["NullableFen"];
            /** Format: int32 */
            quantity: number;
            /** @description Full platform order number (self-purchase only, copyable). */
            order_no?: string;
            /** @description Masked by the server (BR-TEXT-02 细则「订单号的显示」); shared orders never carry the full number. */
            masked_order_no?: string;
            display_status: components["schemas"]["OrderDisplayStatus"];
            reason: components["schemas"]["OrderReasonCode"] | null;
            est_rebate_fen: components["schemas"]["NullableFen"];
            /**
             * Format: date-time
             * @description Payment time (the final payment of a pre-sale order); null for a pre-sale order still in
             *     DEPOSIT_PAID (BR-ATTR-25 keeps paid_at for the final payment).
             */
            paid_at: string | null;
            /** @description A shared order whose bought product is not the shared one. */
            is_other_product: boolean;
        } & ({
            order_no: string;
        } | {
            masked_order_no: string;
        });
        OrderListData: {
            items: components["schemas"]["OrderSummary"][];
            next_cursor: string | null;
            /** Format: date */
            earliest_visible_date: string | null;
        };
        OrderListResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["OrderListData"];
            trace_id: components["schemas"]["TraceId"];
        };
        OrderTimelineItem: {
            node: components["schemas"]["OrderTimelineNode"];
            /**
             * Format: date-time
             * @description When it happened; null when it has not (shown greyed) or the platform gives no time.
             */
            at: string | null;
            /** @description Expected settlement month (YYYY-MM), only on credit_expected; null otherwise. */
            period: string | null;
        };
        /**
         * @description The list row fields (same as OrderSummary) plus the detail fields of 04 §6.4. product_key
         *     is null when is_other_product=true; with is_other_product=true title and image_url are
         *     null too.
         */
        OrderDetail: {
            order_id: components["schemas"]["Id"];
            platform: components["schemas"]["PlatformCode"];
            title: string | null;
            /** Format: uri */
            image_url: string | null;
            pay_amount_fen: components["schemas"]["NullableFen"];
            /** Format: int32 */
            quantity: number;
            /** @description Full platform order number (self-purchase only, copyable). */
            order_no?: string;
            /** @description Masked by the server (BR-TEXT-02 细则「订单号的显示」); shared orders never carry the full number. */
            masked_order_no?: string;
            display_status: components["schemas"]["OrderDisplayStatus"];
            reason: components["schemas"]["OrderReasonCode"] | null;
            est_rebate_fen: components["schemas"]["NullableFen"];
            /**
             * Format: date-time
             * @description Payment time (the final payment of a pre-sale order); null for a pre-sale order still in
             *     DEPOSIT_PAID (BR-ATTR-25 keeps paid_at for the final payment).
             */
            paid_at: string | null;
            /** @description A shared order whose bought product is not the shared one. */
            is_other_product: boolean;
            product_key: components["schemas"]["ProductKey"] | null;
            /** @description Action codes of the reason (the order_reason dictionary's action[], BR-TEXT-05). */
            reason_action: string[];
            timeline: components["schemas"]["OrderTimelineItem"][];
            expected_credit_period: string | null;
            credit_overdue: boolean;
            actual_fen: components["schemas"]["NullableFen"];
            clawback_fen: components["schemas"]["NullableFen"];
            appeal_pending: boolean;
            is_price_compare: boolean | null;
        } & ({
            order_no: string;
        } | {
            masked_order_no: string;
        });
        OrderDetailResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["OrderDetail"];
            trace_id: components["schemas"]["TraceId"];
        };
        PendingTrack: {
            link_id: components["schemas"]["Id"];
            attempt_id: string;
            platform: components["schemas"]["PlatformCode"];
            /** Format: date-time */
            jumped_at: string;
            show_claim_entry: boolean;
            dismissed: boolean;
        };
        PendingTracksData: {
            items: components["schemas"]["PendingTrack"][];
        };
        PendingTracksResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["PendingTracksData"];
            trace_id: components["schemas"]["TraceId"];
        };
        DismissPendingTrackRequest: {
            attempt_id: string;
        };
        ReportPushTokenRequest: {
            /** @description Push provider; a string until the provider is chosen (D-14). */
            provider: string;
            token: string;
        };
        BindPhoneRequest: {
            phone: components["schemas"]["Phone"];
            /** @description purpose=bind SMS code sent to the new number. */
            code: string;
        };
        /**
         * @description One-time tip (enum tip_key; BR-ATTR-21, BR-INV-03 细则).
         * @enum {string}
         */
        TipKey: "jump_tip" | "inviter_before_buy";
        /**
         * @description The tip that settings can show again (subset of tip_key).
         * @enum {string}
         */
        ResettableTipKey: "jump_tip";
        /** @description Body of tip_key=jump_tip; tip_key=inviter_before_buy sends no body. */
        MarkTipReadRequest: {
            platform: components["schemas"]["PlatformCode"];
        };
        /** Format: date-time */
        TipReadAt: string | null;
        TipsData: {
            /** @description read_at per platform; a platform never read is absent or null. */
            jump_tip: {
                [key: string]: components["schemas"]["TipReadAt"];
            };
            inviter_before_buy: components["schemas"]["TipReadAt"];
        };
        TipsResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["TipsData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description contracts/enums/identity.yaml deletion_status (BR-ID-27).
         * @enum {string}
         */
        DeletionStatus: "cooling" | "processing" | "done" | "cancelled";
        /**
         * @description contracts/enums/identity.yaml deletion_cancel_reason (04 §3.2 deletion_requests).
         * @enum {string}
         */
        DeletionCancelReason: "user" | "negative_balance";
        Deletion: {
            status: components["schemas"]["DeletionStatus"];
            /** Format: date-time */
            apply_at: string;
            /** Format: date-time */
            cooling_until: string;
            /** @description status=cooling and now before cooling_until (BR-ID-27). */
            can_cancel: boolean;
            /** Format: date-time */
            cancelled_at: string | null;
            cancel_reason: components["schemas"]["DeletionCancelReason"] | null;
            /** Format: date-time */
            processed_at: string | null;
        };
        DeletionResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["Deletion"] | null;
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Whether the invite code can still be filled in and until when (computed by the server per
         *     BR-INV-07, also for an account without phone; BR-INV-03 细则).
         */
        InviteBackfill: {
            eligible: boolean;
            /** Format: date-time */
            deadline_at: string | null;
        };
        /**
         * @description contracts/enums/fund.yaml payout_method (BR-WDR-02).
         * @enum {string}
         */
        PayoutMethod: "alipay" | "bank_card";
        PayoutAccount: {
            payout_method: components["schemas"]["PayoutMethod"];
            /** @description Masked by the server (BR-ID-33 细则「收款账号的脱敏格式」). */
            masked_account: string;
            /** @description Bank card only (from the card BIN); null for Alipay. */
            bank_name: string | null;
            masked_payee_name: string;
            /** Format: int32 */
            change_remaining_this_month: number;
        };
        PayoutAccountResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            /** @description The account, or an empty object when nothing is bound. */
            data: components["schemas"]["PayoutAccount"] | components["schemas"]["EmptyData"];
            trace_id: components["schemas"]["TraceId"];
        };
        SavePayoutAccountByAlipay: {
            /** @enum {string} */
            payout_method: "alipay";
            /** @description Alipay logon id (phone or e-mail form), normalised by the server (BR-WDR-02 细则). */
            alipay_logon_id: string;
            payee_name: string;
        };
        SavePayoutAccountByBankCard: {
            /** @enum {string} */
            payout_method: "bank_card";
            /** @description Card number; spaces are not allowed (12–19 digits and Luhn are checked by the server, 20001). */
            card_no: string;
            /** @description Opening bank as chosen by the user (04 §6.1). */
            bank_name: string;
            /** @description Account holder name (BR-WDR-02 ①). */
            payee_name: string;
        };
        SavePayoutAccountRequest: components["schemas"]["SavePayoutAccountByAlipay"] | components["schemas"]["SavePayoutAccountByBankCard"];
        EmptyData: Record<string, never>;
        EmptyResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["EmptyData"];
            trace_id: components["schemas"]["TraceId"];
        };
        /** @description Risk state for the ban / freeze explanation page (BR-ID-31, 拍板第二批 OPS-12). */
        RiskInfo: {
            /**
             * @description contracts/enums/identity.yaml risk_state.
             * @enum {string}
             */
            state: "normal" | "frozen" | "appealing" | "banned";
            /** @description User-visible reason category (BR-ID-31); null when state=normal. */
            reason_category: string | null;
            /** Format: date-time */
            frozen_until: string | null;
        };
        Me: {
            user_id: components["schemas"]["Id"];
            nickname: string;
            /** Format: uri */
            avatar_url: string;
            /** @description Null when the user cannot invite. */
            invite_code: string | null;
            /** @description Only whether an inviter is bound, never who. */
            inviter_bound: boolean;
            invite_backfill: components["schemas"]["InviteBackfill"];
            /**
             * @description contracts/enums/identity.yaml identity_level (BR-ID-01).
             * @enum {string}
             */
            identity_level: "basic" | "guest" | "member" | "phone" | "realname";
            /** @description Whether a phone number is bound (BR-ID-01). */
            phone_bound: boolean;
            balance: components["schemas"]["MeBalance"];
            union_bindings: components["schemas"]["UnionBindingState"][];
            /**
             * @description contracts/enums/identity.yaml realname_status.
             * @enum {string}
             */
            realname_status: "none" | "verified" | "failed";
            /** @description The user must agree to the current legal version again (BR-ID-12). */
            need_reconsent: boolean;
            risk: components["schemas"]["RiskInfo"];
        };
        MeResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["Me"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Derived from convert.enabled.<platform> and convert.off_reason.<platform> (04 §10.1); lets
         *     cards tell "maintenance" from "coming soon" before a tap. The tap result (50301
         *     data.reason) still wins.
         * @enum {string}
         */
        PlatformPurchaseStatus: "on" | "maintenance" | "not_launched";
        ConfigFeatures: {
            /**
             * @description Client switches by key: agent.entry.visible, clipboard.enabled.<platform>,
             *     home.fallback, h5.route.<page>.enabled, ui.grayscale (03 §4.3);
             *     external_page.product_intercept (a platform product page inside the third-party page
             *     container goes back to the native product detail) and external_page.union_host_block
             *     (the container does not load union platform pages; derived from the server setting of
             *     the same name; a client that cannot read it treats it as on) (BR-ATTR-29);
             *     earnings.dashboard.visible (earnings dashboard entry, derived from
             *     earnings.dashboard.enabled, BR-FUND-25).
             */
            flags: {
                [key: string]: boolean;
            };
            /** @description Purchase status by platform code. */
            platform_status: {
                [key: string]: components["schemas"]["PlatformPurchaseStatus"];
            };
            /**
             * @description Search switch by platform code, derived from search.enabled.<platform> (04 §10.1);
             *     how a client treats a missing platform is in BR-PROD-10 细则.
             */
            search_status?: {
                [key: string]: components["schemas"]["PlatformSearchStatus"];
            };
        };
        /**
         * @description Whether search is open for a platform (enum platform_search_status).
         * @enum {string}
         */
        PlatformSearchStatus: "on" | "off";
        ConfigLegalPrivacy: {
            /** Format: int32 */
            version: number;
            /**
             * Format: int32
             * @description Below this version the user must agree again (BR-ID-12).
             */
            min_version: number;
        };
        ConfigLegalAgreement: {
            /** Format: int32 */
            version: number;
        };
        /** @description legal.privacy.version, legal.privacy.min_version, legal.agreement.version (04 §10.1). */
        ConfigLegal: {
            privacy: components["schemas"]["ConfigLegalPrivacy"];
            agreement: components["schemas"]["ConfigLegalAgreement"];
        };
        ConfigInvite: {
            /** @description Must be false in the MVP (BR-INV-06). */
            required: boolean;
            /**
             * Format: int32
             * @description Window for entering an inviter later (BR-INV-07).
             */
            backfill_hours: number;
            /**
             * @description Show the bind-phone guide to new third-party accounts (BR-INV-03 细则). Optional in
             *     the schema like every key added after v0.9; the server always sends it.
             */
            bind_phone_guide?: boolean;
            /** @description Show the inviter tip before the first purchase (BR-INV-21). */
            before_buy_tip?: boolean;
        };
        /** @description Agent availability and guest quota (04 §10.1; BR-AI-11, BR-AI-12). */
        ConfigAgent: {
            enabled: boolean;
            whitelist_only: boolean;
            filing_text: string;
            examples: string[];
            /** Format: int32 */
            guest_daily_quota: number;
            require_phone: boolean;
        };
        /** @description H5 version bucket for this caller (拍板第二批 TECH-28). */
        ConfigH5Release: {
            version: string;
        };
        /** @description WeCom customer-service chat link (chat entry only). */
        ConfigKf: {
            /** Format: uri */
            url: string;
        };
        /** @description Third-party page container settings (BR-ATTR-29). */
        ConfigExternalPage: {
            /**
             * Format: int32
             * @description Sampling rate of document-level navigation hosts, 1/10000 (default in BR-ATTR-29).
             */
            nav_host_sample_bp: number;
        };
        /**
         * @description Category of a platform link pattern (enum link_pattern_category, BR-ATTR-29).
         * @enum {string}
         */
        LinkPatternCategory: "product" | "promo" | "union_host";
        /**
         * @description Hosts and path patterns of one platform and category. How hosts match (union_host by
         *     registered domain including subdomains) and the path pattern syntax are defined with the
         *     source table specs/link-patterns.yaml (CT-15g); concrete values come from real samples (B1-07).
         */
        LinkPatternRule: {
            platform: components["schemas"]["PlatformCode"];
            category: components["schemas"]["LinkPatternCategory"];
            hosts: string[];
            path_patterns: string[];
        };
        /**
         * @description Client pre-filter subset of the platform link pattern table (source
         *     specs/link-patterns.yaml). Clients decide where a document-level navigation in the
         *     third-party page container goes (main frame, subframe, new window); product recognition
         *     follows the server. When the fetch fails they use the last good version, then the bundled
         *     snapshot, and never stop intercepting (BR-ATTR-29).
         */
        ConfigLinkPatterns: {
            version: string;
            rules: components["schemas"]["LinkPatternRule"][];
        };
        ConfigAppUpdate: {
            /**
             * Format: int32
             * @description On returning to the foreground, call GET /v1/app-versions/check again when the last
             *     successful check is older than this (value and bundled default in BR-ID-01 细则
             *     「最低支持版本的接口层拦截」).
             */
            recheck_interval_sec: number;
        };
        /**
         * @description Jump target {route, params} of a help_links entry: always one help article, the Help
         *     route of contracts/routes.json with its article_id (04 §10.1「原生页到帮助文章的入口表」).
         *     conformance.ts checks that the route exists there and that params is a subset of that
         *     route's params schema.
         */
        HelpLinkTarget: {
            /** @enum {string} */
            route: "Help";
            params: {
                article_id: string;
            };
        };
        ConfigClaim: {
            /**
             * Format: int32
             * @description Days within which an order claim may be filed, claim.window_hours rounded down to
             *     days; null when below one day or not configured. Only renders the claim form's period
             *     sentence (BR-ATTR-17 细则「找回页的填写指引」); claim.window_hours is not sent.
             */
            window_days: number | null;
        };
        /**
         * @description Top-level keys of /v1/config (04 §10.1, excerpt). Keys added after v0.9 (external_page,
         *     link_patterns, external_hosts, app_update, help_links, claim) are optional, so a client
         *     keeps reading an older last-good configuration (04 §5「兼容」); the server always sends
         *     them. jump_tip, clipboard, bridge_origins, auth_tips, compliance and display are not
         *     shaped by 04 yet and stay free-form; the task that consumes each one types it
         *     (bridge_origins with CT-03, clipboard with B1-07).
         */
        Config: {
            /** @description Version of the /v1/dict dictionary (BR-TEXT-12). */
            dict_version: string;
            /** Format: uri */
            h5_base_url: string;
            h5_release: components["schemas"]["ConfigH5Release"];
            share_domains: string[];
            features: components["schemas"]["ConfigFeatures"];
            /** @description Custom text keys, e.g. withdraw.sla_text (BR-TEXT-07). */
            texts: {
                [key: string]: string;
            };
            legal: components["schemas"]["ConfigLegal"];
            invite: components["schemas"]["ConfigInvite"];
            agent: components["schemas"]["ConfigAgent"];
            kf: components["schemas"]["ConfigKf"];
            jump_tip: components["schemas"]["FreeForm"];
            clipboard: components["schemas"]["FreeForm"];
            bridge_origins: components["schemas"]["FreeForm"];
            auth_tips: components["schemas"]["FreeForm"];
            compliance: components["schemas"]["FreeForm"];
            display: components["schemas"]["FreeForm"];
            external_page?: components["schemas"]["ConfigExternalPage"];
            link_patterns?: components["schemas"]["ConfigLinkPatterns"];
            /**
             * @description Third-party page hosts a deep link may open in ExternalPage, matched by full host name
             *     (values and default in BR-ID-10 细则「深链能打开的第三方页面」); push and in-app
             *     targets are not limited by it (03 §4.4).
             */
            external_hosts?: string[];
            app_update?: components["schemas"]["ConfigAppUpdate"];
            /**
             * @description Native entries to help articles: key → jump target; an entry whose key is not
             *     configured is not shown. Keys are defined by the rules that use them: price_compare
             *     (BR-TEXT-03), claim_guide.<platform> (BR-ATTR-17 细则), login_help (BR-ID-02 细则),
             *     withdraw_rules (BR-WDR-04 细则). Values are operations configuration (article ids).
             */
            help_links?: {
                [key: string]: components["schemas"]["HelpLinkTarget"];
            };
            claim?: components["schemas"]["ConfigClaim"];
        };
        ConfigResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["Config"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Buy button chosen by the server; the client never decides it (BR-TEXT-12, 拍板第二批
         *     TRADE-21): btn.buy.coupon (有券有返), btn.buy (无券有返 and amount_unknown),
         *     btn.buy.no_rebate (无返利); other keys come with login_required and taolijin cards.
         */
        ProductCta: {
            text_key: string;
        };
        /** @description Taolijin of the card, absent when there is none (BR-PRICE-08); never folded into prices. */
        ProductTlj: {
            amount_fen: components["schemas"]["Fen"];
            /** Format: int32 */
            remain: number;
            /**
             * @description contracts/enums/trade.yaml tlj_kind.
             * @enum {string}
             */
            kind: "ours" | "brand_open" | "third_party" | "unknown";
        };
        /**
         * @description Product card (04 §8.3). Price semantics BR-PRICE-01 / 05; rebate_* and est_net_price_fen
         *     are computed per request for the current caller and never cached (BR-PRICE-11). The card
         *     carries a registered `link_id`; buying always goes through POST /v1/links/{link_id}/open
         *     (BR-PRICE-12, BR-PRICE-21). amount_unknown cards have product_key, prices and rebate
         *     null (BR-PRICE-08).
         */
        ProductCard: {
            /** @description Agent card sequence id (c1, c2…), only on Agent cards (BR-AI-05). */
            card_id?: string;
            /** @description Opaque product key (BR-PROD-02); null only on amount_unknown cards. */
            product_key: string | null;
            /** @description Opaque signed reference passed through unchanged (BR-PROD-11). */
            item_ref: string | null;
            platform: components["schemas"]["PlatformCode"];
            /** @description Shop type, e.g. tmall for Tmall shops on taobao. */
            shop_type?: string | null;
            title: string | null;
            /** Format: uri */
            image: string | null;
            shop_name?: string | null;
            price_fen: components["schemas"]["NullableFen"];
            coupon_fen: components["schemas"]["NullableFen"];
            final_price_fen: components["schemas"]["NullableFen"];
            est_net_price_fen: components["schemas"]["NullableFen"];
            rebate_min_fen: components["schemas"]["NullableFen"];
            rebate_max_fen: components["schemas"]["NullableFen"];
            rebate_basis: components["schemas"]["RebateBasis"];
            /**
             * @description May be non-null only when rebate_basis=no_rebate (BR-PRICE-08 细则「无返利原因」);
             *     unknown values are treated as null. Not the open request's no_rebate_reason.
             */
            no_rebate_cause?: components["schemas"]["NoRebateCause"] | null;
            /** @description Server-generated labels (有券, 预售, 标题显示为 X…); no per-card reasons. */
            benefit_tags: string[];
            /**
             * @description Agent cards only (BR-AI-24); contracts/enums/trade.yaml match_tag.
             * @enum {string}
             */
            match_tag?: "matched" | "relaxed" | "spec_unconfirmed";
            spec_text?: string | null;
            /** @description Presale; shown with the total price (BR-PRICE-22). */
            is_presale: boolean;
            tlj?: components["schemas"]["ProductTlj"];
            link_id: components["schemas"]["Id"];
            cta: components["schemas"]["ProductCta"];
            /**
             * Format: date-time
             * @description Receipt time of the union response the price is based on (BR-PRICE-11).
             */
            quoted_at: string | null;
            stale: boolean;
            /**
             * Format: int32
             * @description Age of the price in seconds, computed by the server (BR-PRICE-11).
             */
            age_sec: number | null;
            /**
             * @description Price source (BR-PRICE-16).
             * @enum {string}
             */
            source: "taobao_union" | "jd_union" | "pdd_union";
            /** @description Ordered dictionary keys (BR-PRICE-17), including price_basis. */
            disclaimer_keys: string[];
            /** @description Ad label (BR-TEXT-17); null on Agent relevance cards. */
            ad_label?: string | null;
            availability: components["schemas"]["Availability"];
        };
        SearchProductsData: {
            items: components["schemas"]["ProductCard"][];
            next_cursor: string | null;
            /** @description As reported by the union, not by the filtered page size (BR-PRICE-08). */
            has_more: boolean;
            /** @description Only when items is empty on the first page; the platform's first 10 feed items. */
            fallback_items: components["schemas"]["ProductCard"][];
        };
        SearchProductsResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["SearchProductsData"];
            trace_id: components["schemas"]["TraceId"];
        };
        ProductResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["ProductCard"];
            trace_id: components["schemas"]["TraceId"];
        };
        ParseInputRequest: {
            /**
             * @description Locally filtered clipboard or typed text (03 §4.6). Text outside links and tokens
             *     is untrusted (BR-AI-05); prices in it are only material.claimed_price_fen.
             */
            text: string;
            /**
             * @description Entry the text came from (subset of contracts/enums scene). Attribution-bearing
             *     scenes (share, agent, …) cannot be chosen by the client: share links come only from
             *     POST /v1/shares (phone level), Agent cards from the Agent service (BR-ATTR-05, 08).
             *     share_ext is P1.
             * @enum {string}
             */
            scene: "clipboard" | "search" | "share_ext";
        };
        /** @description One candidate found by parse_input (04 §8.5). */
        InputHit: {
            platform: components["schemas"]["PlatformCode"];
            /**
             * @description contracts/enums/trade.yaml input_kind.
             * @enum {string}
             */
            kind: "tpwd" | "url" | "text";
            /** @description The matched link or token as it appeared in the input. */
            raw: string;
        };
        /**
         * @description Result of one hit; exactly one of `card` and `error_code` is present. The oneOf branches
         *     declare the property they require (strict Ajv2020, ADR-0001 §4.2 #15).
         */
        ParseResult: {
            hit: components["schemas"]["InputHit"];
            card?: components["schemas"]["ProductCard"];
            /**
             * Format: int32
             * @description Error code for this hit (30131, 30132, 30141, 50301…), see error-codes.yaml.
             */
            error_code?: number;
        } & ({
            card: components["schemas"]["ProductCard"];
        } | {
            /** Format: int32 */
            error_code: number;
        });
        ParseInputData: {
            results: components["schemas"]["ParseResult"][];
        };
        ParseInputResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["ParseInputData"];
            trace_id: components["schemas"]["TraceId"];
        };
        OpenLinkRequest: {
            /** @description Default unknown; H5 always sends unknown (BR-ATTR-27 ①). */
            installed?: components["schemas"]["InstalledState"];
            /**
             * @description Buy without rebate (BR-ID-18).
             * @default false
             */
            no_rebate?: boolean;
            /**
             * @description Only with no_rebate=true; default auth_declined. The server overrides it with
             *     relation_conflict / binding_blocked when it decides so (BR-ID-18).
             * @enum {string}
             */
            no_rebate_reason?: "auth_declined" | "auth_failed";
            /** @description page.module.slot of the tapped button (03 §4.7). */
            spm?: string;
        };
        /**
         * @description Response of open (04 §8.4). old_final_price_fen is the link's quoted_final_price_fen;
         *     price_changed when |new − old| ≥ 100 fen or ≥ 5 % of old, both directions (BR-PRICE-13).
         *     Prices and rebates are null on amount_unknown links, which are not re-checked. There is no
         *     rebate_basis: no rebate is expressed by new_rebate_max_fen = 0 (BR-PRICE-08, BR-PRICE-13).
         */
        OpenLinkResult: {
            /**
             * @description Issued by the server for this open attempt: a new one for every open of a link, the
             *     same one when the same Idempotency-Key is replayed. The client sends it in every
             *     link_jump of this jump (BR-ATTR-21 细则「待跟单卡按实际外跳选」).
             */
            attempt_id: string;
            /**
             * @description Non-null only when new_rebate_max_fen = 0 and the reason is known; unknown values are
             *     treated as null. Not the request's no_rebate_reason (BR-ID-18).
             */
            no_rebate_cause?: components["schemas"]["NoRebateCause"] | null;
            jump: components["schemas"]["JumpPlan"];
            price_changed: boolean;
            old_final_price_fen: components["schemas"]["NullableFen"];
            new_final_price_fen: components["schemas"]["NullableFen"];
            /**
             * @description Set whenever the new price differs from the snapshot, or when a new link was
             *     registered for the current user (BR-PRICE-12, BR-ATTR-05 ③); the client replaces the
             *     card with it whether or not the user continues.
             */
            new_link_id: string | null;
            /** @description Re-check failed and the user's cached link (≤ 900 s) is used (BR-PRICE-13). */
            requote_failed: boolean;
            new_rebate_min_fen: components["schemas"]["NullableFen"];
            new_rebate_max_fen: components["schemas"]["NullableFen"];
            availability: components["schemas"]["Availability"];
            /** Format: date-time */
            quoted_at: string | null;
        };
        OpenLinkResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["OpenLinkResult"];
            trace_id: components["schemas"]["TraceId"];
        };
        /**
         * @description Either product_key (with the tapped card's item_ref) or url; neither, or both, is 20001.
         *     The oneOf branches declare the property they require (strict Ajv2020, ADR-0001 §4.2 #15).
         */
        ConvertLinkRequest: {
            platform: components["schemas"]["PlatformCode"];
            product_key?: components["schemas"]["ProductKey"];
            item_ref?: components["schemas"]["ItemRef"];
            /** Format: uri */
            url?: string;
            /**
             * @description Only the H5 entry (trade.convertAndOpen) uses convert (拍板第二批 TRADE-03); other
             *     scenes are rejected with 20001 so that the client cannot pick an attribution scene
             *     such as share (BR-ATTR-05, BR-ATTR-08).
             * @enum {string}
             */
            scene: "h5";
            spm?: string;
            /** @description Default unknown; H5 always sends unknown (BR-ATTR-27 ①). */
            installed?: components["schemas"]["InstalledState"];
        } & ({
            product_key: components["schemas"]["ProductKey"];
        } | {
            /** Format: uri */
            url: string;
        });
        /** @description The registered link_id plus the same fields as the open result (04 §6.3). */
        ConvertLinkData: {
            /**
             * @description Issued by the server for this open attempt: a new one for every open of a link, the
             *     same one when the same Idempotency-Key is replayed. The client sends it in every
             *     link_jump of this jump (BR-ATTR-21 细则「待跟单卡按实际外跳选」).
             */
            attempt_id: string;
            /**
             * @description Non-null only when new_rebate_max_fen = 0 and the reason is known; unknown values are
             *     treated as null. Not the request's no_rebate_reason (BR-ID-18).
             */
            no_rebate_cause?: components["schemas"]["NoRebateCause"] | null;
            link_id: components["schemas"]["Id"];
            jump: components["schemas"]["JumpPlan"];
            price_changed: boolean;
            old_final_price_fen: components["schemas"]["NullableFen"];
            new_final_price_fen: components["schemas"]["NullableFen"];
            new_link_id: string | null;
            requote_failed: boolean;
            new_rebate_min_fen: components["schemas"]["NullableFen"];
            new_rebate_max_fen: components["schemas"]["NullableFen"];
            availability: components["schemas"]["Availability"];
            /** Format: date-time */
            quoted_at: string | null;
        };
        ConvertLinkResponse: {
            code: components["schemas"]["SuccessCode"];
            msg: string;
            data: components["schemas"]["ConvertLinkData"];
            trace_id: components["schemas"]["TraceId"];
        };
    };
    responses: {
        /**
         * @description Business or request error. Clients act on `code` only (contracts/error-codes.yaml);
         *     the HTTP status per code is listed there as well.
         */
        ClientError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Rate limited (42901) with the required Retry-After header in seconds (BR-ID-05, BR-TEXT-14). */
        TooManyRequests: {
            headers: {
                /** @description Seconds to wait before retrying. */
                "Retry-After": number;
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "code": 42901,
                 *       "msg": "请求过于频繁",
                 *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                 *     }
                 */
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Server-side error; 503 codes carry `data.platform` / `data.reason` where listed. */
        ServerError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
    };
    parameters: {
        /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
        AppId: string;
        /** @description Client platform (enum client_platform, 03 §4.2). */
        Platform: components["schemas"]["ClientPlatformCode"];
        /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
        AppVersion: string;
        /** @description Build number of the client. */
        Build: string;
        /** @description Install channel of the app package (enum install_channel); absent for H5. */
        Channel: components["schemas"]["InstallChannelCode"];
        /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
        TraceId: components["schemas"]["TraceId"];
        /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
        DeviceId: components["schemas"]["Id"];
        /** @description device_id issued by POST /v1/devices, when the device is registered. */
        OptionalDeviceId: components["schemas"]["Id"];
        /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
        Timestamp: string;
        /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
        Nonce: string;
        /**
         * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
         *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
         */
        Sign: string;
        /**
         * @description step_up_token from POST /v1/auth/step-up for the operation's x-step-up action (04 §5). Missing,
         *     expired or for another action → 10003 (not 20001; that is why the header is optional).
         */
        StepUpToken: string;
        TipKeyPath: components["schemas"]["TipKey"];
        /**
         * @description Required on operations marked I (04 §6); missing → 20001. Same key while processing →
         *     40901; same key with another body → 20901; a retry after a timeout reuses the key and gets
         *     the first result (拍板第二批 TRADE-22). On the x-step-up operations a key abandoned through
         *     POST /v1/idempotency-keys/abandon → 20903, without comparing the body (04 §5「幂等」).
         */
        IdempotencyKey: components["schemas"]["IdempotencyKey"];
        /** @description Platform code (enum platform). */
        UnionPlatform: components["schemas"]["PlatformCode"];
        /**
         * @description link_id of the pending-track card. Unlike other link operations an unknown link, or one that
         *     does not own the attempt_id in the body, is 20001 with data.fields=[attempt_id] (no 30144).
         */
        PendingTrackLinkId: components["schemas"]["Id"];
        /** @description link_id from a card; unknown or of another app → 30144. */
        LinkId: components["schemas"]["Id"];
        /** @description Opaque product key, URL-encoded by the client (BR-PROD-02). */
        ProductKey: components["schemas"]["ProductKey"];
        /** @description Opaque cursor from `next_cursor`; absent for the first page. */
        Cursor: string;
        /** @description Page size, at most 50 (04 §5). */
        Limit: number;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealthz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The process is initialised. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "status": "ok",
                     *         "entry": "api",
                     *         "now": "2026-10-01T04:00:00.000Z"
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["HealthzResponse"];
                };
            };
        };
    };
    registerDevice: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "device_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                 *       "id_source": "idfv"
                 *     }
                 */
                "application/json": components["schemas"]["RegisterDeviceRequest"];
            };
        };
        responses: {
            /** @description Device registered. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "device_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a60",
                     *         "install_secret": "example-install-secret-value"
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["RegisterDeviceResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    reportPushToken: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "provider": "placeholder-provider",
                 *       "token": "placeholder-push-token"
                 *     }
                 */
                "application/json": components["schemas"]["ReportPushTokenRequest"];
            };
        };
        responses: {
            /** @description Accepted (also when the report was ignored). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {},
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["EmptyResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    sendSmsCode: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "phone": "13800138000",
                 *       "purpose": "login"
                 *     }
                 */
                "application/json": components["schemas"]["SendSmsCodeRequest"];
            };
        };
        responses: {
            /** @description The provider accepted the SMS. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "resend_after_sec": 60,
                     *         "expires_in_sec": 300
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["SendSmsCodeResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    loginBySms: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "phone": "13800138000",
                 *       "code": "123456",
                 *       "legal_versions": {
                 *         "privacy": 3,
                 *         "agreement": 2
                 *       },
                 *       "consent_at": "2026-10-02T09:30:00+08:00",
                 *       "invite_code": "K7Q2MZ"
                 *     }
                 */
                "application/json": components["schemas"]["LoginBySmsRequest"];
            };
        };
        responses: {
            /** @description Logged in. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "user_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61",
                     *         "is_new_user": true,
                     *         "tokens": {
                     *           "access_token": "example-access-token-one",
                     *           "access_expires_at": "2026-10-02T11:30:00+08:00",
                     *           "refresh_token": "example-refresh-token-one",
                     *           "refresh_expires_at": "2026-11-01T09:30:00+08:00",
                     *           "session_scope": "full"
                     *         },
                     *         "invite_bind": {
                     *           "result": "bound",
                     *           "code": null
                     *         }
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    createOauthAttempt: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "provider": "wechat",
                 *       "purpose": "login"
                 *     }
                 */
                "application/json": components["schemas"]["CreateOauthAttemptRequest"];
            };
        };
        responses: {
            /** @description A new attempt. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "attempt_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a71",
                     *         "nonce": "example-attempt-nonce-value",
                     *         "expire_at": "2026-10-02T09:40:00+08:00"
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["OauthAttemptResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    loginByWechat: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "attempt_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a71",
                 *       "code": "example-wechat-auth-code",
                 *       "legal_versions": {
                 *         "privacy": 3,
                 *         "agreement": 2
                 *       },
                 *       "consent_at": "2026-10-02T09:30:00+08:00"
                 *     }
                 */
                "application/json": components["schemas"]["LoginByWechatRequest"];
            };
        };
        responses: {
            /** @description Logged in. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "user_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61",
                     *         "is_new_user": false,
                     *         "tokens": {
                     *           "access_token": "example-access-token-one",
                     *           "access_expires_at": "2026-10-02T11:30:00+08:00",
                     *           "refresh_token": "example-refresh-token-one",
                     *           "refresh_expires_at": "2026-11-01T09:30:00+08:00",
                     *           "session_scope": "full"
                     *         }
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    loginByApple: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "attempt_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a71",
                 *       "identity_token": "example-apple-identity-token",
                 *       "authorization_code": "example-apple-authorization-code",
                 *       "legal_versions": {
                 *         "privacy": 3,
                 *         "agreement": 2
                 *       },
                 *       "consent_at": "2026-10-02T09:30:00+08:00"
                 *     }
                 */
                "application/json": components["schemas"]["LoginByAppleRequest"];
            };
        };
        responses: {
            /** @description Logged in. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "user_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61",
                     *         "is_new_user": false,
                     *         "tokens": {
                     *           "access_token": "example-access-token-one",
                     *           "access_expires_at": "2026-10-02T11:30:00+08:00",
                     *           "refresh_token": "example-refresh-token-one",
                     *           "refresh_expires_at": "2026-11-01T09:30:00+08:00",
                     *           "session_scope": "full"
                     *         }
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    loginByHuawei: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "attempt_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a71",
                 *       "authorization_code": "example-huawei-authorization-code",
                 *       "legal_versions": {
                 *         "privacy": 3,
                 *         "agreement": 2
                 *       },
                 *       "consent_at": "2026-10-02T09:30:00+08:00"
                 *     }
                 */
                "application/json": components["schemas"]["LoginByHuaweiRequest"];
            };
        };
        responses: {
            /** @description Logged in. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "user_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61",
                     *         "is_new_user": false,
                     *         "tokens": {
                     *           "access_token": "example-access-token-one",
                     *           "access_expires_at": "2026-10-02T11:30:00+08:00",
                     *           "refresh_token": "example-refresh-token-one",
                     *           "refresh_expires_at": "2026-11-01T09:30:00+08:00",
                     *           "session_scope": "full"
                     *         }
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    stepUp: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StepUpRequest"];
            };
        };
        responses: {
            /** @description A step-up token for the action. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "step_up_token": "example-step-up-token",
                     *         "expire_at": "2026-10-02T09:35:00+08:00"
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["StepUpResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    refreshToken: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "refresh_token": "example-refresh-token-one"
                 *     }
                 */
                "application/json": components["schemas"]["RefreshTokenRequest"];
            };
        };
        responses: {
            /** @description New token pair. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "access_token": "example-access-token-two",
                     *         "access_expires_at": "2026-10-02T13:30:00+08:00",
                     *         "refresh_token": "example-refresh-token-two",
                     *         "refresh_expires_at": "2026-11-01T11:30:00+08:00",
                     *         "session_scope": "full"
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["TokenPairResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    issueH5Token: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "scope": "standard"
                 *     }
                 */
                "application/json": components["schemas"]["IssueH5TokenRequest"];
            };
        };
        responses: {
            /** @description A new h5_token. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "token": "placeholder",
                     *         "expire_at": "2026-10-02T10:00:00+08:00",
                     *         "scope": "standard"
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["H5TokenResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    listUnionBindings: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorization state per platform. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "items": [
                     *           {
                     *             "platform": "taobao",
                     *             "status": "active"
                     *           },
                     *           {
                     *             "platform": "jd",
                     *             "status": "unbound"
                     *           },
                     *           {
                     *             "platform": "pdd",
                     *             "status": "released"
                     *           }
                     *         ]
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["UnionBindingsResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    getUnionAuthUrl: {
        parameters: {
            query?: {
                /** @description Whether the platform app is installed; when absent see BR-ID-22 细则. */
                installed?: components["schemas"]["InstalledState"];
            };
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path: {
                /** @description Platform code (enum platform). */
                platform: components["parameters"]["UnionPlatform"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The authorization link. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UnionAuthUrlResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    bindUnion: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
                /**
                 * @description Required on operations marked I (04 §6); missing → 20001. Same key while processing →
                 *     40901; same key with another body → 20901; a retry after a timeout reuses the key and gets
                 *     the first result (拍板第二批 TRADE-22). On the x-step-up operations a key abandoned through
                 *     POST /v1/idempotency-keys/abandon → 20903, without comparing the body (04 §5「幂等」).
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description Platform code (enum platform). */
                platform: components["parameters"]["UnionPlatform"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BindUnionRequest"];
            };
        };
        responses: {
            /** @description The binding state after binding. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "platform": "taobao",
                     *         "status": "active"
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["UnionBindingResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    listOrders: {
        parameters: {
            query: {
                /** @description self = my own purchases; share = orders bought through my shares. */
                scope: components["schemas"]["OrderScope"];
                /** @description Status group (enum order_status_group); absent = all. */
                status_group?: components["schemas"]["OrderStatusGroup"];
                display_status?: components["schemas"]["OrderDisplayStatus"];
                platform?: components["schemas"]["PlatformCode"];
                /** @description Order number or title words, at most 40 characters (BR-TEXT-02 细则). */
                q?: string;
                /** @description Month of payment, YYYY-MM in +08:00; only months in the visible range. */
                paid_month?: string;
                /** @description Opaque cursor from `next_cursor`; absent for the first page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size, at most 50 (04 §5). */
                limit?: components["parameters"]["Limit"];
            };
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of orders. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "items": [
                     *           {
                     *             "order_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a90",
                     *             "platform": "taobao",
                     *             "title": "降噪蓝牙耳机",
                     *             "image_url": "https://img.example.test/p/1.jpg",
                     *             "pay_amount_fen": 2990,
                     *             "quantity": 1,
                     *             "order_no": "3712345678901234567",
                     *             "display_status": "WAITING",
                     *             "reason": null,
                     *             "est_rebate_fen": 269,
                     *             "paid_at": "2026-10-02T09:31:00+08:00",
                     *             "is_other_product": false
                     *           }
                     *         ],
                     *         "next_cursor": null,
                     *         "earliest_visible_date": null
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["OrderListResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    listPendingTracks: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pending-track cards. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "items": [
                     *           {
                     *             "link_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70",
                     *             "attempt_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80",
                     *             "platform": "taobao",
                     *             "jumped_at": "2026-10-02T09:30:05+08:00",
                     *             "show_claim_entry": false,
                     *             "dismissed": false
                     *           }
                     *         ]
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["PendingTracksResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    dismissPendingTrack: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path: {
                /**
                 * @description link_id of the pending-track card. Unlike other link operations an unknown link, or one that
                 *     does not own the attempt_id in the body, is 20001 with data.fields=[attempt_id] (no 30144).
                 */
                link_id: components["parameters"]["PendingTrackLinkId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "attempt_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80"
                 *     }
                 */
                "application/json": components["schemas"]["DismissPendingTrackRequest"];
            };
        };
        responses: {
            /** @description The card of this attempt is closed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {},
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["EmptyResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    getOrder: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path: {
                order_id: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The order. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "order_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a90",
                     *         "platform": "taobao",
                     *         "title": "降噪蓝牙耳机",
                     *         "image_url": "https://img.example.test/p/1.jpg",
                     *         "pay_amount_fen": 2990,
                     *         "quantity": 1,
                     *         "order_no": "3712345678901234567",
                     *         "display_status": "WAITING",
                     *         "reason": null,
                     *         "reason_action": [],
                     *         "est_rebate_fen": 269,
                     *         "paid_at": "2026-10-02T09:31:00+08:00",
                     *         "is_other_product": false,
                     *         "product_key": "tb:9001",
                     *         "expected_credit_period": "2026-11",
                     *         "credit_overdue": false,
                     *         "actual_fen": null,
                     *         "clawback_fen": null,
                     *         "appeal_pending": false,
                     *         "is_price_compare": false,
                     *         "timeline": [
                     *           {
                     *             "node": "paid",
                     *             "at": "2026-10-02T09:31:00+08:00",
                     *             "period": null
                     *           },
                     *           {
                     *             "node": "received",
                     *             "at": "2026-10-05T12:00:00+08:00",
                     *             "period": null
                     *           },
                     *           {
                     *             "node": "credit_expected",
                     *             "at": null,
                     *             "period": "2026-11"
                     *           },
                     *           {
                     *             "node": "credited",
                     *             "at": null,
                     *             "period": null
                     *           }
                     *         ]
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["OrderDetailResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current user. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "user_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61",
                     *         "nickname": "凑狸用户 8000",
                     *         "avatar_url": "https://cdn.example.test/avatar/default.png",
                     *         "invite_code": "K7Q2MZ",
                     *         "inviter_bound": false,
                     *         "invite_backfill": {
                     *           "eligible": true,
                     *           "deadline_at": "2026-10-09T09:30:00+08:00"
                     *         },
                     *         "identity_level": "phone",
                     *         "phone_bound": true,
                     *         "balance": {
                     *           "available_fen": 1234,
                     *           "withdrawable_fen": 1000,
                     *           "estimated_total_fen": 5678
                     *         },
                     *         "union_bindings": [
                     *           {
                     *             "platform": "taobao",
                     *             "status": "active"
                     *           },
                     *           {
                     *             "platform": "pdd",
                     *             "status": "unbound"
                     *           }
                     *         ],
                     *         "realname_status": "none",
                     *         "need_reconsent": false,
                     *         "risk": {
                     *           "state": "normal",
                     *           "reason_category": null,
                     *           "frozen_until": null
                     *         }
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["MeResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    bindPhone: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
                /**
                 * @description Required on operations marked I (04 §6); missing → 20001. Same key while processing →
                 *     40901; same key with another body → 20901; a retry after a timeout reuses the key and gets
                 *     the first result (拍板第二批 TRADE-22). On the x-step-up operations a key abandoned through
                 *     POST /v1/idempotency-keys/abandon → 20903, without comparing the body (04 §5「幂等」).
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description step_up_token from POST /v1/auth/step-up for the operation's x-step-up action (04 §5). Missing,
                 *     expired or for another action → 10003 (not 20001; that is why the header is optional).
                 */
                "X-Step-Up-Token"?: components["parameters"]["StepUpToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "phone": "13800008000",
                 *       "code": "246810"
                 *     }
                 */
                "application/json": components["schemas"]["BindPhoneRequest"];
            };
        };
        responses: {
            /** @description The number is bound to the account. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {},
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["EmptyResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    getPayoutAccount: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current payout account, or an empty object. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PayoutAccountResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    savePayoutAccount: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
                /**
                 * @description Required on operations marked I (04 §6); missing → 20001. Same key while processing →
                 *     40901; same key with another body → 20901; a retry after a timeout reuses the key and gets
                 *     the first result (拍板第二批 TRADE-22). On the x-step-up operations a key abandoned through
                 *     POST /v1/idempotency-keys/abandon → 20903, without comparing the body (04 §5「幂等」).
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description step_up_token from POST /v1/auth/step-up for the operation's x-step-up action (04 §5). Missing,
                 *     expired or for another action → 10003 (not 20001; that is why the header is optional).
                 */
                "X-Step-Up-Token"?: components["parameters"]["StepUpToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SavePayoutAccountRequest"];
            };
        };
        responses: {
            /** @description The saved account (masked). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "payout_method": "bank_card",
                     *         "masked_account": "尾号 0000",
                     *         "bank_name": "示例银行",
                     *         "masked_payee_name": "**三",
                     *         "change_remaining_this_month": 1
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["PayoutAccountResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    getTips: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The read states. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "jump_tip": {
                     *           "taobao": "2026-10-02T09:30:00+08:00",
                     *           "jd": null
                     *         },
                     *         "inviter_before_buy": null
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["TipsResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    markTipRead: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path: {
                tip_key: components["parameters"]["TipKeyPath"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                /**
                 * @example {
                 *       "platform": "taobao"
                 *     }
                 */
                "application/json": components["schemas"]["MarkTipReadRequest"];
            };
        };
        responses: {
            /** @description Recorded (or already recorded). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {},
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["EmptyResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    resetTip: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path: {
                /** @description Only jump_tip can be reset. */
                tip_key: components["schemas"]["ResettableTipKey"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The read records are cleared. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {},
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["EmptyResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    getDeletion: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The latest request, or null. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "status": "cooling",
                     *         "apply_at": "2026-10-02T09:30:00+08:00",
                     *         "cooling_until": "2026-10-09T09:30:00+08:00",
                     *         "can_cancel": true,
                     *         "cancelled_at": null,
                     *         "cancel_reason": null,
                     *         "processed_at": null
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["DeletionResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    requestDeletion: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
                /**
                 * @description Required on operations marked I (04 §6); missing → 20001. Same key while processing →
                 *     40901; same key with another body → 20901; a retry after a timeout reuses the key and gets
                 *     the first result (拍板第二批 TRADE-22). On the x-step-up operations a key abandoned through
                 *     POST /v1/idempotency-keys/abandon → 20903, without comparing the body (04 §5「幂等」).
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description step_up_token from POST /v1/auth/step-up for the operation's x-step-up action (04 §5). Missing,
                 *     expired or for another action → 10003 (not 20001; that is why the header is optional).
                 */
                "X-Step-Up-Token"?: components["parameters"]["StepUpToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The request, now in cooling. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "status": "cooling",
                     *         "apply_at": "2026-10-02T09:30:00+08:00",
                     *         "cooling_until": "2026-10-09T09:30:00+08:00",
                     *         "can_cancel": true,
                     *         "cancelled_at": null,
                     *         "cancel_reason": null,
                     *         "processed_at": null
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["DeletionResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    cancelDeletion: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The cancelled request. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "status": "cancelled",
                     *         "apply_at": "2026-10-02T09:30:00+08:00",
                     *         "cooling_until": "2026-10-09T09:30:00+08:00",
                     *         "can_cancel": false,
                     *         "cancelled_at": "2026-10-03T10:00:00+08:00",
                     *         "cancel_reason": "user",
                     *         "processed_at": null
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["DeletionResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    abandonIdempotencyKey: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "action": "withdraw",
                 *       "idempotency_key": "example-withdraw-attempt"
                 *     }
                 */
                "application/json": components["schemas"]["AbandonIdempotencyKeyRequest"];
            };
        };
        responses: {
            /** @description The key is abandoned, or its completed result is returned. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AbandonIdempotencyKeyResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    getConfig: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices, when the device is registered. */
                "X-Device-Id"?: components["parameters"]["OptionalDeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current configuration. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": 0,
                     *       "msg": "",
                     *       "data": {
                     *         "dict_version": "2026100201",
                     *         "h5_base_url": "https://h5.example.test/",
                     *         "h5_release": {
                     *           "version": "1.4.2"
                     *         },
                     *         "share_domains": [
                     *           "s.example.test"
                     *         ],
                     *         "features": {
                     *           "flags": {
                     *             "agent.entry.visible": true,
                     *             "clipboard.enabled.taobao": true,
                     *             "ui.grayscale": false,
                     *             "external_page.product_intercept": true,
                     *             "external_page.union_host_block": true,
                     *             "earnings.dashboard.visible": false
                     *           },
                     *           "platform_status": {
                     *             "taobao": "on",
                     *             "jd": "on",
                     *             "pdd": "not_launched"
                     *           },
                     *           "search_status": {
                     *             "taobao": "on",
                     *             "jd": "off"
                     *           }
                     *         },
                     *         "texts": {
                     *           "withdraw.sla_text": "工作日 24 小时内处理"
                     *         },
                     *         "legal": {
                     *           "privacy": {
                     *             "version": 3,
                     *             "min_version": 3
                     *           },
                     *           "agreement": {
                     *             "version": 2
                     *           }
                     *         },
                     *         "invite": {
                     *           "required": false,
                     *           "backfill_hours": 168,
                     *           "bind_phone_guide": true,
                     *           "before_buy_tip": true
                     *         },
                     *         "agent": {
                     *           "enabled": true,
                     *           "whitelist_only": true,
                     *           "filing_text": "",
                     *           "examples": [
                     *             "帮我找 500 元以内的降噪耳机"
                     *           ],
                     *           "guest_daily_quota": 3,
                     *           "require_phone": false
                     *         },
                     *         "kf": {
                     *           "url": "https://work.weixin.qq.com/kfid/example"
                     *         },
                     *         "jump_tip": {},
                     *         "clipboard": {},
                     *         "bridge_origins": {},
                     *         "auth_tips": {},
                     *         "compliance": {},
                     *         "display": {},
                     *         "external_page": {
                     *           "nav_host_sample_bp": 100
                     *         },
                     *         "link_patterns": {
                     *           "version": "2026100401",
                     *           "rules": [
                     *             {
                     *               "platform": "taobao",
                     *               "category": "union_host",
                     *               "hosts": [
                     *                 "taobao.example.test"
                     *               ],
                     *               "path_patterns": []
                     *             }
                     *           ]
                     *         },
                     *         "external_hosts": [],
                     *         "app_update": {
                     *           "recheck_interval_sec": 1800
                     *         },
                     *         "help_links": {
                     *           "price_compare": {
                     *             "route": "Help",
                     *             "params": {
                     *               "article_id": "example-article-one"
                     *             }
                     *           }
                     *         },
                     *         "claim": {
                     *           "window_days": 30
                     *         }
                     *       },
                     *       "trace_id": "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b"
                     *     }
                     */
                    "application/json": components["schemas"]["ConfigResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    searchProducts: {
        parameters: {
            query: {
                /** @description Platform to search (enum platform). */
                platform: components["schemas"]["PlatformCode"];
                /** @description Keyword. */
                q: string;
                /** @description Sort order (enum sort); default relevance. */
                sort?: components["schemas"]["SortCode"];
                /** @description Only items with a coupon. */
                has_coupon?: boolean;
                /** @description Lower bound of final_price_fen, inclusive. */
                price_min_fen?: number;
                /** @description Upper bound of final_price_fen, inclusive. */
                price_max_fen?: number;
                /** @description Opaque cursor from `next_cursor`; absent for the first page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size, at most 50 (04 §5). */
                limit?: components["parameters"]["Limit"];
            };
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of results. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchProductsResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    getProduct: {
        parameters: {
            query?: {
                /** @description Opaque `item_ref` of the card that was tapped (BR-PROD-11); never parsed. */
                item_ref?: components["schemas"]["ItemRef"];
            };
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
            };
            path: {
                /** @description Opaque product key, URL-encoded by the client (BR-PROD-02). */
                product_key: components["parameters"]["ProductKey"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The product card of the detail page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProductResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    parseInput: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "text": "【淘宝】https://e.tb.cn/h.AbCdEf?tk=Xy12 「降噪耳机 蓝牙 5.3」",
                 *       "scene": "clipboard"
                 *     }
                 */
                "application/json": components["schemas"]["ParseInputRequest"];
            };
        };
        responses: {
            /** @description One result per recognised link or token, in input order. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ParseInputResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    openLink: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
                /**
                 * @description Required on operations marked I (04 §6); missing → 20001. Same key while processing →
                 *     40901; same key with another body → 20901; a retry after a timeout reuses the key and gets
                 *     the first result (拍板第二批 TRADE-22). On the x-step-up operations a key abandoned through
                 *     POST /v1/idempotency-keys/abandon → 20903, without comparing the body (04 §5「幂等」).
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description link_id from a card; unknown or of another app → 30144. */
                link_id: components["parameters"]["LinkId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "installed": "true",
                 *       "no_rebate": false,
                 *       "spm": "search.result_list.2"
                 *     }
                 */
                "application/json": components["schemas"]["OpenLinkRequest"];
            };
        };
        responses: {
            /** @description Jump plan and price re-check result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OpenLinkResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
    convertLink: {
        parameters: {
            query?: never;
            header: {
                /** @description App (brand) the request belongs to; before login it must match the app_id the device was registered with (10403, BR-ID-07). */
                "X-App-Id": components["parameters"]["AppId"];
                /** @description Client platform (enum client_platform, 03 §4.2). */
                "X-Platform": components["parameters"]["Platform"];
                /** @description SemVer, the same number on all three apps (拍板第二批 TECH-07). */
                "X-App-Version": components["parameters"]["AppVersion"];
                /** @description Build number of the client. */
                "X-Build"?: components["parameters"]["Build"];
                /** @description Install channel of the app package (enum install_channel); absent for H5. */
                "X-Channel"?: components["parameters"]["Channel"];
                /** @description Client-generated trace id, echoed as `trace_id` when well-formed. */
                "X-Trace-Id"?: components["parameters"]["TraceId"];
                /** @description device_id issued by POST /v1/devices; anything else is 10402 (BR-ID-09). */
                "X-Device-Id": components["parameters"]["DeviceId"];
                /** @description Unix seconds; |server time − ts| ≤ 300 s (BR-ID-09). */
                "X-Timestamp": components["parameters"]["Timestamp"];
                /** @description 32 lowercase hex characters; (device_id, nonce) unique within 600 s (BR-ID-09). */
                "X-Nonce": components["parameters"]["Nonce"];
                /**
                 * @description lowercase_hex(HMAC-SHA256(install_secret, METHOD + "\n" + path with raw query + "\n" + ts
                 *     + "\n" + nonce + "\n" + lowercase_hex(sha256(raw body)))) (BR-ID-09).
                 */
                "X-Sign": components["parameters"]["Sign"];
                /**
                 * @description Required on operations marked I (04 §6); missing → 20001. Same key while processing →
                 *     40901; same key with another body → 20901; a retry after a timeout reuses the key and gets
                 *     the first result (拍板第二批 TRADE-22). On the x-step-up operations a key abandoned through
                 *     POST /v1/idempotency-keys/abandon → 20903, without comparing the body (04 §5「幂等」).
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "platform": "jd",
                 *       "product_key": "jd:i_100012043978",
                 *       "item_ref": "v1.Zm9vYmFyLmJhei5xdXg",
                 *       "scene": "h5",
                 *       "spm": "h5_activity.banner.1",
                 *       "installed": "unknown"
                 *     }
                 */
                "application/json": components["schemas"]["ConvertLinkRequest"];
            };
        };
        responses: {
            /** @description The registered link and its jump plan. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConvertLinkResponse"];
                };
            };
            429: components["responses"]["TooManyRequests"];
            "4XX": components["responses"]["ClientError"];
            "5XX": components["responses"]["ServerError"];
        };
    };
}
