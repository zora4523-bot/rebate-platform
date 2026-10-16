// Fake third-party identity adapter of the ThirdPartyIdentityPort (BR-ID-04; orchestrator ruling
// B1-02d §9.3 #6, D6). Skeleton of the rule-test stage: the implementation is B1-02d's.
//
// - createFakeThirdPartyIdentity: local and test only (any other APP_ENV throws, like the fake SMS
//   sender). It reads only its own credential convention and imitates no provider's messages:
//   `fake:<provider>:<identity>` (WeChat `code`; Apple `identity_token` and `authorization_code`
//   with the same identity, otherwise invalid; Huawei `authorization_code`) answers that identity
//   as union_id (Apple also a fresh refresh token); the reserved identities `invalid`,
//   `unavailable` and `no-union` answer invalid, unavailable and an answer without union_id; a
//   convention value of another provider is invalid; anything else is unavailable.
// - createThirdPartyIdentity: what the entry injects as IdentityModuleOptions.thirdPartyIdentity:
//   the fake in local / test; in staging / prod null (the logins answer 50305), announced once with
//   a warn `third_party_identity_unconfigured`. Nothing else is logged: no credential, no identity.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { RootLogger } from '../../platform/index.ts';
import type { ThirdPartyIdentityPort } from '../application/step-up.ts';

/** Only local / test may construct this adapter. */
export function createFakeThirdPartyIdentity(appEnv: string): ThirdPartyIdentityPort {
  void appEnv;
  throw new Error('NotImplemented: createFakeThirdPartyIdentity');
}

/** The entry's port: the fake in local / test, null elsewhere (one warn when null). */
export function createThirdPartyIdentity(
  appEnv: string,
  logger: Pick<RootLogger, 'warn'>,
): ThirdPartyIdentityPort | null {
  void appEnv;
  void logger;
  throw new Error('NotImplemented: createThirdPartyIdentity');
}
