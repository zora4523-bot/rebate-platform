import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { BASE_URL, failure, ok, type RequestLog } from '../admin-config-center/fixtures.ts';

export { BASE_URL, failure, ok };
export type PageConfig = Schema<'AdminPageConfig'>;
export type Version = Schema<'AdminPageConfigVersion'>;
export const LIST = '/admin/v1/pages';
export const HOME = `${LIST}/home`;
export const VERSIONS = `${HOME}/versions`;
export const TOKEN = 'pv_example_token_0000000000000000';
export const EXPIRE_AT = '2026-10-18T02:40:00Z';
export const SECTIONS: Version['sections'] = [
  { id: 'hero', type: 'banner', version: 1, data_source: { kind: 'static', items: [] } },
  {
    id: 'member-grid',
    type: 'product_grid',
    version: 1,
    data_source: { kind: 'product_pool', pool_id: 'test-pool', limit: 6 },
    condition: { login: 'yes', has_order: 'no' },
  },
];
export const EDITED = JSON.stringify(
  [{ id: 'edited-card', type: 'future_card', version: 1 }],
  null,
  2,
);

export function config(patch: Partial<PageConfig> = {}): PageConfig {
  return {
    page_key: 'home',
    current_version: 6,
    gray_version: 7,
    gray_percent: 15,
    revision: 19,
    latest_version: 8,
    updated_by: 'ops-editor',
    updated_at: '2026-10-18T02:00:00Z',
    ...patch,
  };
}
export function noGray(): PageConfig {
  return config({ gray_version: null, gray_percent: 0 });
}
export function version(number = 8, patch: Partial<Version> = {}): Version {
  const draft = number === 8;
  return {
    page_key: 'home',
    version: number,
    status: draft ? 'draft' : number === 4 ? 'rolled_back' : 'published',
    render_count: 0,
    error_count: 0,
    publisher: draft ? null : 'ops-publisher',
    publish_at: draft
      ? null
      : number === 7
        ? '2026-10-17T06:00:00Z'
        : number === 6
          ? '2026-10-17T04:00:00Z'
          : '2026-10-17T02:00:00Z',
    created_by: 'ops-editor',
    created_at: '2026-10-16T02:00:00Z',
    sections: structuredClone(SECTIONS),
    ...patch,
  };
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

/** HTTP-boundary fake. No React mocks; sections are opaque and validation replies are injected. */
export function createServer(initial: PageConfig[] = [config()]) {
  const pages = structuredClone(initial);
  const history = new Map(
    pages.map((entry) => [
      entry.page_key,
      [8, 7, 6, 5, 4]
        .filter((n) => n <= (entry.latest_version ?? 0))
        .map((n) =>
          version(n, {
            page_key: entry.page_key,
            ...(entry.current_version === null
              ? { status: 'draft', publisher: null, publish_at: null }
              : {}),
            ...(n === 7 && entry.gray_version === null && entry.current_version !== null
              ? { status: 'rolled_back' }
              : {}),
          }),
        ),
    ]),
  );
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;
  function paged<T>(items: T[], request: RequestLog): Response {
    const page = Number(request.query['page'] ?? 1);
    const pageSize = Number(request.query['page_size'] ?? 20);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 200 ||
      Object.keys(request.query).some((key) => !['page', 'page_size'].includes(key))
    )
      return failure(20001, { fields: ['page_size'] });
    return ok({
      items: items.slice((page - 1) * pageSize, page * pageSize),
      page,
      page_size: pageSize,
      total: items.length,
    });
  }
  function normal(request: RequestLog): Response {
    if (request.method === 'GET' && request.path === LIST) return paged(pages, request);
    const [key = '', action, number] = request.path
      .slice(LIST.length + 1)
      .split('/')
      .map(decodeURIComponent);
    let page = pages.find((entry) => entry.page_key === key);
    const entries = history.get(key) ?? [];
    if (request.method === 'GET') {
      if (!page) return failure(30701);
      if (action === undefined) return ok(page);
      if (action === 'versions' && number === undefined) {
        const summaries = entries.map(({ page_key, sections, ...summary }) => {
          void page_key;
          void sections;
          return summary;
        });
        return paged(summaries, request);
      }
      const found = entries.find((entry) => entry.version === Number(number));
      return found ? ok(found) : failure(30701);
    }
    if (request.method !== 'POST') return failure(20001);
    const body = request.body as Record<string, unknown>;
    if (action === 'preview-tokens')
      return ok({ token: TOKEN, page_key: key, version: body['version'], expire_at: EXPIRE_AT });
    if (body['expected_revision'] !== (page?.revision ?? 0))
      return failure(20902, { resource: 'page' });
    if (action === 'versions') {
      if (!page) {
        page = config({
          page_key: key,
          revision: 0,
          current_version: null,
          gray_version: null,
          gray_percent: 0,
          latest_version: null,
        });
        pages.push(page);
      }
      const next = version((page.latest_version ?? 0) + 1, {
        page_key: key,
        status: 'draft',
        publisher: null,
        publish_at: null,
        sections: body['sections'] as Version['sections'],
      });
      entries.unshift(next);
      history.set(key, entries);
      page.latest_version = next.version;
      page.revision += 1;
      return ok(next);
    }
    if (!page) return failure(30701);
    const target = entries.find((entry) => entry.version === body['version']);
    if (action === 'publish') {
      if (!target || target.status !== 'draft' || page.gray_version !== null)
        return failure(20001, { fields: ['version'] });
      const percent = Number(body['gray_percent']);
      if (
        !Number.isInteger(percent) ||
        percent < 1 ||
        percent > 100 ||
        (page.current_version === null && percent !== 100)
      )
        return failure(20001, { fields: ['gray_percent'] });
      target.status = 'published';
      target.publisher = 'ops-publisher';
      target.publish_at = '2026-10-18T03:00:00Z';
      if (percent === 100) page.current_version = target.version;
      else {
        page.gray_version = target.version;
        page.gray_percent = percent;
      }
    } else if (action === 'gray') {
      const percent = Number(body['gray_percent']);
      if (page.gray_version === null || !Number.isInteger(percent) || percent < 1 || percent > 100)
        return failure(20001, { fields: ['gray_percent'] });
      if (percent === 100) {
        page.current_version = page.gray_version;
        page.gray_version = null;
        page.gray_percent = 0;
      } else page.gray_percent = percent;
    } else if (action === 'rollback') {
      if (!target) return failure(20001, { fields: ['version'] });
      if (target.version === page.gray_version) {
        page.gray_version = null;
        page.gray_percent = 0;
      } else if (target.version === page.current_version && page.gray_version === null)
        page.current_version = 5;
      else return failure(20001, { fields: ['version'] });
      target.status = 'rolled_back';
    } else return failure(20001, { fields: ['path'] });
    page.revision += 1;
    return ok(page);
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    log.push(request);
    pending += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      pending -= 1;
    }
  };
  return {
    pages,
    history,
    log,
    fetch,
    get pending() {
      return pending;
    },
    requests(method: string, path?: string) {
      return log.filter(
        (entry) => entry.method === method && (path === undefined || entry.path === path),
      );
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
    hold(method: string, path: string) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return normal(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
