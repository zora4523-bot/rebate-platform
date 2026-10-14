// 联盟适配器的真实 HTTPS 传输：只接受 https URL；取消与超时只走请求自带的 AbortSignal，
// 这里不自行设超时、不重试、不跟随跳转。失败一律转成 UnionError，错误信息里不带 URL、
// 请求头、请求体、上游错误原文，也不挂 cause（其中可能含签名或凭据派生内容）。不写日志。
import { UnionError } from '../domain/types.ts';
import type { UnionTransport, UnionTransportRequest } from './replay.ts';

function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

function requestInit(request: UnionTransportRequest): RequestInit {
  const init: RequestInit = {
    method: request.method,
    headers: { ...request.headers },
    // 拒绝跳转：避免被引到非 https 地址或别的主机。
    redirect: 'error',
  };
  if (request.body !== undefined) init.body = request.body;
  if (request.signal !== undefined) init.signal = request.signal;
  return init;
}

/** Uses the runtime fetch; cancellation/deadlines belong to the request's AbortSignal. */
export function createUnionHttpTransport(): UnionTransport {
  return async (request) => {
    if (!isHttpsUrl(request.url)) {
      throw new UnionError(
        'invalid_endpoint',
        `${request.platform} transport: only https URLs are allowed`,
        request.platform,
      );
    }
    try {
      const response = await fetch(request.url, requestInit(request));
      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return { status: response.status, headers, body };
    } catch (error) {
      const aborted =
        error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new UnionError(
        'upstream_unavailable',
        `${request.platform} transport: ${aborted ? 'request aborted' : 'network failure'}`,
        request.platform,
      );
    }
  };
}
