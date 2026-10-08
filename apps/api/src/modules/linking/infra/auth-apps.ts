// Application configuration references of the Taobao auth methods (BR-ID-17 细则「授权方式」: the
// state records which application each issued method uses; only server configuration, never a
// client-reported identifier). Only a reference is returned, never a key or secret.
import type { AppEnv } from '../../platform/index.ts';
import type {
  AuthClient,
  UnionAuthMethod,
  UnionAuthUrlOptions,
} from '../application/union-auth-url.ts';

export type UnionAuthApps = UnionAuthUrlOptions['authApps'];

/**
 * Synthetic references per environment for non-production environments. In prod there is no
 * union application yet: resolution fails, so auth-url answers 50001 and issues no state.
 * TODO(规划/11 §4.5): the real per-environment union application registry — blocked on 推广位 /
 * siteId 与联盟应用.
 */
export function createDemoUnionAuthApps(): UnionAuthApps {
  return {
    resolve(
      appId: string,
      environment: AppEnv,
      client: AuthClient,
      method: UnionAuthMethod,
    ): Promise<{ readonly ref: string }> {
      void appId;
      if (environment === 'prod') {
        return Promise.reject(new Error('linking: no union application configured for prod'));
      }
      return Promise.resolve({ ref: `demo/${environment}/taobao/${client}/${method}` });
    },
  };
}
