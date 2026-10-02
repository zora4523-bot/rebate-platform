// TypeScript view of contracts/openapi.yaml: generated types plus a typed fetch client.
// The types come from ./openapi.gen.ts (generated, never edited by hand).
import createClient, { type Client, type ClientOptions } from 'openapi-fetch';
import type { components, operations, paths } from './openapi.gen.ts';

export type { components, operations, paths };
export * from './enums.gen.ts';
export * from './error-codes.gen.ts';

/** Named schema from `components.schemas`, e.g. `Schema<'HealthzResponse'>`. */
export type Schema<Name extends keyof components['schemas']> = components['schemas'][Name];

export type ApiClient = Client<paths>;

/** Everything openapi-fetch accepts except `baseUrl` (custom `fetch`, headers, ...). */
export type ApiClientInit = Omit<ClientOptions, 'baseUrl'>;

/** Typed client for the contract; pass `init.fetch` to inject a transport in tests. */
export function createApiClient(baseUrl: string, init?: ApiClientInit): ApiClient {
  return createClient<paths>({ ...init, baseUrl });
}
