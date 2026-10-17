import type { Schema } from '@couli/contracts-ts';
import type { Clock } from '../../platform/index.ts';
import type { PagePointer, PageViewer } from '../domain/pages/select/index.ts';

export interface PageVersion {
  readonly status: string;
  readonly sections: readonly Record<string, unknown>[];
}

export interface PageStore {
  pointer(appId: string, pageKey: string): Promise<PagePointer | null>;
  version(appId: string, pageKey: string, version: number): Promise<PageVersion | null>;
}

export class PageReader {
  constructor(store: PageStore | null, clock: Clock) {
    void store;
    void clock;
    throw new Error('NotImplemented: PageReader');
  }

  async read(
    appId: string,
    pageKey: string,
    deviceId: string | null,
    viewer: PageViewer,
  ): Promise<Schema<'Page'> | null> {
    void appId;
    void pageKey;
    void deviceId;
    void viewer;
    throw new Error('NotImplemented: PageReader.read');
  }
}
