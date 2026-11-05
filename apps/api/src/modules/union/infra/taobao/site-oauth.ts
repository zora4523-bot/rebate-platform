// Taobao station-owner OAuth (B1-04zzi; FU-TB-AUTH-SESSION, D10-680): the real SiteOAuthProvider
// of B1-22c's re-authorization sessions, over the Taobao open platform OAuth2.0 server-side flow
// (rebate-private/docs-mirror/taobao/guides/118). The session flow itself (state hash, claim,
// exchange outside the transaction, FieldCrypto, audit) stays in ../../auth-expiry/reauth.ts.
//
// The rule tests in test/spec/union/taobao-site-oauth/** rely on this convention:
//
// - authorizeUrl → `https://oauth.taobao.com/authorize?` with exactly the official parameters
//   response_type=code, client_id=<appKey>, redirect_uri=<redirectUri> (URL encoded),
//   state=<state as handed in>, view=web. None of our own values (appId, unionAccountId,
//   expiresAt) and never the secret; the transport is not called and appSecret is not read.
// - exchange → one POST through `transport` (platform taobao) to `https://oauth.taobao.com/token`,
//   content-type application/x-www-form-urlencoded, body with exactly grant_type=authorization_code,
//   client_id, client_secret, code, redirect_uri. A 2xx JSON answer with a non-empty string
//   access_token and no `error` gives { accessToken: access_token, refreshToken: refresh_token
//   (missing or empty → null), expiresAt: clock.now() read after the answer arrived + expires_in
//   seconds (missing or not a positive number → null) }.
//   Anything else (non-2xx, not JSON, `error` present, access_token missing, transport error) →
//   rejects with an Error whose text and properties carry no code, token, secret or answer text
//   (the `error` code may appear) and no `cause`.
// - Credentials come only from the injected provider (B1-04k openTaobaoCredentials: staging file,
//   prod KMS); this module reads no environment variable or file, logs nothing, and reads time only
//   from the injected Clock. The sandbox host oauth.tbsandbox.com is never used.
import type { Clock, TaobaoAppCredentials } from '../../../platform/index.ts';
import type { SiteOAuthProvider } from '../../auth-expiry/reauth.ts';
import type { UnionTransport } from '../replay.ts';

export interface TaobaoSiteOAuthOptions {
  /** The Taobao app key and secret (B1-04k); asked for when needed, never cached here. */
  readonly credentials: () => Promise<TaobaoAppCredentials>;
  /** HTTPS transport of the token request; not an archiving one (the answer carries tokens). */
  readonly transport: UnionTransport;
  readonly clock: Clock;
  /** TAOBAO_OAUTH_REDIRECT_URI: the console's /unions/oauth-callback page (https). */
  readonly redirectUri: string;
}

export function createTaobaoSiteOAuth(options: TaobaoSiteOAuthOptions): SiteOAuthProvider {
  void options;
  throw new Error('NotImplemented: createTaobaoSiteOAuth');
}
