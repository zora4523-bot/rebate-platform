import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';

export interface PlatformIconStore {
  icons(appId: string): Promise<readonly Selectable<DB['platform_icons']>[]>;
  versions(
    appId: string,
    key: Schema<'PlatformIconKey'>,
  ): Promise<readonly Selectable<DB['platform_icon_versions']>[]>;
}

export interface PlatformIconPageQuery {
  readonly page?: unknown;
  readonly page_size?: unknown;
}

/** F1-06w: admin read use cases; no cache, writes or audit. */
export class PlatformIconReader {
  constructor(store: PlatformIconStore, mediaPublicBaseUrl: string | undefined) {
    void store;
    void mediaPublicBaseUrl;
    throw new Error('NotImplemented: PlatformIconReader');
  }

  list(appId: string): Promise<Schema<'AdminPlatformIconList'>> {
    void appId;
    throw new Error('NotImplemented: PlatformIconReader.list');
  }

  versions(
    appId: string,
    key: string,
    query: PlatformIconPageQuery,
  ): Promise<Schema<'AdminPlatformIconVersionPage'>> {
    void appId;
    void key;
    void query;
    throw new Error('NotImplemented: PlatformIconReader.versions');
  }
}
