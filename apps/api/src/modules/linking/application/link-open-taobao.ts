import type { LinkOpenService } from './link-open.ts';
import type { WiredLinkOpenOptions } from './link-open-wiring.ts';
import type { UnionAuthUrlOptions } from './union-auth-url.ts';

/** B1-06f: composition boundary; authorization must not enter the shared requote core. */
export type TaobaoLinkOpenOptions = WiredLinkOpenOptions &
  Pick<UnionAuthUrlOptions, 'appEnv' | 'authApps'>;

export function createTaobaoLinkOpen(options: TaobaoLinkOpenOptions): LinkOpenService {
  void options;
  throw new Error('NotImplemented: createTaobaoLinkOpen');
}
