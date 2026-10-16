// Parsing of the configuration values a commission quote reads (B2-03c). Every key is required
// when used: a missing entry or a malformed value throws, never a default (module AGENTS.md
// hard rule 5). Values are config_items JSON; basis points are safe integers in 0..10000.
import { platform as PLATFORM_CODES, type components } from '@couli/contracts-ts';

type PlatformCode = components['schemas']['PlatformCode'];

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(PLATFORM_CODES);

function malformed(key: string): never {
  throw new Error(`commission quote: config missing or malformed (${key})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A basis-point config value: a safe integer in 0..10000, returned as bigint. */
export function bpConfig(value: unknown, key: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10000) {
    malformed(key);
  }
  return BigInt(value);
}

/** commission.platforms: a non-empty list of distinct contract platform codes. */
export function platformsConfig(value: unknown, key: string): readonly PlatformCode[] {
  if (!Array.isArray(value) || value.length === 0) malformed(key);
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || !KNOWN_PLATFORMS.has(entry) || seen.has(entry)) {
      malformed(key);
    }
    seen.add(entry);
  }
  return [...seen] as PlatformCode[];
}

/** tech_fee_bp: an object keyed by platform; the quoted platform's own entry must be present. */
export function techFeeConfig(value: unknown, key: string, platform: string): bigint {
  if (!isRecord(value) || !Object.hasOwn(value, platform)) malformed(key);
  return bpConfig(value[platform], key);
}
