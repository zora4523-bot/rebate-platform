// F1-02b public read port. Contract and refresh semantics are recorded in
// test/spec/content/read/kit.ts; this phase supplies only a NotImplemented skeleton.
import type { ClientPlatform } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../platform/index.ts';

export interface ContentReaderOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

export interface ContentConfig {
  readonly value: DB['config_items']['value'];
  readonly version: number;
}

export interface ContentReader {
  minSupportedVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string,
  ): Promise<string | null>;
  configValue(appId: string, key: string): Promise<ContentConfig | null>;
}

export function createContentReader(options: ContentReaderOptions): ContentReader {
  void options;
  throw new Error('NotImplemented: createContentReader');
}
