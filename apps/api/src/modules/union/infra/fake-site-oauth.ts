// Fake station-owner OAuth providers for the admin re-authorization (B1-22d; BR-ID-24 ③, 细则
// 「后台告警手机号与重新授权会话」). No union's site OAuth adapter exists yet, so the admin entry
// assembles these in local / test only (as identity's fake third-party identity and fake SMS);
// elsewhere it gets no provider (an oauth-mode start then fails closed).
//
// SKELETON (B1-22d test round): bodies throw NotImplemented. The rule tests in
// test/spec/union/admin-accounts/** rely on this convention, which the implementation must keep:
//
// - createFakeSiteOAuth(appEnv, clock): local / test only, any other APP_ENV throws. It answers a
//   provider for every registered platform (taobao, jd, pdd); whether one is used depends on the
//   account's reauth_mode.
//   - authorizeUrl: an https address on the host `site-oauth.example.test` whose query parameter
//     `state` is exactly the state handed in (the console test reads it back from `auth_url`);
//     nothing else secret is in it.
//   - exchange, by the grant `code`:
//     `fake-site:ok:<label>` → accessToken `fake-site-access:<label>`, refreshToken
//     `fake-site-refresh:<label>`, expiresAt null (the union returned no expiry);
//     `fake-site:days:<n>:<label>` (n a whole number 1–3650) → the same tokens, expiresAt =
//     clock.now() + n days;
//     anything else → rejects with an Error whose message quotes the code (so a leak of the
//     provider's error text is visible to the tests).
// - createSiteOAuthProviders(appEnv, clock, logger): what the admin entry injects: the fake in
//   local / test; in staging / prod no provider, announced once with a warn
//   `union_site_oauth_unconfigured` (no code, state or token is ever logged).
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { SiteOAuthProvider } from '../auth-expiry/reauth.ts';
import type { RegisteredPlatform } from '../domain/types.ts';

export type SiteOAuthProviders = Partial<Readonly<Record<RegisteredPlatform, SiteOAuthProvider>>>;

/** Only local / test may construct these providers. */
export function createFakeSiteOAuth(appEnv: string, clock: Clock): SiteOAuthProviders {
  void appEnv;
  void clock;
  throw new Error('NotImplemented: createFakeSiteOAuth');
}

/** The admin entry's providers: the fake in local / test, none elsewhere (one warn). */
export function createSiteOAuthProviders(
  appEnv: string,
  clock: Clock,
  logger: Pick<RootLogger, 'warn'>,
): SiteOAuthProviders {
  void appEnv;
  void clock;
  void logger;
  throw new Error('NotImplemented: createSiteOAuthProviders');
}
