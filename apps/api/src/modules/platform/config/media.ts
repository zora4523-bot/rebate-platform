// Media public base URL (F1-06z; 08 BR-TEXT-24 细则: OSS `media` bucket, file named by the content
// SHA-256), consumed only through loadConfig(env):
// MEDIA_PUBLIC_BASE_URL: the https base under which every stored media file is served as
//   `<base>/<sha256>.<svg|png>` (platform/media mediaUrlOf). Absolute https URL with a host, no
//   query, fragment, credentials or whitespace; trailing slashes are allowed (mediaUrlOf drops
//   them). An empty string counts as unset.
// Unset: local / test use MEDIA_DEFAULT_LOCAL_BASE_URL (a reserved `.invalid` host); staging /
// prod stay valid (no configuration problem, no startup refusal) and every media write or URL
// derivation fails per request with 50001 until the value and the OSS adapter are provided.
// No problem text contains the configured value.
// Erasable syntax only (this directory is also compiled by the `test` project).
import type { AppEnv } from './app-env.ts';

export const MEDIA_ENV_NAME = 'MEDIA_PUBLIC_BASE_URL';

/** Base URL used by local / test when MEDIA_PUBLIC_BASE_URL is unset (RFC 2606 `.invalid`). */
export const MEDIA_DEFAULT_LOCAL_BASE_URL = 'https://media.local.invalid';

const PROBLEM =
  'MEDIA_PUBLIC_BASE_URL: must be an absolute https URL with a host (no query, fragment, credentials or whitespace)';

function isMediaBaseUrl(raw: string): boolean {
  if (!raw.startsWith('https://')) return false;
  if (/[\s?#\\]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  );
}

/**
 * Parses MEDIA_PUBLIC_BASE_URL. `mediaPublicBaseUrl` is the configured value as given, the local /
 * test default when unset there, or undefined when unset in staging / prod (or APP_ENV is invalid).
 */
export function readMediaConfig(
  appEnv: AppEnv | undefined,
  env: Readonly<Record<string, string | undefined>>,
): { readonly mediaPublicBaseUrl: string | undefined; readonly problems: readonly string[] } {
  const raw = env[MEDIA_ENV_NAME];
  if (raw === undefined || raw === '') {
    const local = appEnv === 'local' || appEnv === 'test';
    return { mediaPublicBaseUrl: local ? MEDIA_DEFAULT_LOCAL_BASE_URL : undefined, problems: [] };
  }
  return isMediaBaseUrl(raw)
    ? { mediaPublicBaseUrl: raw, problems: [] }
    : { mediaPublicBaseUrl: undefined, problems: [PROBLEM] };
}
