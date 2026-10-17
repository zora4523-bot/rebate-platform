import type { Schema } from '@couli/contracts-ts';
import type { MaterialChannelsSpec } from '../../platform/index.ts';

/** F1-02h §9.2-3: caller supplies final data without config_version; returns a quoted strong tag. */
export function configEtag(data: Omit<Schema<'Config'>, 'config_version'>): string {
  void data;
  throw new Error('NotImplemented: configEtag');
}

/** F1-02h §9.2-4: comma-separated If-None-Match with weak comparison. */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  void header;
  void etag;
  throw new Error('NotImplemented: ifNoneMatchHits');
}

/** F1-02h §9.2-2: selectable platforms in PlatformCode order, without duplicates. */
export function rankPlatforms(spec: MaterialChannelsSpec): Schema<'PlatformCode'>[] {
  void spec;
  throw new Error('NotImplemented: rankPlatforms');
}
