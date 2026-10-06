import type {
  BaseRecord,
  DataProvider,
  GetListParams,
  GetListResponse,
  Pagination,
} from '@refinedev/core';

export interface AdminApiErrorDetails {
  readonly code: number;
  readonly msg: string;
  readonly data: unknown;
  readonly httpStatus: number;
  readonly traceId?: string;
  readonly kind: 'api' | 'network' | 'parse' | 'http' | 'request';
  readonly retryAfterSeconds?: number;
}

/** Local codes: -1 network, -2 parse; server codes are preserved verbatim. */
export class AdminApiError extends Error {
  readonly code!: number;
  readonly msg!: string;
  readonly data!: unknown;
  readonly httpStatus!: number;
  readonly traceId?: string;
  readonly kind!: AdminApiErrorDetails['kind'];
  readonly retryAfterSeconds?: number;

  constructor(details: AdminApiErrorDetails) {
    super('Admin API error');
    void details;
    throw new Error('NotImplemented: AdminApiError');
  }
}

export interface DataProviderOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly getToken: () => string | null;
  readonly onError: (error: AdminApiError) => void;
}

/** Refine 5 uses currentPage; current also accepts the task's pagination spelling. */
export interface AdminPagination extends Pagination {
  readonly current?: number;
}

export type AdminDataProvider = Omit<DataProvider, 'getList' | 'custom'> & {
  getList<TData extends BaseRecord = BaseRecord>(
    params: Omit<GetListParams, 'pagination'> & { pagination?: AdminPagination },
  ): Promise<GetListResponse<TData>>;
  custom: NonNullable<DataProvider['custom']>;
};

export function createDataProvider(options: DataProviderOptions): AdminDataProvider {
  void options;
  throw new Error('NotImplemented: createDataProvider');
}
