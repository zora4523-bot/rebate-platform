// Public surface of the content module; other modules import only from this file.
// Task F1-02b: read-only entry for the minimum supported version (app_versions, by platform and
// channel) and for business configuration (config_items, cached, with its version). The
// contract and refresh semantics are recorded in test/spec/content/read/kit.ts. Writes, HTTP
// routes and the version comparison belong to later tasks.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../platform/index.ts';
import { CachedContentReader, type ContentReader } from './application/content-reader.ts';
import { createKyselyContentStore } from './infra/kysely-content-store.ts';

export type { ConfigValue, ContentConfig, ContentReader } from './application/content-reader.ts';

export interface ContentReaderOptions {
  /** Primary handle (ADR-0001 §4.2 #11); the reader only reads. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

/** A reader with its own cache: create one per process and share it. */
export function createContentReader(options: ContentReaderOptions): ContentReader {
  return new CachedContentReader(createKyselyContentStore(options.db), options.clock);
}
