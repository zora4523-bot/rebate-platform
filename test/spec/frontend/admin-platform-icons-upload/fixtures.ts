import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { jsonResponse, TRACE_ID } from '../admin-data/fixtures.ts';
import {
  ACTOR,
  API,
  boardState,
  createServer,
  digest,
  KEYS,
  WRITE_TIME,
  type FakeServer,
  type Gate,
  type Key,
  type LoggedRequest,
  type State,
  type Version,
} from '../admin-platform-icons/fixtures.ts';

// Data and a fake server for the upload half of the platform marks page (F1-06ze), shared by the
// jsdom and the browser layer; no DOM-library or test-runner imports here. The server wraps the
// frozen F1-06zd fake server (list, versions, publish, restore-builtin with its CAS rule) and adds
// the three operations of this task from contracts/openapi.yaml:
//   adminUploadPlatformIcon        POST  /admin/v1/platform-icons/{key}/uploads  (multipart, part `file`)
//   adminCreatePlatformIconVersion POST  /admin/v1/platform-icons/{key}/versions (JSON)
//   adminUpdatePlatformIconVersion PATCH /admin/v1/platform-icons/{key}/versions/{version} (JSON, CAS)
// with the contract's rules: the upload creates no version; saving checks upload_id (unknown,
// expired or another key → 20001 [upload_id]) and sanitized_confirmed (20001
// [sanitized_confirmed]), is idempotent per upload_id, and makes a draft unless both
// registrations are given; PATCH compares the version's revision (20902) and refuses versions
// that were ever published (20001 [version]).

export type Upload = Schema<'AdminPlatformIconUpload'>;
export type Envelope = Schema<'ErrorEnvelope'>;
export { ACTOR, API, boardState, KEYS, WRITE_TIME };
export type { Key, State, Version, Gate };

/** One multipart part as received by the server. */
export interface Part {
  readonly name: string;
  /** File name of a file part; undefined for a plain string part. */
  readonly fileName: string | undefined;
  readonly size: number;
  readonly type: string;
  /** The received value itself (File or string). */
  readonly value: unknown;
}

/** A request as the fake server received it, recorded synchronously at the fetch call. */
export interface Logged extends LoggedRequest {
  /** Header names (lower case) → value, as the data provider passed them to fetch. */
  readonly headers: Readonly<Record<string, string>>;
  /** The multipart parts when the body was a FormData; undefined otherwise. */
  readonly parts: readonly Part[] | undefined;
  /** The raw body handed to fetch (FormData, string, …). */
  readonly rawBody: unknown;
  /** The AbortSignal handed to fetch, if any. */
  readonly signal: AbortSignal | undefined;
}

type Reply = (request: Logged, state: State) => Response | Promise<Response>;

export interface HoldOptions {
  /**
   * The answer arrives on release() even if the request was aborted meanwhile (a response that
   * was already on its way): the page itself must drop it.
   */
  readonly ignoreAbort?: boolean;
}

export interface UploadServer extends FakeServer {
  readonly log: Logged[];
  /** Uploads saved as versions, by upload_id. */
  readonly uploads: Map<string, { readonly key: Key; readonly data: Upload; version?: number }>;
  /** Answers the next matching request with `reply` instead of the server rules (one shot). */
  once(match: (request: Logged) => boolean, reply: Reply): void;
  /** Holds the next matching request (answer computed at request time, delivered on release). */
  hold(match: (request: Logged) => boolean, options?: HoldOptions): Gate;
  /** The next successful upload returns these fields instead of the defaults (FIFO). */
  uploadAs(overrides: Partial<Upload>): void;
  /** Makes an upload_id expire (saving it is then 20001 [upload_id]). */
  expire(uploadId: string): void;
  /** Changes a saved version behind the console's back (another admin). */
  changeVersion(key: Key, n: number, overrides: Partial<Version>): void;
}

// ----- contract envelopes (components.examples, verbatim unless labelled) ------------------------

