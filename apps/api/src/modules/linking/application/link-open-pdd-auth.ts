import type { LinkOpenService } from './link-open.ts';
import type { WiredLinkOpenOptions } from './link-open-wiring.ts';
import type { UnionAuthUrlOptions } from './union-auth-url.ts';

export type PddAuthLinkOpenOptions = WiredLinkOpenOptions & Pick<UnionAuthUrlOptions, 'appEnv'>;

export function createPddAuthLinkOpen(options: PddAuthLinkOpenOptions): LinkOpenService {
  void options;
  throw new Error('NotImplemented: createPddAuthLinkOpen');
}
