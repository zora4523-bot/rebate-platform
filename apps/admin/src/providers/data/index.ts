// Refine data provider for the admin REST API (规划/03 §9.1, contracts/openapi.yaml /admin/v1):
// every response is the {code, msg, data} envelope; success is HTTP 200 and code === 0. Lists use
// page / page_size (≤200). Requests carry `Authorization: Bearer <admin_token>` and, for step-up
// operations, `X-Step-Up-Token`; no App headers or signature. Every failure becomes an
// AdminApiError handed once to `onError` (the unified error handling) and then rethrown.
import type {
  BaseRecord,
  CustomParams,
  CustomResponse,
  DataProvider,
  GetListParams,
  GetListResponse,
  GetOneParams,
  GetOneResponse,
  MetaQuery,
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

/** Local (negative) codes; server codes are preserved verbatim. */
export const LOCAL_ERROR_CODES = {
  network: -1,
  parse: -2,
  /** Envelope said code 0 but the HTTP status was not 200. */
  http: -3,
  /** Rejected before sending (address outside /admin/v1, unsupported call). */
  request: -4,
} as const;

/**
 * `msg` of local errors is a stable key, not copy (规划/03 §10.3): the unified error handler maps
 * it (and `kind`) to dictionary text; server errors keep the server's `msg`.
 */
const LOCAL_MESSAGES = {
  network: 'admin_api.network_error',
  parse: 'admin_api.parse_error',
  http: 'admin_api.http_error',
} as const;

/** Retry-After default for 42901 when the header is missing or unreadable (error-codes.yaml). */
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const RATE_LIMITED_CODE = 42901;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;
const API_PREFIX = '/admin/v1';

/** Local codes: -1 network, -2 parse, -3 http, -4 request; server codes are preserved verbatim. */
export class AdminApiError extends Error {
  readonly code: number;
  readonly msg: string;
  readonly data: unknown;
  readonly httpStatus: number;
  readonly traceId?: string;
  readonly kind: AdminApiErrorDetails['kind'];
  readonly retryAfterSeconds?: number;

  constructor(details: AdminApiErrorDetails) {
    super(details.msg === '' ? `Admin API error ${details.code}` : details.msg);
    this.name = 'AdminApiError';
    this.code = details.code;
    this.msg = details.msg;
    this.data = details.data;
    this.httpStatus = details.httpStatus;
    this.kind = details.kind;
    if (details.traceId !== undefined) this.traceId = details.traceId;
    if (details.retryAfterSeconds !== undefined) this.retryAfterSeconds = details.retryAfterSeconds;
  }

  /** Refine's HttpError reads `statusCode`. */
  get statusCode(): number {
    return this.httpStatus;
  }
}

export interface DataProviderOptions {
  /** Origin (and optional path prefix) that serves /admin/v1. */
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** Read on every request; null sends no Authorization header. */
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

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

interface AdminRequest {
  readonly url: URL;
  readonly method: HttpMethod;
  readonly body?: unknown;
  readonly meta?: MetaQuery | undefined;
}

function requestError(msg: string): AdminApiError {
  return new AdminApiError({
    kind: 'request',
    code: LOCAL_ERROR_CODES.request,
    msg,
    data: null,
    httpStatus: 0,
  });
}

/** Raw path text must not contain dot segments (plain or percent-encoded) or backslashes. */
function hasUnsafePathText(raw: string): boolean {
  const path = raw.split(/[?#]/, 1)[0] ?? '';
  if (path.includes('\\') || /%2e|%2f|%5c/i.test(path)) return true;
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function appendQuery(url: URL, query: unknown): void {
  if (query === undefined || query === null) return;
  if (typeof query !== 'object') throw requestError('query must be an object');
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue;
      url.searchParams.append(key, String(item));
    }
  }
}

function stepUpTokenOf(meta: MetaQuery | undefined): string | undefined {
  const token: unknown = meta?.['stepUpToken'];
  return typeof token === 'string' && token !== '' ? token : undefined;
}

function headerTraceId(response: Response, body: unknown): string | undefined {
  const header = response.headers.get('X-Trace-Id');
  if (header !== null && header !== '') return header;
  if (typeof body === 'object' && body !== null && 'trace_id' in body) {
    return typeof body.trace_id === 'string' ? body.trace_id : undefined;
  }
  return undefined;
}

/** Retry-After as delta-seconds or an HTTP date; missing or unreadable → 5 seconds. */
function retryAfterSeconds(response: Response): number {
  const header = response.headers.get('Retry-After')?.trim();
  if (header === undefined || header === '') return DEFAULT_RETRY_AFTER_SECONDS;
  if (/^\d+$/.test(header)) return Number(header);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

interface Envelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['code'] === 'number' &&
    Number.isInteger(record['code']) &&
    typeof record['msg'] === 'string'
  );
}

export function createDataProvider(options: DataProviderOptions): AdminDataProvider {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('createDataProvider: baseUrl must be http(s)');
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  const apiRoot = `${base.origin}${basePath}${API_PREFIX}`;

  /** Resolves a Refine URL (relative to the origin, or absolute) and keeps it under /admin/v1/. */
  function resolveUrl(raw: string): URL {
    if (hasUnsafePathText(raw)) throw requestError('address outside /admin/v1');
    let url: URL;
    try {
      url =
        raw.startsWith('/') && !raw.startsWith('//')
          ? new URL(`${basePath}${raw}`, base)
          : new URL(raw);
    } catch {
      throw requestError('address outside /admin/v1');
    }
    if (
      url.origin !== base.origin ||
      url.username !== '' ||
      url.password !== '' ||
      !url.pathname.startsWith(`${basePath}${API_PREFIX}/`)
    ) {
      throw requestError('address outside /admin/v1');
    }
    url.hash = '';
    return url;
  }

  /** Resource names are plain path segments ("admins", "admins/sessions"). */
  function resourceUrl(resource: string, id?: string): URL {
    const segments = resource.split('/');
    if (!segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))) {
      throw requestError('invalid resource name');
    }
    const suffix = id === undefined ? '' : `/${encodeURIComponent(id)}`;
    return resolveUrl(`${API_PREFIX}/${segments.join('/')}${suffix}`);
  }

  async function send(request: AdminRequest): Promise<unknown> {
    const headers = new Headers({ Accept: 'application/json' });
    const token = options.getToken();
    if (token !== null && token !== '') headers.set('Authorization', `Bearer ${token}`);
    const stepUpToken = stepUpTokenOf(request.meta);
    if (stepUpToken !== undefined) headers.set('X-Step-Up-Token', stepUpToken);
    let body: string | undefined;
    if (request.body !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(request.body);
    }

    let response: Response;
    try {
      response = await options.fetch(request.url.toString(), {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: 'omit',
      });
    } catch (cause) {
      throw new AdminApiError({
        kind: 'network',
        code: LOCAL_ERROR_CODES.network,
        msg: LOCAL_MESSAGES.network,
        data: cause instanceof Error ? cause.message : null,
        httpStatus: 0,
      });
    }

    const parseError = (): AdminApiError =>
      new AdminApiError({
        kind: 'parse',
        code: LOCAL_ERROR_CODES.parse,
        msg: LOCAL_MESSAGES.parse,
        data: null,
        httpStatus: response.status,
        ...withTrace(headerTraceId(response, undefined)),
      });

    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      throw parseError();
    }
    if (!isEnvelope(parsed)) throw parseError();
    const traceId = headerTraceId(response, parsed);

    if (parsed.code !== 0) {
      throw new AdminApiError({
        kind: 'api',
        code: parsed.code,
        msg: parsed.msg,
        data: parsed.data,
        httpStatus: response.status,
        ...withTrace(traceId),
        ...(parsed.code === RATE_LIMITED_CODE
          ? { retryAfterSeconds: retryAfterSeconds(response) }
          : {}),
      });
    }
    if (response.status !== 200) {
      throw new AdminApiError({
        kind: 'http',
        code: LOCAL_ERROR_CODES.http,
        msg: LOCAL_MESSAGES.http,
        data: parsed.data,
        httpStatus: response.status,
        ...withTrace(traceId),
      });
    }
    return parsed.data;
  }

  /** Every failure (including requests rejected before sending) goes to onError exactly once. */
  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      const error =
        cause instanceof AdminApiError
          ? cause
          : requestError(cause instanceof Error ? cause.message : 'request failed');
      try {
        options.onError(error);
      } catch {
        // The unified handler must not replace the original error.
      }
      throw error;
    }
  }

  const unsupported = (operation: string) => () =>
    run<never>(() =>
      Promise.reject(requestError(`${operation} is not in the /admin/v1 contract yet`)),
    );

  return {
    getApiUrl: () => apiRoot,

    getList<TData extends BaseRecord = BaseRecord>(
      params: Omit<GetListParams, 'pagination'> & { pagination?: AdminPagination },
    ): Promise<GetListResponse<TData>> {
      return run(async () => {
        if ((params.filters?.length ?? 0) > 0 || (params.sorters?.length ?? 0) > 0) {
          throw requestError('filters and sorters are not in the /admin/v1 list contract');
        }
        const url = resourceUrl(params.resource);
        const pagination = params.pagination;
        const page = positiveInteger(pagination?.currentPage ?? pagination?.current, 1);
        const pageSize = Math.min(
          positiveInteger(pagination?.pageSize, DEFAULT_PAGE_SIZE),
          MAX_PAGE_SIZE,
        );
        url.searchParams.set('page', String(page));
        url.searchParams.set('page_size', String(pageSize));
        const data = await send({ url, method: 'GET', meta: params.meta });
        if (
          typeof data !== 'object' ||
          data === null ||
          !Array.isArray((data as { items?: unknown }).items) ||
          typeof (data as { total?: unknown }).total !== 'number'
        ) {
          throw new AdminApiError({
            kind: 'parse',
            code: LOCAL_ERROR_CODES.parse,
            msg: LOCAL_MESSAGES.parse,
            data: null,
            httpStatus: 200,
          });
        }
        const list = data as { items: TData[]; total: number };
        return { data: list.items, total: list.total };
      });
    },

    getOne<TData extends BaseRecord = BaseRecord>(
      params: GetOneParams,
    ): Promise<GetOneResponse<TData>> {
      return run(async () => {
        const id = String(params.id);
        if (id === '') throw requestError('missing id');
        const data = await send({
          url: resourceUrl(params.resource, id),
          method: 'GET',
          meta: params.meta,
        });
        return { data: data as TData };
      });
    },

    custom<TData extends BaseRecord = BaseRecord, TQuery = unknown, TPayload = unknown>(
      params: CustomParams<TQuery, TPayload>,
    ): Promise<CustomResponse<TData>> {
      return run(async () => {
        if ((params.filters?.length ?? 0) > 0 || (params.sorters?.length ?? 0) > 0) {
          throw requestError('filters and sorters are not in the /admin/v1 contract');
        }
        const url = resolveUrl(params.url);
        appendQuery(url, params.query);
        const method = params.method.toUpperCase() as HttpMethod;
        const data = await send({ url, method, body: params.payload, meta: params.meta });
        return { data: data as TData };
      });
    },

    create: unsupported('create'),
    update: unsupported('update'),
    deleteOne: unsupported('deleteOne'),
  };
}

function withTrace(traceId: string | undefined): { traceId?: string } {
  return traceId === undefined ? {} : { traceId };
}
