import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { jsonResponse, TRACE_ID } from '../admin-data/fixtures.ts';

// Data for the platform marks page (F1-06zd), shared by the jsdom and the browser layer; no DOM
// or test-runner imports here. Records are contract examples of contracts/openapi.yaml
// (adminListPlatformIcons, adminListPlatformIconVersions, adminPublishPlatformIcon,
// adminRestoreBuiltinPlatformIcon) adapted to the design-hifi sample (sample-data §15); every
// adaptation is labelled. The fake server below answers the four operations with the contract's
// CAS rule, so a request with a stale `expected_revision` gets 20902 just as on the server.

export type Icon = Schema<'AdminPlatformIcon'>;
export type Version = Schema<'AdminPlatformIconVersion'>;
export type Key = Icon['key'];

// Independent oracle: BR-TEXT-24 细则「标识键」 table, in the order of enum platform_icon_key.
export const KEYS = [
  'taobao',
  'tmall',
  'jd',
  'pdd',
  'wechat',
  'wechat_pay',
  'alipay',
  'wecom',
] as const satisfies readonly Key[];

export const NAMES: Readonly<Record<Key, string>> = {
  taobao: '淘宝',
  tmall: '天猫',
  jd: '京东',
  pdd: '拼多多',
  wechat: '微信',
  wechat_pay: '微信支付',
  alipay: '支付宝',
  wecom: '企业微信',
};

// BR-TEXT-24 细则「标识键」 table: key → built-in file name (the H5 built-ins of the same name
// live in apps/h5/src/components/platform/assets/; the admin keeps byte-identical copies in
// apps/admin/src/pages/platform-icons/assets/<file>.<ext>).
export const BUILTIN_FILES: Readonly<Record<Key, string>> = {
  taobao: 'taobao',
  tmall: 'tmall',
  jd: 'jd',
  pdd: 'pinduoduo',
  wechat: 'wechat',
  wechat_pay: 'wechat-pay',
  alipay: 'alipay',
  wecom: 'wecom',
};

// Extension of each built-in file: the owner's official images (couli design/icons/platform/,
// 2026-10-19) are PNG; the keys still waiting for one keep the placeholder SVG (F1-06zk).
export const BUILTIN_EXTS: Readonly<Record<Key, 'png' | 'svg'>> = {
  taobao: 'png',
  tmall: 'svg',
  jd: 'png',
  pdd: 'png',
  wechat: 'svg',
  wechat_pay: 'svg',
  alipay: 'svg',
  wecom: 'svg',
};

