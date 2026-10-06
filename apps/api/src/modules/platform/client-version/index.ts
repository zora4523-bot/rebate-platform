// Client version comparison of 规划/08 BR-ID-01 细则「最低支持版本」(判定) and「受限会话」(签发):
// X-App-Version against app_versions.min_supported_version of the request's (X-Platform,
// X-Channel). Shared by identity's session scope (login / refresh, B1-02h) and the version gate
// ④a 10405 (B1-03c), so both read a version the same way.
//
// A version is MAJOR.MINOR.PATCH, each a decimal integer without leading zeros (semantic
// versioning 2.0.0 §2; no pre-release or build suffix: the contract's X-App-Version pattern has
// none). app_versions.min_supported_version has the same CHECK (db/schema.sql). A client version
// that is missing or not of that form is "not a valid semantic version": compareClientVersions
// answers null and the callers treat it as below the minimum (BR-ID-01 细则「判定」). Components
// of any length compare numerically.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// no NestJS, no `process.env`, no logging.
import type { ClientPlatform } from '@couli/contracts-ts';

const SEMANTIC_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Platforms judged against the minimum supported version (h5 and admin are not). */
const VERSION_GATED_PLATFORMS: ReadonlySet<string> = new Set<ClientPlatform>([
  'ios',
  'android',
  'harmony',
]);

/** True for ios, android and harmony: the platforms BR-ID-01 judges by min_supported_version. */
export function isVersionGatedPlatform(platform: string): boolean {
  return VERSION_GATED_PLATFORMS.has(platform);
}

function components(version: string): readonly [string, string, string] | null {
  const match = SEMANTIC_VERSION.exec(version);
  return match === null ? null : [match[1]!, match[2]!, match[3]!];
}

/** Numeric order of two decimal integers written without leading zeros. */
function compareNumbers(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Numeric major/minor/patch comparison of a client version with a minimum: -1 below, 0 equal,
 * 1 above; null when the client version is missing or malformed (callers treat null as below).
 * A malformed `minimum` is a configuration fault, not a client fault: it throws (fail closed).
 */
export function compareClientVersions(
  version: string | undefined,
  minimum: string,
): -1 | 0 | 1 | null {
  const floor = typeof minimum === 'string' ? components(minimum) : null;
  if (floor === null) throw new TypeError('minimum version must be MAJOR.MINOR.PATCH');
  const client = typeof version === 'string' ? components(version) : null;
  if (client === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumbers(client[index]!, floor[index]!);
    if (order !== 0) return order;
  }
  return 0;
}
