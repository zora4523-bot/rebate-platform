// The App's own personal information copies (task B1-27i; 规划/08 BR-ID-40 细则「在 App 内下载」;
// contract listMyDataCopies / getMyDataCopyDownload, CT-24q). Skeleton of the test stage: the rule
// tests in test/spec/identity/data-copies-download/** go through HTTP only, so these shapes are a
// starting point the implementation may change.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, ExportStore } from '../../platform/index.ts';

export interface MyDataCopySubject {
  readonly appId: string;
  readonly userId: string;
}

export interface MyDataCopyItem {
  readonly copyId: string;
  readonly status: 'ready' | 'delivered';
  readonly generatedAt: Date;
  readonly expiresAt: Date;
}

export type MyDataCopyDownloadResult =
  | { readonly kind: 'link'; readonly url: string; readonly urlExpiresAt: Date }
  | { readonly kind: 'not_found' };

export interface MyDataCopiesOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly store: ExportStore;
}

export interface MyDataCopies {
  list(subject: MyDataCopySubject): Promise<readonly MyDataCopyItem[]>;
  download(subject: MyDataCopySubject, copyId: string): Promise<MyDataCopyDownloadResult>;
}

export function createMyDataCopies(options: MyDataCopiesOptions): MyDataCopies {
  void options;
  throw new Error('NotImplemented: createMyDataCopies');
}
