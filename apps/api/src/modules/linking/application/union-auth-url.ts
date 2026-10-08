import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AppEnv, Clock, HandlerResult } from '../../platform/index.ts';
import type { CallerContext, LinkingConfigReader } from '../ports.ts';

export type AuthClient = 'ios' | 'android' | 'harmony';
export type UnionAuthMethod = components['schemas']['AuthMethod'];

export interface UnionAuthUrlInput {
  readonly platform: 'taobao' | 'pdd';
  readonly reportedClient: AuthClient;
  readonly installed?: components['schemas']['InstalledState'];
  readonly traceId: string;
}

export interface UnionAuthUrlOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  readonly config: LinkingConfigReader;
  readonly appEnv: AppEnv;
  /** Server-owned application configuration references, scoped to the issuing environment. */
  readonly authApps: {
    resolve(
      appId: string,
      environment: AppEnv,
      client: AuthClient,
      method: UnionAuthMethod,
    ): Promise<{ readonly ref: string }>;
  };
}

export interface UnionAuthUrlService {
  get(input: UnionAuthUrlInput): Promise<HandlerResult>;
}

export function createUnionAuthUrl(options: UnionAuthUrlOptions): UnionAuthUrlService {
  void options;
  throw new Error('NotImplemented: createUnionAuthUrl');
}
