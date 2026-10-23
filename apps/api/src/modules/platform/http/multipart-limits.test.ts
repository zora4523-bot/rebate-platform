import { expect, it } from 'vitest';
import {
  ADMIN_MULTIPART_LIMITS,
  ADMIN_MULTIPART_ROUTES,
  installMultipartRouteLimits,
  type MultipartRouteLimit,
} from './multipart-limits.ts';

type Hook = (request: FakeRequest) => Promise<void>;

interface FakeRequest {
  readonly method: string;
  readonly routeOptions: { readonly url?: string };
  readonly calls: unknown[];
  parts(options?: object): unknown;
  file(options?: object): unknown;
  files(options?: object): unknown;
}

function server(): { hooks: Hook[]; addHook(name: 'onRequest', hook: Hook): void } {
  const hooks: Hook[] = [];
  return { hooks, addHook: (_name, hook) => void hooks.push(hook) };
}

/** A request whose readers record the options they were called with (as the plugin's do). */
function request(method: string, url: string | undefined): FakeRequest {
  const calls: unknown[] = [];
  const record = function (this: FakeRequest, options?: object): unknown {
    expect(this).toBe(target);
    calls.push(options);
    return 'parsed';
  };
  const target: FakeRequest = {
    method,
    routeOptions: url === undefined ? {} : { url },
    calls,
    parts: record,
    file: record,
    files: record,
  };
  return target;
}

const ROUTE: MultipartRouteLimit = {
  method: 'POST',
  url: '/admin/v1/things/:id/uploads',
  limits: { files: 1, fields: 1, parts: 2 },
};

it('[AC-F1-09t] the admin table: default 1 file / 0 fields / 1 part; popup assets 1 / 1 / 2', () => {
  expect(ADMIN_MULTIPART_LIMITS).toEqual({ files: 1, fields: 0, parts: 1 });
  expect(ADMIN_MULTIPART_ROUTES).toEqual([
    {
      method: 'POST',
      url: '/admin/v1/pages/popup-assets',
      limits: { files: 1, fields: 1, parts: 2 },
    },
  ]);
  for (const route of ADMIN_MULTIPART_ROUTES) {
    expect(Object.keys(route.limits)).not.toContain('fileSize');
  }
});

it('[AC-F1-09t] a listed route reads under its counts, merged over the caller limits', async () => {
  const s = server();
  installMultipartRouteLimits(s, [ROUTE]);
  expect(s.hooks).toHaveLength(1);
  const listed = request('POST', ROUTE.url);
  await s.hooks[0]!(listed);
  expect(listed.parts()).toBe('parsed');
  expect(listed.file({ throwFileSizeLimit: true })).toBe('parsed');
  expect(listed.files({ limits: { fields: 9, fileSize: 10 } })).toBe('parsed');
  expect(listed.calls).toEqual([
    { limits: { files: 1, fields: 1, parts: 2 } },
    { throwFileSizeLimit: true, limits: { files: 1, fields: 1, parts: 2 } },
    { limits: { files: 1, fields: 1, parts: 2, fileSize: 10 } },
  ]);
});

it('[AC-F1-09t] other methods, templates and unmatched requests keep the plugin defaults', async () => {
  const s = server();
  installMultipartRouteLimits(s, [ROUTE]);
  for (const other of [
    request('PUT', ROUTE.url),
    request('POST', `${ROUTE.url}/extra`),
    request('POST', '/admin/v1/things/1/uploads'),
    request('POST', undefined),
  ]) {
    const before = other.parts;
    await s.hooks[0]!(other);
    expect(other.parts).toBe(before);
    other.parts();
    expect(other.calls).toEqual([undefined]);
  }
});

it('[AC-F1-09t] the counts are per request: another request on the route starts unwrapped', async () => {
  const s = server();
  installMultipartRouteLimits(s, [ROUTE]);
  const first = request('post', ROUTE.url);
  const second = request('POST', ROUTE.url);
  await s.hooks[0]!(first);
  expect(Object.hasOwn(second, 'parts')).toBe(true);
  const untouched = second.parts;
  first.parts();
  expect(first.calls).toEqual([{ limits: { files: 1, fields: 1, parts: 2 } }]);
  expect(second.parts).toBe(untouched);
});

it('[AC-F1-09t] an empty table adds no hook; a route listed twice is refused', () => {
  const s = server();
  installMultipartRouteLimits(s, []);
  expect(s.hooks).toHaveLength(0);
  expect(() => installMultipartRouteLimits(s, [ROUTE, { ...ROUTE, method: 'post' }])).toThrow(
    /listed twice/,
  );
});
