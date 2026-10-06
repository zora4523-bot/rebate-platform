import type { ClientPlatform } from '@couli/contracts-ts';
import type { TokenPrincipal } from '../../platform/index.ts';

export interface MinimumVersionReader {
  minSupportedVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string,
  ): Promise<string | null>;
}

/** Re-evaluated at every login and refresh, with this request's client headers. */
export function sessionScope(
  input: { appId: string; platform: ClientPlatform; channel?: string; version?: string },
  versions: MinimumVersionReader,
): Promise<TokenPrincipal['scp']> {
  void input;
  void versions;
  throw new Error('NotImplemented: sessionScope');
}
