import type { ClientPlatform } from '@couli/contracts-ts';

// Platforms judged against app_versions.min_supported_version (08 BR-ID-01 细则「最低支持版本的
// 接口层拦截」, 判定). Requests from every other platform (h5, admin) are not judged.
const VERSION_GATED_PLATFORMS: ReadonlySet<ClientPlatform> = new Set<ClientPlatform>([
  'ios',
  'android',
  'harmony',
]);

/** Whether requests from `platform` are subject to the minimum supported version. */
export function isVersionGatedPlatform(platform: ClientPlatform): boolean {
  return VERSION_GATED_PLATFORMS.has(platform);
}
