// Public surface of the content module; other modules import only from this file.
// Task F1-02b: read-only entry for the minimum supported version (app_versions, by platform and
// channel) and for business configuration (config_items, cached, with its version).
// F1-02e adds whole version rows using the same cache as the minimum-version reads.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../platform/index.ts';
import { CachedContentReader, type ContentReader } from './application/content-reader.ts';
import { createKyselyContentStore } from './infra/kysely-content-store.ts';

export type { ConfigValue, ContentConfig, ContentReader } from './application/content-reader.ts';
// F1-10b: emergency switch registry (规划/04 §10.2) and the switch read cache lifetime.
export { switchRegistry, switchSpecOf } from './domain/switch-registry.ts';
export type {
  SwitchDefault,
  SwitchPermission,
  SwitchSpec,
  SwitchValueType,
} from './domain/switch-registry.ts';
export { SWITCH_CACHE_TTL_MS, switchCacheTtlMs } from './domain/cache-policy.ts';
export type { AppVersionRow } from './domain/app-version.ts';
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
export { InviteRewardBudgetReader } from './application/invite-reward-budget-reader.ts';
export { createAgreementReader } from './application/agreement-reader.ts';
export type {
  AgreementReader,
  AgreementReaderOptions,
  CurrentAgreement,
} from './application/agreement-reader.ts';
export { agreementTextUrl } from './domain/agreements/text-url.ts';
export type { AgreementType } from './domain/agreements/index.ts';
// F1-09g: the cross-module reads app.module assembles for the page audience facts.
export type { AudienceUnionPlatform, PageAudienceReads } from './application/page-audience.ts';
export { createSystemSwitchWriter } from './application/system-switch-writer.ts';
export type {
  SystemSwitchInput,
  SystemSwitchResult,
  SystemSwitchWriter,
  SystemSwitchWriterOptions,
} from './application/system-switch-writer.ts';

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
  const store = createKyselyContentStore(options.db);
  return new CachedContentReader(store, options.clock, store);
}
