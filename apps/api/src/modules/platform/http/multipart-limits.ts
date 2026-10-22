// Multipart limits of the admin entry, by route (F1-09t). bootstrap.ts registers @fastify/multipart
// on the admin entry with ADMIN_MULTIPART_LIMITS (plus fileSize = Fastify's bodyLimit) for every
// route, and installs installMultipartRouteLimits(server, ADMIN_MULTIPART_ROUTES) so that a route
// listed below parses its body under its own file / field / part counts instead:
//   - default (every admin multipart route, e.g. the platform icon upload): 1 file, 0 fields,
//     1 part;
//   - POST /admin/v1/pages/popup-assets (contract adminUploadPopupAsset: field `kind` + file
//     `file`): 1 file, 1 field, 2 parts.
// fileSize is never listed per route: the plugin merges the per-request limits over its
// registration options, so every route keeps fileSize = bodyLimit.
//
// Only the plugin's public per-request option is used: `request.parts(options)`,
// `request.file(options)` and `request.files(options)` accept `{ limits }`. For a listed route
// (matched on the method and the route template, so a query string or a neighbouring path does not
// change it) an `onRequest` hook replaces those three methods on that request object only, and each
// passes the route's counts over whatever limits the caller gives. Nothing is shared between
// requests, so a concurrent or later request on another route keeps the default.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no `process.env`, no logging. Fastify is reached through
// the structural types below.

/** Counts of one route's multipart body (busboy limits). */
export interface MultipartCounts {
  readonly files: number;
  readonly fields: number;
  readonly parts: number;
}

/** One route parsed under its own counts. */
export interface MultipartRouteLimit {
  readonly method: string;
  /** The Fastify route template, e.g. `/admin/v1/platform-icons/:key/uploads`. */
  readonly url: string;
  readonly limits: MultipartCounts;
}

/** The admin entry's default for every multipart route (fileSize is set by bootstrap). */
export const ADMIN_MULTIPART_LIMITS: MultipartCounts = Object.freeze({
  files: 1,
  fields: 0,
  parts: 1,
});

/** Admin routes whose multipart body differs from the default. */
export const ADMIN_MULTIPART_ROUTES: readonly MultipartRouteLimit[] = Object.freeze([
  Object.freeze({
    method: 'POST',
    url: '/admin/v1/pages/popup-assets',
    limits: Object.freeze({ files: 1, fields: 1, parts: 2 }),
  }),
]);

type Reader = (this: unknown, options?: { readonly limits?: object }) => unknown;

interface RouteRequest {
  readonly method: string;
  readonly routeOptions: { readonly url?: string | undefined };
}

interface RouteLimitServer {
  addHook(name: 'onRequest', hook: (request: RouteRequest) => Promise<void>): unknown;
}

/** The plugin's public readers that take per-request options (saveRequestFiles calls parts). */
const READERS = ['parts', 'file', 'files'] as const;

/**
 * Adds one `onRequest` hook: a request whose method and route template are listed reads its
 * multipart body under the listed counts. Throws on a duplicate (method, template).
 */
export function installMultipartRouteLimits(
  server: RouteLimitServer,
  routes: readonly MultipartRouteLimit[],
): void {
  const byRoute = new Map<string, MultipartCounts>();
  for (const route of routes) {
    const key = `${route.method.toUpperCase()} ${route.url}`;
    if (byRoute.has(key)) throw new Error(`multipart limits listed twice for ${key}`);
    byRoute.set(key, Object.freeze({ ...route.limits }));
  }
  if (byRoute.size === 0) return;
  server.addHook('onRequest', async (request) => {
    const template = request.routeOptions.url;
    if (template === undefined) return;
    const limits = byRoute.get(`${request.method.toUpperCase()} ${template}`);
    if (limits === undefined) return;
    for (const name of READERS) {
      const reader: unknown = Reflect.get(request, name);
      if (typeof reader !== 'function') continue;
      const original = reader as Reader;
      Object.defineProperty(request, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function (this: unknown, options?: { readonly limits?: object }): unknown {
          return original.call(this, { ...options, limits: { ...options?.limits, ...limits } });
        },
      });
    }
  });
}
