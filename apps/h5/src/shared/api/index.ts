import type { H5TokenManager } from '@couli/bridge-sdk';
import type { paths } from '@couli/contracts-ts';
import type { FetchOptions } from 'openapi-fetch';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type ApiPath<M extends ApiMethod> = {
  [P in keyof paths]: paths[P] extends Record<Lowercase<M>, object> ? P : never;
}[keyof paths];
type Operation<M extends ApiMethod, P extends ApiPath<M>> =
  paths[P] extends Record<Lowercase<M>, infer O> ? O : never;
type OptionsWithoutHeaders<O> = O extends { parameters: infer Params }
  ? Omit<O, 'parameters'> & { parameters: Omit<Params, 'header'> }
  : O;
export type ApiRequestOptions<M extends ApiMethod, P extends ApiPath<M>> = FetchOptions<
  OptionsWithoutHeaders<Operation<M, P>>
>;
type SuccessData<Responses> = {
  [Status in keyof Responses]: `${Status & (string | number)}` extends `2${string}`
    ? Responses[Status] extends { content: { 'application/json': { data: infer D } } }
      ? D
      : never
    : never;
}[keyof Responses];
export type ApiData<M extends ApiMethod, P extends ApiPath<M>> =
  Operation<M, P> extends { responses: infer Responses } ? SuccessData<Responses> : never;

export interface ApiClientOptions {
  baseUrl: string;
  /** Supplied by the caller; no brand, platform, signing or device defaults in this layer. */
  headers: () => HeadersInit | Promise<HeadersInit>;
  tokenManager?: H5TokenManager;
  fetch?: typeof globalThis.fetch;
}

export interface H5ApiClient {
  request<M extends ApiMethod, P extends ApiPath<M>>(
    method: M,
    path: P,
    options: ApiRequestOptions<M, P>,
  ): Promise<ApiData<M, P>>;
}

/** Contract action strings are metadata for the UI, not executable instructions. */
export class ApiError extends Error {
  declare readonly code: number;
  declare readonly msg: string;
  declare readonly data: unknown;
  declare readonly action: string;

  constructor(code: number, msg: string, data?: unknown) {
    super('NotImplemented: ApiError');
    void code;
    void msg;
    void data;
    throw new Error('NotImplemented: ApiError');
  }
}

/** openapi-fetch transport, with token-manager replay before business-envelope unwrapping. */
export function createApiClient(options: ApiClientOptions): H5ApiClient {
  void options;
  throw new Error('NotImplemented: createApiClient');
}
