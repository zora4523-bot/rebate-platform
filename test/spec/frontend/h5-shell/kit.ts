import { existsSync, readFileSync } from 'node:fs';
import { expect, vi } from 'vitest';
import type { BridgeRequest, BridgeTransport, H5Token } from '@couli/bridge-sdk';

// 避免 Vite 在 jsdom 的 client 转换中将仓库目录改写为资源 URL。
const moduleUrl = import.meta.url;
export const ROOT = new URL('../../../../', moduleUrl);
export const BASE_URL = 'https://api.example.invalid';
export const HEALTH = { status: 'ok', entry: 'api', now: '2026-10-06T00:00:00Z' } as const;

export function requiredText(path: string): string {
  const url = new URL(path, ROOT);
  expect(existsSync(url), `required implementation asset: ${path}`).toBe(true);
  return readFileSync(url, 'utf8');
}

export function commonHeaders() {
  return { 'X-App-Id': 'fixture_brand', 'X-Platform': 'h5', 'X-App-Version': '1.0.0' };
}

export function envelope(data: unknown, code = 0, msg = '') {
  return { code, msg, data, trace_id: 'fixture-trace' };
}

/** In-memory HTTP boundary only; no network or listening socket. */
export function transport(...replies: { body: unknown; status?: number }[]) {
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    const reply = replies[requests.length - 1];
    expect(reply, 'unexpected extra request or replay').toBeDefined();
    return new Response(JSON.stringify(reply!.body), {
      status: reply!.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetch, requests };
}

export function installTokenBridge(...scopes: H5Token['scope'][]) {
  const postMessage = vi.fn((request: BridgeRequest) => {
    const index = postMessage.mock.calls.length - 1;
    expect(request.method).toBe('auth.getH5Token');
    expect(scopes[index], 'unexpected token acquisition').toBeDefined();
    return {
      id: request.id,
      code: 0 as const,
      msg: '',
      data: {
        token: `fx.h5.tk-${index}`,
        scope: scopes[index],
        expire_at: '2099-01-01T00:00:00Z',
      },
    };
  });
  const bridge: BridgeTransport = {
    version: 1,
    methods: ['auth.getH5Token'],
    postMessage,
    subscribe: () => () => {},
  };
  vi.stubGlobal('__REBATE_BRIDGE__', bridge);
  return { bridge, postMessage };
}

/** Independent oracle: action values in this contract are single-line YAML scalars. */
export function errorCatalog(): { code: number; action: string; http: number }[] {
  const source = requiredText('contracts/error-codes.yaml');
  return source
    .split('\n  - code: ')
    .slice(1)
    .map((block) => {
      const code = Number(block.split('\n')[0]);
      const action = /^    action: (.+)$/m.exec(block)?.[1];
      const http = /^    http: (\d+)$/m.exec(block)?.[1];
      expect(action, `contract action ${code}`).toBeDefined();
      expect(http, `contract status ${code}`).toBeDefined();
      return { code, action: action!, http: Number(http) };
    });
}
