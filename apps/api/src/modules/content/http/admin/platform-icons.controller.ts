import type { Schema } from '@couli/contracts-ts';
import type { AdminOperationGuard, CheckedRequest } from '../../../platform/index.ts';
import type {
  PlatformIconPageQuery,
  PlatformIconReader,
} from '../../application/platform-icon-reader.ts';

export interface PlatformIconsRequest extends CheckedRequest {
  readonly id: string;
}

/** Decorators and admin-only registration belong to the implementation phase. */
export class AdminPlatformIconsController {
  constructor(guard: AdminOperationGuard, reader: PlatformIconReader) {
    void guard;
    void reader;
    throw new Error('NotImplemented: AdminPlatformIconsController');
  }

  list(request: PlatformIconsRequest): Promise<Schema<'AdminPlatformIconListResponse'>> {
    void request;
    throw new Error('NotImplemented: AdminPlatformIconsController.list');
  }

  versions(
    request: PlatformIconsRequest,
    key: string,
    query: PlatformIconPageQuery,
  ): Promise<Schema<'AdminPlatformIconVersionPageResponse'>> {
    void request;
    void key;
    void query;
    throw new Error('NotImplemented: AdminPlatformIconsController.versions');
  }
}
