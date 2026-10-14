import type { PddAuthLinkOpenOptions } from './link-open-pdd-auth.ts';
import type { UnionBindingsOptions, UnionBindingsService } from './union-bindings.ts';

/** B1-06x: list refreshes the self_buy PDD filing; bind retains its existing contract. */
export type PddQueryBindingsOptions = UnionBindingsOptions &
  Pick<PddAuthLinkOpenOptions, 'registry' | 'pids' | 'attrCodes' | 'config' | 'appEnv'>;

export function createUnionBindingsWithPddQuery(
  options: PddQueryBindingsOptions,
): UnionBindingsService {
  void options;
  throw new Error('NotImplemented: createUnionBindingsWithPddQuery');
}
