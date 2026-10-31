import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { expect, vi, type Mock } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DataokeClient,
  type DataokeClientOptions,
  type DataokeCredentials,
  type DataokeRandom,
  type DataokeWarning,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';

// Task-local AC labels ([AC-B1-04m#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：网关、路径、appKey、secret 都是合成值，不是任何大淘客接口的录制或真实凭据；secret 是
// 低熵重复串（避免 gitleaks 高熵误报）。期望 signRan 一律由本目录用 node:crypto 按任务书文本规则独立算出。
// TODO(规划/11 §4.5): 外层响应形状与错误码取自大淘客公开文档摘录，待实测复录 — blocked on 大淘客录制

/** A deployment points this at https://openapi.dataoke.com; the client must use it as given. */
export const baseUrl = 'https://dataoke-gateway.invalid';
export const path = '/api/tb-service/synthetic-query';
export const version = 'v1.0.0';
export const appKey = 'test-app-key';
export const secret = 'plain-plain-plain-plain';
export const otherSecret = 'other-other-other-other';
/** Injected clock instant and its millisecond epoch timestamp (2026-01-01Z is 1767225600 s). */
export const instant = '2026-10-30T15:55:42.123Z';
export const timer = '1793375742123';
/** The fixed random source value and the nonce it must become. */
export const randomValue = 42;
export const nonce = '000042';
/** The bound the client passes to the random source: six decimal digits. */
export const NONCE_BOUND = 1_000_000;
export const formContentType = /^application\/x-www-form-urlencoded;\s*charset=utf-8$/i;

export function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

/** signRan computed here from the documented text rule (gz-41), independent of the client. */
export function expectedSignRan(
  key: string,
  time: string,
  once: string,
  appSecret: string,
): string {
  return md5(`appKey=${key}&timer=${time}&nonce=${once}&key=${appSecret}`);
}

export function response(body: unknown, status = 200): UnionTransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify(body),
  };
}

/** Documented success envelope: { time, code: 0, msg, data }. */
export function ok(data: unknown = {}): UnionTransportResponse {
  return response({ time: 1793375742200, code: 0, msg: '成功', data });
}

export function setup(overrides: Partial<DataokeClientOptions> = {}) {
  const clock = new FixedClock(instant);
  const credentials = vi.fn<() => Promise<DataokeCredentials>>(async () => ({
    appKey,
    appSecret: secret,
  }));
  const random = vi.fn<DataokeRandom>().mockReturnValue(randomValue);
  const transport = vi.fn<UnionTransport>().mockResolvedValue(ok());
  const warn = vi.fn<(event: DataokeWarning) => void>();
  const client = new DataokeClient({
    baseUrl,
    clock,
    credentials,
    random,
    transport,
    warn,
    ...overrides,
  });
  return { client, clock, credentials, random, transport, warn };
}

/** The request the transport received on call `index`. */
export function sent(transport: Mock<UnionTransport>, index = 0): UnionTransportRequest {
  const call = transport.mock.calls[index];
  expect(call, `transport call ${index}`).toBeDefined();
  return call![0];
}

/** The decoded query string; every field name must appear exactly once. */
export function queryFields(request: UnionTransportRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new URL(request.url).searchParams) {
    expect(Object.hasOwn(out, name), `query field ${name} appears once`).toBe(false);
    out[name] = value;
  }
  return out;
}

/** The decoded form body; every field name must appear exactly once. */
export function formFields(request: UnionTransportRequest): Record<string, string> {
  expect(request.body).toBeTypeOf('string');
  const out: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(request.body ?? '')) {
    expect(Object.hasOwn(out, name), `form field ${name} appears once`).toBe(false);
    out[name] = value;
  }
  return out;
}

/** The parameters a request carried: the query string for GET, the form body for POST. */
export function wireFields(request: UnionTransportRequest): Record<string, string> {
  return request.method === 'GET' ? queryFields(request) : formFields(request);
}

export async function unionFailure(
  run: () => unknown | Promise<unknown>,
  code: UnionErrorCode,
): Promise<UnionError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnionError);
  expect(caught).toMatchObject({ code, platform: 'taobao' });
  return caught as UnionError;
}

export function expectRedacted(value: unknown, markers: readonly string[]): void {
  const visible = `${String(value)}\n${JSON.stringify(value)}\n${inspect(value, { depth: null })}`;
  for (const marker of markers) expect(visible).not.toContain(marker);
}
