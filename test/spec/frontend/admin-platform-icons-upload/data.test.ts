import { expect, it, vi } from 'vitest';
import {
  AdminApiError,
  createDataProvider,
} from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, jsonResponse, requestFrom, TRACE_ID } from '../admin-data/fixtures.ts';
import {
  BODY_TOO_LARGE,
  FORMAT_INVALID,
  SVG_UNCONVERTIBLE,
  TOO_LARGE,
  svgFile,
  uploadId,
} from './fixtures.ts';

// adminUploadPlatformIcon is multipart/form-data with one part `file` (contracts/openapi.yaml):
// the data provider's `custom` must hand a FormData payload to fetch as it is and leave the
// Content-Type to fetch (multipart with its boundary), keep every JSON behaviour, forward an
// AbortSignal given as `meta.signal` (the upload can be cancelled, flow-map §21.1 C), and map
// 413 / 20001 like every other error.

const UPLOAD_URL = '/admin/v1/platform-icons/taobao/uploads';

// adminUploadPlatformIcon responses.200 examples.sanitized.value.data (verbatim).
const UPLOAD = {
  upload_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01',
  url: 'https://media.example.test/88e2cce43eeadb36ce19668116709ef3f6f44b7b364d4d23fd545d2af826e6da.svg',
  sha256: '88e2cce43eeadb36ce19668116709ef3f6f44b7b364d4d23fd545d2af826e6da',
  format: 'svg',
  bytes: 4096,
  sanitized: true,
  expires_at: '2026-10-10T10:00:00+08:00',
};

function provider(fetch: typeof globalThis.fetch, onError = vi.fn()) {
  return {
    onError,
    data: createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => 'example-admin-token',
      onError,
    }),
  };
}

function form(file = svgFile()): FormData {
  const body = new FormData();
  body.append('file', file);
  return body;
}

/** Header names the provider itself set on the fetch call (lower case). */
function ownHeaders(init: RequestInit | undefined): string[] {
  const names: string[] = [];
  new Headers(init?.headers).forEach((_value, name) => names.push(name.toLowerCase()));
  return names;
}

it('[AC-F1-06ze-DATA#1] custom 发送 FormData 时原样作为请求体、不设 Content-Type；JSON 请求照旧', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    jsonResponse({ code: 0, msg: '', data: UPLOAD, trace_id: TRACE_ID }),
  );
  const { data, onError } = provider(fetch);
  const file = svgFile('taobao-logo.svg', 9216);
  const payload = form(file);

  const result = await data.custom({ url: UPLOAD_URL, method: 'post', payload });
  expect(result).toEqual({ data: UPLOAD });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [input, init] = fetch.mock.calls[0]!;
  expect(String(input)).toBe(`${BASE_URL}${UPLOAD_URL}`);
  expect(init?.method).toBe('POST');
  // The FormData itself reaches fetch: not JSON, not a copy turned into a string.
  expect(init?.body, 'the FormData is the request body').toBe(payload);
  // fetch adds multipart/form-data with the boundary only when nobody set a Content-Type.
  expect(ownHeaders(init), 'no Content-Type set by the provider').not.toContain('content-type');
  const headers = new Headers(init?.headers);
  expect(headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(headers.get('Accept')).toBe('application/json');
  const request = requestFrom(input, init);
  expect(request.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=\S+/);
  const received = await request.formData();
  expect([...received.keys()]).toEqual(['file']);
  const part = received.get('file');
  expect(part).toBeInstanceOf(Blob);
  expect((part as File).name).toBe('taobao-logo.svg');
  expect((part as File).size).toBe(9216);
  expect(await (part as File).text()).toBe(await file.text());

  // The JSON behaviour of the same provider is unchanged (adminCreatePlatformIconVersion body).
  const body = { upload_id: uploadId(1), sanitized_confirmed: true };
  await data.custom({
    url: '/admin/v1/platform-icons/taobao/versions',
    method: 'post',
    payload: body,
  });
  const [, jsonInit] = fetch.mock.calls[1]!;
  expect(typeof jsonInit?.body).toBe('string');
  expect(JSON.parse(String(jsonInit?.body))).toEqual(body);
  expect(new Headers(jsonInit?.headers).get('Content-Type')).toContain('application/json');
  // A GET without payload still sends no body and no Content-Type.
  await data.custom({ url: '/admin/v1/platform-icons', method: 'get' });
  const [, getInit] = fetch.mock.calls[2]!;
  expect(getInit?.body).toBeUndefined();
  expect(ownHeaders(getInit)).not.toContain('content-type');
  expect(onError).not.toHaveBeenCalled();
});

