import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PublishedPlatformIconOptions {
  readonly db: Kysely<DB>;
  readonly mediaPublicBaseUrl: string | undefined;
}

export type PublishedPlatformIcons = Partial<
  Record<Schema<'PlatformIconKey'>, Schema<'ConfigPlatformIcon'>>
>;

/** Bind the infrastructure options once; callers supply only the verified appId. No cache. */
export function publishedPlatformIcons(
  options: PublishedPlatformIconOptions,
  appId: string,
): Promise<PublishedPlatformIcons> {
  void options;
  void appId;
  throw new Error('NotImplemented: publishedPlatformIcons');
}
