import type { KeyObject } from 'node:crypto';
import type {
  AppEnv,
  Clock,
  RequestCheck,
  TokenPrincipal,
  JwtKeyConfig,
} from '../../platform/index.ts';

/** Local signing port; KMS sign(bytes) is deferred per B1-02h §9.5. */
export interface TokenKeyProvider {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
}

export interface TokenService {
  issueAccess(principal: TokenPrincipal): Promise<string>;
  /** jose ES256 only, local kid lookup, issuer/audience checked, Clock, zero tolerance; 10002. */
  verifyAccess(token: string): Promise<TokenPrincipal>;
  issueRefresh(): { token: string; hash: string; expireAt: Date };
}

/** Missing JWT configuration is allowed only in local/test; staging/prod reject at startup. */
export function createTokenKeyProvider(
  appEnv: AppEnv,
  config: JwtKeyConfig | null,
): Promise<TokenKeyProvider> {
  void appEnv;
  void config;
  throw new Error('NotImplemented: createTokenKeyProvider');
}

export function createTokenService(deps: { clock: Clock; keys: TokenKeyProvider }): TokenService {
  void deps;
  throw new Error('NotImplemented: createTokenService');
}

export interface SessionLookup {
  /** Each authenticated request reads its current session, scoped by app_id. */
  find(
    appId: string,
    sid: string,
  ): Promise<{
    revoked_at: Date | null;
  } | null>;
}

/** Stages ② and ③ after signature, before body validation, using the full contract auth table. */
export function createTokenCheck(deps: {
  tokens: TokenService;
  sessions: SessionLookup;
}): RequestCheck {
  void deps;
  throw new Error('NotImplemented: createTokenCheck');
}
