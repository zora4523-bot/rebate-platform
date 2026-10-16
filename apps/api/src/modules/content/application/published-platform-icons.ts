// The delivered platform marks of one app (F1-06y; contract ConfigPlatformIcons of GET /v1/config;
// 08 BR-TEXT-24 细则「发布与回滚」): only keys whose mark has a published version, each with the
// version's cleaned file url (platform mediaUrlOf over MEDIA_PUBLIC_BASE_URL), its SHA-256 and its
// number. Read from the database on every call, never cached: a publish, rollback or restore on
// the admin entry (another process) shows in the very next read. Keys outside enum
// platform_icon_key are not delivered. /v1/config itself is a later task.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { mediaUrlOf } from '../../platform/index.ts';
import { publishedIconRows } from '../infra/kysely-platform-icon-store.ts';
import { formatOf, isPlatformIconKey } from './platform-icon-reader.ts';

export interface PublishedPlatformIconOptions {
  readonly db: Kysely<DB>;
  readonly mediaPublicBaseUrl: string | undefined;
}

export type PublishedPlatformIcons = Partial<
  Record<Schema<'PlatformIconKey'>, Schema<'ConfigPlatformIcon'>>
>;

/** Bind the infrastructure options once; callers supply only the verified appId. No cache. */
export async function publishedPlatformIcons(
  options: PublishedPlatformIconOptions,
  appId: string,
): Promise<PublishedPlatformIcons> {
  const rows = await publishedIconRows(options.db, appId);
  const result: PublishedPlatformIcons = {};
  for (const row of rows) {
    if (!isPlatformIconKey(row.key)) continue;
    result[row.key] = {
      url: mediaUrlOf(options.mediaPublicBaseUrl, row.sha256, formatOf(row.format)),
      sha256: row.sha256,
      version: row.version,
    };
  }
  return result;
}
