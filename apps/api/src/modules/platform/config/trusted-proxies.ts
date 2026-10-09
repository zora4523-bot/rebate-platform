// TRUSTED_PROXIES (B1-03m): the gateways whose X-Forwarded-For entries the HTTP entries believe.
// Fastify's `trustProxy` receives the parsed list as is (bootstrap.ts), so `request.ip` is the
// rightmost address that is not a trusted proxy; unset or empty trusts no forwarded header.
import { isIP } from 'node:net';

export const TRUSTED_PROXIES_ENV = 'TRUSTED_PROXIES';

// Fixed text without digits: it must never echo (part of) the rejected value.
const PROBLEM =
  'TRUSTED_PROXIES: must be a comma-separated list of IP addresses or address/prefix-length ranges; hop counts, catch-all ranges, range names, netmasks and empty items are not accepted';

const PREFIX = /^(?:0|[1-9]\d{0,2})$/;

function validItem(item: string): boolean {
  const slash = item.indexOf('/');
  const address = slash === -1 ? item : item.slice(0, slash);
  // Zone ids (`fe80::1%eth0`) are not understood by Fastify's address matcher.
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (slash === -1) return true;
  const prefix = item.slice(slash + 1);
  if (!PREFIX.test(prefix)) return false;
  const length = Number(prefix);
  return length >= 1 && length <= (family === 4 ? 32 : 128);
}

/** Parses TRUSTED_PROXIES; unset or empty is `[]` (no forwarded header is trusted). */
export function readTrustedProxies(env: Readonly<Record<string, string | undefined>>): {
  readonly trustedProxies: readonly string[];
  readonly problems: readonly string[];
} {
  const raw = env[TRUSTED_PROXIES_ENV];
  if (raw === undefined || raw === '') return { trustedProxies: [], problems: [] };
  const items = raw.split(',').map((item) => item.trim());
  if (!items.every(validItem)) return { trustedProxies: [], problems: [PROBLEM] };
  return { trustedProxies: items, problems: [] };
}
