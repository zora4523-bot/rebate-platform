// The session scope (scp) an access token is issued with (规划/08 BR-ID-07 细则「作用域 scp」,
// BR-ID-01 细则「受限会话」签发): judged again at every login (B1-02j) and refresh (B1-02k) from
// this request's X-Platform, X-Channel and X-App-Version — a refresh never inherits the previous
// token's scope. A client below the minimum supported version of its (platform, channel) gets
// deletion_only; at or above it, or when the request is not judged (h5 / admin, no X-Channel, no
// configured minimum), full. The comparison is platform/client-version's (shared with the version
// gate ④a of B1-03c): a missing or malformed X-App-Version counts as below.
// The minimum comes through MinimumVersionReader, implemented by content's reader (F1-02b) and
// assembled by app.module (IdentityModule's configuration port); a failed read rejects: it is
// never taken for "no minimum" (which would issue full).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { ClientPlatform } from '@couli/contracts-ts';
import {
  compareClientVersions,
  isVersionGatedPlatform,
  type TokenPrincipal,
} from '../../platform/index.ts';

export interface MinimumVersionReader {
  minSupportedVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string,
  ): Promise<string | null>;
}

/** Re-evaluated at every login and refresh, with this request's client headers. */
export async function sessionScope(
  input: { appId: string; platform: ClientPlatform; channel?: string; version?: string },
  versions: MinimumVersionReader,
): Promise<TokenPrincipal['scp']> {
  if (!isVersionGatedPlatform(input.platform)) return 'full';
  // A missing X-Channel reads as "no configured row" (§9.5 #9), never as some default channel.
  if (input.channel === undefined || input.channel === '') return 'full';
  const minimum = await versions.minSupportedVersion(input.appId, input.platform, input.channel);
  if (minimum === null) return 'full';
  const order = compareClientVersions(input.version, minimum);
  return order === null || order < 0 ? 'deletion_only' : 'full';
}
