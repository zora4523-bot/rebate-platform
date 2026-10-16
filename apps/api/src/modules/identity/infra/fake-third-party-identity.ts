// Fake third-party identity adapter of the ThirdPartyIdentityPort (BR-ID-04; orchestrator ruling
// B1-02d §9.3 #6, D6).
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
import { randomBytes } from 'node:crypto';

/** Only local / test may construct this adapter. */
export function createFakeThirdPartyIdentity(appEnv: string): ThirdPartyIdentityPort {
  if (appEnv !== 'local' && appEnv !== 'test') {
    throw new Error('identity: fake third-party identity is local/test only');
  }
  return {
    exchange(input) {
      const credential = input.provider === 'wechat' ? input.code : input.authorization_code;
      if (!credential.startsWith('fake:')) return Promise.resolve({ unavailable: true });
      const prefix = `fake:${input.provider}:`;
      if (!credential.startsWith(prefix)) return Promise.resolve({ invalid: true });
      if (input.provider === 'apple' && input.identity_token !== credential) {
        return Promise.resolve({ invalid: true });
      }
      const identity = credential.slice(prefix.length);
      if (identity === 'unavailable') return Promise.resolve({ unavailable: true });
      if (identity === '' || identity === 'invalid') return Promise.resolve({ invalid: true });
      // Empty identity deliberately exercises the application's malformed-provider response.
      if (identity === 'no-union') return Promise.resolve({ union_id: '' });
      return Promise.resolve({
        union_id: identity,
        ...(input.provider === 'wechat' ? { open_id: `fake-open:${identity}` } : {}),
        ...(input.provider === 'apple'
          ? { apple_refresh_token: `fake-refresh:${randomBytes(32).toString('hex')}` }
          : {}),
      });
    },
  };
}

/** The entry's port: the fake in local / test, null elsewhere (one warn when null). */
export function createThirdPartyIdentity(
  appEnv: string,
  logger: Pick<RootLogger, 'warn'>,
): ThirdPartyIdentityPort | null {
  if (appEnv === 'local' || appEnv === 'test') return createFakeThirdPartyIdentity(appEnv);
  logger.warn('third_party_identity_unconfigured');
  return null;
}