/** AdminPlatformIconFormatInvalid. */
export const FORMAT_INVALID = {
  code: 20001,
  msg: '请上传 SVG，或边长不小于 512px 的透明底 PNG',
  data: { fields: ['file'], reason: 'icon_format_invalid' },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** AdminPlatformIconTooLarge. */
export const TOO_LARGE = {
  code: 20001,
  msg: '文件超过大小上限',
  data: { fields: ['file'], reason: 'icon_too_large' },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** AdminPlatformIconSvgUnconvertible. */
export const SVG_UNCONVERTIBLE = {
  code: 20001,
  msg: '请换一份不含样式表或外部引用的官方 SVG，或改传 PNG',
  data: { fields: ['file'], reason: 'icon_svg_unconvertible' },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** adminUploadPlatformIcon responses.413.example. */
export const BODY_TOO_LARGE = {
  code: 20001,
  msg: '参数错误',
  data: { fields: ['body'] },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** AdminPlatformIconUploadInvalid. */
export const UPLOAD_INVALID = {
  code: 20001,
  msg: '上传已失效，请重新上传',
  data: { fields: ['upload_id'] },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** AdminPlatformIconSanitizedUnconfirmed. */
export const SANITIZED_UNCONFIRMED = {
  code: 20001,
  msg: '已清除不安全内容，请确认预览后再保存',
  data: { fields: ['sanitized_confirmed'] },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** AdminPlatformIconVersionInvalid (registration of a published or unknown version). */
export const VERSION_INVALID = {
  code: 20001,
  msg: '参数错误',
  data: { fields: ['version'] },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** AdminPlatformIconUnknownKey. */
export const UNKNOWN_KEY = {
  code: 20001,
  msg: '参数错误',
  data: { fields: ['key'] },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** AdminPlatformIconConflict. */
export const CONFLICT = {
  code: 20902,
  msg: '状态已变化，请刷新后重试',
  data: { resource: 'platform_icon' },
  trace_id: TRACE_ID,
} satisfies Envelope;

/** Preview expiry of the default upload: 2026-10-13 10:20 Beijing time (board 「10-13 10:20」). */
export const EXPIRES_AT = '2026-10-13T02:20:00Z';

// ----- files -----------------------------------------------------------------------------------

function padded(head: string, size: number, tail: string): string {
  const filler = Math.max(0, size - head.length - tail.length);
  return `${head}${' '.repeat(filler)}${tail}`;
}

/** An SVG file of exactly `size` bytes (ASCII). */
export function svgFile(name = 'taobao-logo.svg', size = 9216): File {
  const head =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/>';
  return new File([padded(head, size, '</svg>')], name, { type: 'image/svg+xml' });
}

/** A PNG-looking file of exactly `size` bytes (signature + filler). */
export function pngFile(name = 'alipay-logo.png', size = 51200): File {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return new File([bytes], name, { type: 'image/png' });
}

// ----- server ----------------------------------------------------------------------------------

function ok(data: unknown): Response {
  return jsonResponse({ code: 0, msg: '', data, trace_id: TRACE_ID });
}

function isFormData(body: unknown): body is FormData {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as FormData).getAll === 'function' &&
    typeof (body as FormData).entries === 'function' &&
    typeof (body as FormData).append === 'function'
  );
}

function partsOf(form: FormData): Part[] {
  const parts: Part[] = [];
  form.forEach((value, name) => {
    if (typeof value === 'string') {
      parts.push({ name, fileName: undefined, size: value.length, type: '', value });
    } else {
      parts.push({ name, fileName: value.name, size: value.size, type: value.type, value });
    }
  });
  return parts;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (init?.headers === undefined) return out;
  new Headers(init.headers).forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

const UPLOADS = new RegExp(`^${API}/([a-z_]+)/uploads$`);
const VERSIONS = new RegExp(`^${API}/([a-z_]+)/versions$`);
const ONE_VERSION = new RegExp(`^${API}/([a-z_]+)/versions/(\\d+)$`);

function knownKey(segment: string | undefined): Key | undefined {
  return KEYS.find((key) => key === segment);
}

export const isUpload = (request: LoggedRequest): boolean =>
  request.method === 'POST' && UPLOADS.test(request.path);
export const isCreate = (request: LoggedRequest): boolean =>
  request.method === 'POST' && VERSIONS.test(request.path);
export const isPatch = (request: LoggedRequest): boolean =>
  request.method === 'PATCH' && ONE_VERSION.test(request.path);

export function uploadId(n: number): string {
  return `0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c${String(n).padStart(2, '0')}`;
}

export function createUploadServer(state: State = boardState()): UploadServer {
  const inner = createServer(state);
  const log: Logged[] = [];
  const overrides: { match: (request: Logged) => boolean; reply: Reply }[] = [];
  const holds: {
    match: (request: Logged) => boolean;
    released: Promise<void>;
    options: HoldOptions;
    used: boolean;
  }[] = [];
  const planned: Partial<Upload>[] = [];
  const uploads = new Map<string, { key: Key; data: Upload; version?: number }>();
  const expired = new Set<string>();
  let counter = 0;

  function answerUpload(request: Logged, key: Key): Response {
    const files = (request.parts ?? []).filter((part) => part.name === 'file');
    if (request.parts === undefined || files.length !== 1 || files[0]!.fileName === undefined) {
      // Not a multipart body with one file part `file`: the server cannot read a file.
      return jsonResponse(FORMAT_INVALID, 400);
    }
    counter += 1;
    const file = files[0]!;
    const format = /\.png$/i.test(file.fileName ?? '') ? 'png' : 'svg';
    const sha256 = digest(`upload-${key}-${counter}`);
    const data: Upload = {
      upload_id: uploadId(counter),
      url: `https://media.example.test/${sha256}.${format}`,
      sha256,
      format,
      bytes: 4096,
      sanitized: format === 'svg',
      expires_at: EXPIRES_AT,
      ...planned.shift(),
    };
    uploads.set(data.upload_id, { key, data });
    return ok(data);
  }

  function answerCreate(request: Logged, key: Key): Response {
    const body = (request.body ?? {}) as {
      upload_id?: unknown;
      sanitized_confirmed?: unknown;
      source_url?: unknown;
      downloaded_on?: unknown;
    };
    const id = typeof body.upload_id === 'string' ? body.upload_id : '';
    const upload = uploads.get(id);
    if (upload === undefined || upload.key !== key || expired.has(id)) {
      return jsonResponse(UPLOAD_INVALID, 400);
    }
    const saved = state.versions.get(key)!;
    if (upload.version !== undefined) {
      // Same upload_id again (a retry): the existing version as it is now, nothing else applied.
      return ok(saved.find((item) => item.version === upload.version));
    }
    if (upload.data.sanitized && body.sanitized_confirmed !== true) {
      return jsonResponse(SANITIZED_UNCONFIRMED, 400);
    }
    const sourceUrl = typeof body.source_url === 'string' ? body.source_url : null;
    const downloadedOn = typeof body.downloaded_on === 'string' ? body.downloaded_on : null;
    const n = Math.max(0, ...saved.map((item) => item.version)) + 1;
    const created: Version = {
      version: n,
      url: upload.data.url,
      sha256: upload.data.sha256,
      format: upload.data.format,
      bytes: upload.data.bytes,
      sanitized: upload.data.sanitized,
      source_url: sourceUrl,
      downloaded_on: downloadedOn,
      publishable: sourceUrl !== null && downloadedOn !== null,
      ever_published: false,
      revision: 1,
      created_by: ACTOR,
      created_at: WRITE_TIME,
    };
    saved.push(created);
    upload.version = n;
    // Saving moves latest_version and updated_by / updated_at, never the mark's revision.
    state.icons.set(key, {
      ...state.icons.get(key)!,
      latest_version: n,
      updated_by: ACTOR,
      updated_at: WRITE_TIME,
    });
    return ok(structuredClone(created));
  }

  function answerPatch(request: Logged, key: Key, n: number): Response {
    const body = (request.body ?? {}) as {
      expected_revision?: unknown;
      source_url?: unknown;
      downloaded_on?: unknown;
    };
    const saved = state.versions.get(key)!;
    const target = saved.find((item) => item.version === n);
    if (target === undefined || target.ever_published) return jsonResponse(VERSION_INVALID, 400);
    if (body.expected_revision !== target.revision) return jsonResponse(CONFLICT, 409);
    if ('source_url' in body) target.source_url = (body.source_url as string | null) ?? null;
    if ('downloaded_on' in body)
      target.downloaded_on = (body.downloaded_on as string | null) ?? null;
    target.revision += 1;
    target.publishable = target.source_url !== null && target.downloaded_on !== null;
    return ok(structuredClone(target));
  }

  async function answer(
    request: Logged,
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit | undefined,
  ): Promise<Response> {
    const upload = UPLOADS.exec(request.path);
    const create = VERSIONS.exec(request.path);
    const patch = ONE_VERSION.exec(request.path);
    if (request.method === 'POST' && upload !== null) {
      const key = knownKey(upload[1]);
      return key === undefined ? jsonResponse(UNKNOWN_KEY, 400) : answerUpload(request, key);
    }
    if (request.method === 'POST' && create !== null) {
      const key = knownKey(create[1]);
      return key === undefined ? jsonResponse(UNKNOWN_KEY, 400) : answerCreate(request, key);
    }
    if (request.method === 'PATCH' && patch !== null) {
      const key = knownKey(patch[1]);
      return key === undefined
        ? jsonResponse(UNKNOWN_KEY, 400)
        : answerPatch(request, key, Number(patch[2]));
    }
    // Everything else: the frozen F1-06zd server (list, versions, publish, restore-builtin).
    return inner.fetch(input, init);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw: unknown = init?.body;
    let body: unknown;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = raw;
      }
    }
    const request: Logged = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: headersOf(init),
      parts: isFormData(raw) ? partsOf(raw) : undefined,
      rawBody: raw,
      signal: init?.signal ?? undefined,
    };
    log.push(request);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    const override = overrides.findIndex((candidate) => candidate.match(request));
    const response =
      override === -1
        ? await answer(request, input, init)
        : await overrides.splice(override, 1)[0]!.reply(request, state);
    const hold = holds.find((candidate) => !candidate.used && candidate.match(request));
    if (hold !== undefined) {
      hold.used = true;
      await new Promise<void>((resolve, reject) => {
        void hold.released.then(resolve);
        if (signal !== undefined && hold.options.ignoreAbort !== true) {
          if (signal.aborted) reject(abortError());
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }
      });
    } else if (signal?.aborted) {
      throw abortError();
    }
    return response;
  };

  return {
    state,
    log,
    fetch,
    uploads,
    once(match, reply) {
      overrides.push({ match: match as (request: Logged) => boolean, reply: reply as Reply });
    },
    hold(match, options = {}) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ match, released, options, used: false });
      return { release };
    },
    change(key, values) {
      inner.change(key, values);
    },
    uploadAs(values) {
      planned.push(values);
    },
    expire(id) {
      expired.add(id);
    },
    changeVersion(key, n, values) {
      const saved = state.versions.get(key)!;
      const index = saved.findIndex((item) => item.version === n);
      saved[index] = { ...saved[index]!, ...values };
    },
  };
}

/** Replies with a contract error envelope. */
export function reject(envelope: Envelope, status = 400): Reply {
  return () => jsonResponse(envelope, status);
}

/** boardState with alipay's draft version 3 at revision 5 (≠ the mark's revision 3). */
export function registerState(): State {
  const state = boardState();
  const saved = state.versions.get('alipay')!;
  const index = saved.findIndex((item) => item.version === 3);
  saved[index] = { ...saved[index]!, revision: 5 };
  return state;
}