it('[AC-F1-06ze-DATA#2] custom 把 meta.signal 交给 fetch；中止后请求以错误结束，不当成功', async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(
    (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
        void released.then(() =>
          resolve(jsonResponse({ code: 0, msg: '', data: UPLOAD, trace_id: TRACE_ID })),
        );
      }),
  );
  const { data } = provider(fetch);
  const controller = new AbortController();
  const pending = data.custom({
    url: UPLOAD_URL,
    method: 'post',
    payload: form(),
    meta: { signal: controller.signal },
  });
  const outcome = pending.then(
    (value) => ({ settled: 'resolved' as const, value }),
    (error: unknown) => ({ settled: 'rejected' as const, error }),
  );
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const init = fetch.mock.calls[0]![1];
  expect(init?.signal, 'meta.signal reaches fetch').toBe(controller.signal);
  expect(init?.body).toBeInstanceOf(FormData);
  controller.abort();
  // The answer still arrives afterwards; an aborted call must not turn into a success.
  release();
  const result = await outcome;
  expect(result.settled).toBe('rejected');
  expect(result.settled === 'rejected' ? result.error : null).toBeInstanceOf(AdminApiError);

  // A JSON call forwards its signal the same way.
  const other = new AbortController();
  await data.custom({
    url: '/admin/v1/platform-icons',
    method: 'get',
    meta: { signal: other.signal },
  });
  expect(fetch.mock.calls[1]![1]?.signal).toBe(other.signal);
});

it('[AC-F1-06ze-DATA#3] multipart 上传遇 413 fields=[body] 照常映射为 20001 错误并统一处理一次', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BODY_TOO_LARGE, 413));
  const { data, onError } = provider(fetch);
  const payload = form();
  const error = await data.custom({ url: UPLOAD_URL, method: 'post', payload }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(fetch.mock.calls[0]![1]?.body, 'sent as multipart').toBe(payload);
  expect(ownHeaders(fetch.mock.calls[0]![1])).not.toContain('content-type');
  expect(error).toBeInstanceOf(AdminApiError);
  const apiError = error as AdminApiError;
  expect(apiError.kind).toBe('api');
  expect(apiError.code).toBe(20001);
  expect(apiError.httpStatus).toBe(413);
  expect(apiError.data).toEqual({ fields: ['body'] });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(apiError);
});

for (const envelope of [FORMAT_INVALID, TOO_LARGE, SVG_UNCONVERTIBLE]) {
  it(`[AC-F1-06ze-DATA#4] multipart 上传遇 20001 ${envelope.data.reason} 保留 fields 与 reason`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(envelope, 400));
    const { data, onError } = provider(fetch);
    const payload = form();
    const error = await data.custom({ url: UPLOAD_URL, method: 'post', payload }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(fetch.mock.calls[0]![1]?.body, 'sent as multipart').toBe(payload);
    expect(ownHeaders(fetch.mock.calls[0]![1])).not.toContain('content-type');
    expect(error).toBeInstanceOf(AdminApiError);
    const apiError = error as AdminApiError;
    expect(apiError.code).toBe(20001);
    expect(apiError.httpStatus).toBe(400);
    expect(apiError.msg).toBe(envelope.msg);
    expect(apiError.data).toEqual(envelope.data);
    expect(onError).toHaveBeenCalledTimes(1);
  });
}
