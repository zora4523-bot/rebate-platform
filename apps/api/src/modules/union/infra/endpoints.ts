// Per-platform endpoint configuration: config/union-endpoints/<platform>.json (规划/02 §6.2
// 录制回放; 规划/09 §0.2 硬规则 3). A file holds only the mode, the base URL and the quota bucket
// key; secrets never live in it, and a key outside the four known ones is rejected. In prod every
// platform must be `live`: a demo or replay endpoint stops the whole set.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRegisteredPlatform,
  REGISTERED_PLATFORMS,
  UnionError,
  type UnionEndpoint,
  type UnionEnvironment,
  type UnionMode,
} from '../domain/types.ts';

const ENVIRONMENTS: readonly UnionEnvironment[] = ['local', 'test', 'staging', 'prod'];
const MODES: readonly UnionMode[] = ['demo', 'replay', 'live'];
const KEYS = new Set(['platform', 'mode', 'baseUrl', 'quotaKey']);

function invalid(message: string): UnionError {
  return new UnionError('invalid_endpoint', message);
}

function parseBaseUrl(mode: UnionMode, value: unknown, where: string): string | null {
  if (mode === 'demo') {
    if (value !== null) throw invalid(`${where}.baseUrl must be null in demo mode`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${where}.baseUrl is required in ${mode} mode`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`${where}.baseUrl is not an absolute URL`);
  }
  const protocols = mode === 'live' ? ['https:'] : ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) {
    throw invalid(`${where}.baseUrl must use ${protocols.join(' or ')} in ${mode} mode`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw invalid(`${where}.baseUrl must not carry credentials, a query or a fragment`);
  }
  return value;
}

function parseEndpoint(value: unknown, index: number): UnionEndpoint {
  const where = `union-endpoints[${String(index)}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${where} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) {
    // Names only: a misplaced secret value must never reach an error message or a log.
    throw invalid(`${where} has unsupported keys: ${unknown.join(', ')}`);
  }
  const { platform, mode, quotaKey } = record;
  if (!isRegisteredPlatform(platform)) throw invalid(`${where}.platform is not registered`);
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
    throw invalid(`${where}.mode must be one of ${MODES.join(', ')}`);
  }
  if (typeof quotaKey !== 'string' || quotaKey.trim() === '') {
    throw invalid(`${where}.quotaKey must be a non-empty string`);
  }
  const typedMode = mode as UnionMode;
  return Object.freeze({
    platform,
    mode: typedMode,
    baseUrl: parseBaseUrl(typedMode, record['baseUrl'], where),
    quotaKey,
  });
}

/** Rejects incomplete or duplicate sets and prod demo/replay. No network or environment reads. */
export function parseUnionEndpoints(
  input: unknown,
  environment: UnionEnvironment,
): readonly UnionEndpoint[] {
  if (!ENVIRONMENTS.includes(environment)) throw invalid('Unknown environment');
  if (!Array.isArray(input)) throw invalid('Union endpoints must be an array');
  const endpoints = input.map((value: unknown, index) => parseEndpoint(value, index));
  const platforms = new Set(endpoints.map((endpoint) => endpoint.platform));
  if (
    endpoints.length !== REGISTERED_PLATFORMS.length ||
    platforms.size !== endpoints.length ||
    !REGISTERED_PLATFORMS.every((platform) => platforms.has(platform))
  ) {
    throw invalid(`Union endpoints must configure exactly ${REGISTERED_PLATFORMS.join(', ')}`);
  }
  if (environment === 'prod') {
    const unsafe = endpoints.filter((endpoint) => endpoint.mode !== 'live');
    if (unsafe.length > 0) {
      throw new UnionError(
        'unsafe_mode',
        `prod refuses to start with non-live union endpoints: ${unsafe
          .map((endpoint) => `${endpoint.platform}=${endpoint.mode}`)
          .join(', ')}`,
        unsafe[0]?.platform ?? null,
      );
    }
  }
  return Object.freeze(endpoints);
}

/** Reads <directory>/<platform>.json for each registered platform, then validates the set. */
export async function loadUnionEndpoints(
  directory: string,
  environment: UnionEnvironment,
): Promise<readonly UnionEndpoint[]> {
  const documents = await Promise.all(
    REGISTERED_PLATFORMS.map(async (platform) => {
      const file = `${platform}.json`;
      let document: unknown;
      try {
        document = JSON.parse(await readFile(join(directory, file), 'utf8'));
      } catch {
        throw invalid(`union-endpoints/${file} is missing or not valid JSON`);
      }
      const named =
        typeof document === 'object' && document !== null && !Array.isArray(document)
          ? (document as Record<string, unknown>)['platform']
          : undefined;
      if (named !== platform) {
        throw invalid(`union-endpoints/${file} must configure platform ${platform}`);
      }
      return document;
    }),
  );
  return parseUnionEndpoints(documents, environment);
}
