import type { Schema } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { DictStore } from './dict-reader.ts';

/** F1-02zd: uncached console read; defaults are loaded on use, store reads one snapshot. */
export class AdminDictReader {
  constructor(
    store: DictStore | null,
    defaults: () => Readonly<Record<string, string>>,
    logger: Pick<Logger, 'warn'>,
  ) {
    void store;
    void defaults;
    void logger;
    throw new Error('NotImplemented: AdminDictReader');
  }

  read(appId: string): Promise<Schema<'AdminDict'>> {
    void appId;
    throw new Error('NotImplemented: AdminDictReader.read');
  }
}