/** Deterministic lowercase 64-hex digest for synthetic versions (not a real SHA-256). */
export function digest(label: string): string {
  let out = '';
  for (let salt = 0; out.length < 64; salt++) {
    let hash = 0x811c9dc5 ^ salt;
    for (const character of `${salt}:${label}`) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

/** A synthetic saved version; the url follows the contract (media domain, named by digest). */
export function version(key: Key, n: number, overrides: Partial<Version> = {}): Version {
  const sha256 = digest(`${key}-${n}`);
  return {
    version: n,
    url: `https://media.example.test/${sha256}.svg`,
    sha256,
    format: 'svg',
    bytes: 4096,
    sanitized: false,
    source_url: `https://example.test/brand/${key}/v${n}`,
    downloaded_on: '2026-10-08',
    publishable: true,
    ever_published: false,
    revision: 1,
    created_by: 'ops-yi',
    created_at: '2026-10-08T07:00:00Z',
    ...overrides,
  };
}

// adminListPlatformIconVersions example, items[1] (verbatim).
export const ALIPAY_V2: Version = {
  version: 2,
  url: 'https://media.example.test/88e2cce43eeadb36ce19668116709ef3f6f44b7b364d4d23fd545d2af826e6da.svg',
  sha256: '88e2cce43eeadb36ce19668116709ef3f6f44b7b364d4d23fd545d2af826e6da',
  format: 'svg',
  bytes: 4096,
  sanitized: true,
  source_url: 'https://example.test/brand/alipay',
  downloaded_on: '2026-10-08',
  publishable: true,
  ever_published: true,
  revision: 1,
  created_by: 'ops-yi',
  created_at: '2026-10-08T15:00:00+08:00',
};

// adminListPlatformIconVersions example, items[0] (verbatim): a PNG draft without registration.
export const ALIPAY_V3: Version = {
  version: 3,
  url: 'https://media.example.test/3f0c1b5e2d4a69788f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c4b5a6978.png',
  sha256: '3f0c1b5e2d4a69788f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c4b5a6978',
  format: 'png',
  bytes: 51200,
  sanitized: false,
  source_url: null,
  downloaded_on: null,
  publishable: false,
  ever_published: false,
  revision: 1,
  created_by: 'ops-yi',
  created_at: '2026-10-09T10:00:00+08:00',
};

// Synthetic (sample-data §15 alipay v1): published once, SVG 3 KB not changed by cleaning; the
// UTC timestamp is 2026-10-02 11:00 in Beijing time.
export const ALIPAY_V1: Version = version('alipay', 1, {
  bytes: 3072,
  source_url: 'https://example.test/brand/alipay/2025',
  downloaded_on: '2026-10-02',
  ever_published: true,
  revision: 2,
  created_at: '2026-10-02T03:00:00Z',
});

// Synthetic (sample-data §15 jd v1): published, SVG 3 KB, saved 10-08 16:10 Beijing time.
export const JD_V1: Version = version('jd', 1, {
  bytes: 3072,
  source_url: 'https://example.test/brand/jd',
  downloaded_on: '2026-10-08',
  ever_published: true,
  created_at: '2026-10-08T08:10:00Z',
});

// Synthetic (sample-data §15 wecom v1): registered, never published = 可发布.
export const WECOM_V1: Version = version('wecom', 1, {
  source_url: 'https://example.test/brand/wecom',
  downloaded_on: '2026-10-09',
  created_at: '2026-10-09T01:00:00Z',
});

// Synthetic (sample-data §15 taobao v1, AdmPlatformIconPublishConfirm): cleaned SVG 4 KB,
// registered, never published; saved 10-12 10:22 Beijing time.
export const TAOBAO_V1: Version = version('taobao', 1, {
  sanitized: true,
  source_url: 'https://example.test/brand/taobao',
  downloaded_on: '2026-10-12',
  created_at: '2026-10-12T02:22:00Z',
});

function builtin(key: Key, overrides: Partial<Icon> = {}): Icon {
  return {
    key,
    current_version: null,
    revision: 0,
    current: null,
    latest_version: null,
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

export interface State {
  readonly icons: Map<Key, Icon>;
  readonly versions: Map<Key, Version[]>;
}

/**
 * The list of AdmPlatformIcons as contract records: the adminListPlatformIcons example with its
 * alipay `updated_at` written in UTC (same instant as the board's 10-09 10:00), jd published
 * (board) instead of built-in, and wecom's unpublished version 1 as in the example.
 */
export function boardState(): State {
  const icons = new Map<Key, Icon>(KEYS.map((key) => [key, builtin(key)]));
  icons.set(
    'jd',
    builtin('jd', {
      current_version: 1,
      revision: 1,
      current: JD_V1,
      latest_version: 1,
      updated_by: 'ops-yi',
      updated_at: '2026-10-08T08:20:00Z',
    }),
  );
  icons.set(
    'alipay',
    builtin('alipay', {
      current_version: 2,
      revision: 3,
      current: ALIPAY_V2,
      latest_version: 3,
      updated_by: 'ops-yi',
      updated_at: '2026-10-09T02:00:00Z',
    }),
  );
  icons.set(
    'wecom',
    builtin('wecom', {
      latest_version: 1,
      updated_by: 'ops-yi',
      updated_at: '2026-10-09T09:00:00+08:00',
    }),
  );
  const versions = new Map<Key, Version[]>(KEYS.map((key) => [key, []]));
  versions.set('jd', [JD_V1]);
  versions.set('alipay', [ALIPAY_V1, ALIPAY_V2, ALIPAY_V3]);
  versions.set('wecom', [WECOM_V1]);
  return structuredClone({ icons, versions });
}

/** boardState plus taobao's saved, registered, unpublished version 1 (PublishConfirm board). */
export function publishState(): State {
  const state = boardState();
  state.icons.set(
    'taobao',
    builtin('taobao', {
      latest_version: 1,
      updated_by: 'ops-yi',
      updated_at: '2026-10-12T02:22:00Z',
    }),
  );
  state.versions.set('taobao', [structuredClone(TAOBAO_V1)]);
  return state;
}

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type Reply = (request: LoggedRequest, state: State) => Response | Promise<Response>;

interface Hold {
  readonly match: (request: LoggedRequest) => boolean;
  readonly released: Promise<void>;
  used: boolean;
}

export interface Gate {
  readonly release: () => void;
}

export interface FakeServer {
  readonly state: State;
  /** Every request, recorded synchronously when the data provider calls fetch. */
  readonly log: LoggedRequest[];
  readonly fetch: typeof globalThis.fetch;
  /** Answers the next matching request with `reply` instead of the server rules (one shot). */
  once(match: (request: LoggedRequest) => boolean, reply: Reply): void;
  /**
   * Holds the next matching request: its answer is computed from the state at request time and
   * delivered on `release()` (an old answer that arrives late).
   */
  hold(match: (request: LoggedRequest) => boolean): Gate;
  /** Changes a mark behind the console's back (another admin). */
  change(key: Key, overrides: Partial<Icon>): void;
}

export const API = '/admin/v1/platform-icons';
/** updated_at of writes made through the fake server: 2026-10-12 10:25 Beijing time. */
export const WRITE_TIME = '2026-10-12T02:25:00Z';
/** The account signed in to the console in these tests (updated_by of its writes). */
export const ACTOR = 'owner';

export const CONFLICT = {
  code: 20902,
  msg: '状态已变化，请刷新后重试',
  data: { resource: 'platform_icon' },
  trace_id: TRACE_ID,
} satisfies Schema<'ErrorEnvelope'>;

export const VERSION_INVALID = {
  code: 20001,
  msg: '参数错误',
  data: { fields: ['version'] },
  trace_id: TRACE_ID,
} satisfies Schema<'ErrorEnvelope'>;

export const SOURCE_MISSING = {
  code: 20001,
  msg: '请先登记来源页地址与下载日期',
  data: { fields: ['source_url', 'downloaded_on'] },
  trace_id: TRACE_ID,
} satisfies Schema<'ErrorEnvelope'>;

function ok(data: unknown): Response {
  return jsonResponse({ code: 0, msg: '', data, trace_id: TRACE_ID });
}

function keyOf(path: string): Key | undefined {
  const segment = path.slice(API.length + 1).split('/')[0];
  return KEYS.find((key) => key === segment);
}

function answer(request: LoggedRequest, state: State): Response {
  const { method, path } = request;
  if (method === 'GET' && path === API) {
    return ok({ items: KEYS.map((key) => state.icons.get(key)!) });
  }
  const key = keyOf(path);
  if (key === undefined) {
    return jsonResponse(
      { code: 20001, msg: '参数错误', data: { fields: ['key'] }, trace_id: TRACE_ID },
      400,
    );
  }
  const icon = state.icons.get(key)!;
  const saved = state.versions.get(key)!;
  if (method === 'GET' && path === `${API}/${key}/versions`) {
    const page = Number(request.query['page'] ?? '1');
    const size = Number(request.query['page_size'] ?? '20');
    const items = [...saved].sort((a, b) => b.version - a.version);
    return ok({
      items: items.slice((page - 1) * size, page * size),
      page,
      page_size: size,
      total: items.length,
    });
  }
  const body = (request.body ?? {}) as { version?: unknown; expected_revision?: unknown };
  if (method === 'POST' && path === `${API}/${key}/publish`) {
    if (body.expected_revision !== icon.revision) return jsonResponse(CONFLICT, 409);
    const target = saved.find((item) => item.version === body.version);
    if (target === undefined) return jsonResponse(VERSION_INVALID, 400);
    if (!target.publishable) return jsonResponse(SOURCE_MISSING, 400);
    if (icon.current_version !== target.version) {
      target.ever_published = true;
      state.icons.set(key, {
        ...icon,
        current_version: target.version,
        current: structuredClone(target),
        revision: icon.revision + 1,
        updated_by: ACTOR,
        updated_at: WRITE_TIME,
      });
    }
    return ok(state.icons.get(key));
  }
  if (method === 'POST' && path === `${API}/${key}/restore-builtin`) {
    if (body.expected_revision !== icon.revision) return jsonResponse(CONFLICT, 409);
    if (icon.current_version !== null) {
      state.icons.set(key, {
        ...icon,
        current_version: null,
        current: null,
        revision: icon.revision + 1,
        updated_by: ACTOR,
        updated_at: WRITE_TIME,
      });
    }
    return ok(state.icons.get(key));
  }
  return jsonResponse({ code: 20001, msg: '参数错误', data: null, trace_id: TRACE_ID }, 400);
}

export function createServer(state: State = boardState()): FakeServer {
  const log: LoggedRequest[] = [];
  const overrides: { match: (request: LoggedRequest) => boolean; reply: Reply }[] = [];
  const holds: Hold[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const text = typeof init?.body === 'string' ? init.body : undefined;
    const request: LoggedRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: text === undefined ? undefined : (JSON.parse(text) as unknown),
    };
    log.push(request);
    const override = overrides.findIndex((candidate) => candidate.match(request));
    const response =
      override === -1
        ? answer(request, state)
        : overrides.splice(override, 1)[0]!.reply(request, state);
    const hold = holds.find((candidate) => !candidate.used && candidate.match(request));
    if (hold !== undefined) {
      hold.used = true;
      await hold.released;
    }
    return response;
  };

  return {
    state,
    log,
    fetch,
    once(match, reply) {
      overrides.push({ match, reply });
    },
    hold(match) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ match, released, used: false });
      return { release };
    },
    change(key, values) {
      state.icons.set(key, { ...state.icons.get(key)!, ...values });
    },
  };
}

export const isList = (request: LoggedRequest): boolean =>
  request.method === 'GET' && request.path === API;
export const isVersions =
  (key: Key) =>
  (request: LoggedRequest): boolean =>
    request.method === 'GET' && request.path === `${API}/${key}/versions`;
export const isWrite = (request: LoggedRequest): boolean => request.method !== 'GET';
