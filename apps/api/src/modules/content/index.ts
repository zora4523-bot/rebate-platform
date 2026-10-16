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
// F1-06w: the admin console's platform mark reads, loaded by app.module on the admin entry only.
export { ContentAdminModule } from './content-admin.module.ts';
export { publishedPlatformIcons } from './application/published-platform-icons.ts';
export type {
  PublishedPlatformIconOptions,
  PublishedPlatformIcons,
} from './application/published-platform-icons.ts';
// F1-02c: GET /v1/config, loaded by app.module on the api entry only with identity's viewer.
export { ContentPublicModule } from './content-public.module.ts';
export type { ContentPublicPorts } from './content-public.module.ts';

export interface ContentReaderOptions {
  /** Primary handle (ADR-0001 §4.2 #11); the reader only reads. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

/**
 * A reader with its own cache. Its answers may be up to one cache lifetime old, so it is for
 * read paths only and never for validating a write (an admin save, for example, checks inside its
 * transaction by reading the table directly). Wire it as a singleton: one reader per process,
 * shared by every caller.
 */
export function createContentReader(options: ContentReaderOptions): ContentReader {
  return new CachedContentReader(createKyselyContentStore(options.db), options.clock);
}
