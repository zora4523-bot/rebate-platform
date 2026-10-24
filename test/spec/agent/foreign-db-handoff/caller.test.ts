// B3-08k (D10-294): the stream entry's caller resolution (stream/mount/caller.ts, AGENT_CALLER of
// AgentModule.forStream) uses the identity caller reader app.module built and provides as
// agentCallerReaderToken(); agent takes no reader factory and feeds it no database handle. New
// wording of "no database → null": no caller reader (app.module provides null without a database
// handle) → AGENT_CALLER is null, with or without a handle. The provider is called with its own
// inject list resolved by token (kit.callFactory); the database is compile-only.
import { expect, it } from 'vitest';

import { AgentModule } from '../../../../apps/api/src/modules/agent/agent.module.ts';
import {
  AGENT_CALLER,
  agentCallerReaderToken,
  type AgentCallerReader,
  type AgentCallerResolver,
  type AgentStreamRequest,
} from '../../../../apps/api/src/modules/agent/stream/mount/caller.ts';
import type { AgentStreamModuleOptions } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { APP_CONFIG, DB, loadConfig } from '../../../../apps/api/src/modules/platform/index.ts';
import { APP, callFactory, compileOnlyDb, injectTokens, providerOf } from './kit.ts';

const DEVICE = '0192f3a0-0000-7000-8000-0000000000d1';
const USER = '0192f3a0-0000-7000-8000-0000000000e1';

/** identity's AgentCallerReader stand-in, recording each call. */
class FakeCallerReader implements AgentCallerReader {
  readonly calls: string[][] = [];
  phoneBound(appId: string, userId: string): Promise<boolean> {
    this.calls.push(['phoneBound', appId, userId]);
    return Promise.resolve(true);
  }
  deviceHash(appId: string, deviceId: string): Promise<string | null> {
    this.calls.push(['deviceHash', appId, deviceId]);
    return Promise.resolve(`dh:${deviceId}`);
  }
}

/**
 * AGENT_CALLER's provider of AgentModule.forStream, given only what app.module still passes (no
 * caller or consent reader factory; the cast keeps this valid while those options still exist).
 */
function callerProvider() {
  const stream = AgentModule.forStream({} as AgentStreamModuleOptions);
  return providerOf(stream.providers, AGENT_CALLER);
}

function request(id: string, principal?: { uid: string; app_id: string; device_id: string }) {
  const value: AgentStreamRequest = {
    id,
    ip: '203.0.113.7',
    headers: principal === undefined ? { 'x-app-id': APP, 'x-device-id': DEVICE } : {},
    params: {},
  };
  // Stage ②'s verified token context, as the request check attaches it (tokenPrincipal).
  return principal === undefined ? value : Object.assign(value, { principal });
}

it('[AC-B3-08k#5][BR-AI-02] AGENT_CALLER 用注入的、已构造好的 identity 调用方读取器（agentCallerReaderToken()）：游客与已登录会员的 deviceHash / phoneBound 都来自它；不再接收读取器工厂，不发查询', async () => {
  const token = agentCallerReaderToken();
  expect(agentCallerReaderToken(), 'the same symbol on every call').toBe(token);
  const provider = callerProvider();
  expect(injectTokens(provider)).toContain(token);

  const reader = new FakeCallerReader();
  const queries: string[] = [];
  const values = new Map<unknown, unknown>([
    [APP_CONFIG, loadConfig({ APP_ENV: 'test' })],
    [DB, compileOnlyDb(queries)],
    [token, reader],
  ]);
  const resolve = callFactory(provider, values) as AgentCallerResolver | null;
  expect(resolve).not.toBeNull();

  const guest = await resolve!(request('req-guest'));
  expect(reader.calls).toEqual([['deviceHash', APP, DEVICE]]);
  expect(guest).toMatchObject({
    appId: APP,
    deviceId: DEVICE,
    userId: null,
    deviceHash: `dh:${DEVICE}`,
    phoneBound: false,
    traceId: 'req-guest',
  });
  expect(guest.ipKey).toMatch(/^[0-9a-f]{64}$/u);

  reader.calls.length = 0;
  const signedIn = await resolve!(
    request('req-member', { uid: USER, app_id: APP, device_id: DEVICE }),
  );
  expect(reader.calls).toEqual([
    ['deviceHash', APP, DEVICE],
    ['phoneBound', APP, USER],
  ]);
  expect(signedIn).toMatchObject({ appId: APP, userId: USER, phoneBound: true });
  expect(queries).toEqual([]);
});

it('[AC-B3-08k#5] 新口径：没有调用方读取器（app.module 在无库时提供 null）→ AGENT_CALLER 为 null，有没有数据库句柄都一样；agent 不自建读取器', () => {
  const token = agentCallerReaderToken();
  const provider = callerProvider();
  const config = loadConfig({ APP_ENV: 'test' });
  const queries: string[] = [];
  const withoutDb = new Map<unknown, unknown>([
    [APP_CONFIG, config],
    [token, null],
  ]);
  expect(callFactory(provider, withoutDb), 'no reader, no database').toBeNull();
  const withDb = new Map<unknown, unknown>([
    [APP_CONFIG, config],
    [DB, compileOnlyDb(queries)],
    [token, null],
  ]);
  expect(callFactory(provider, withDb), 'no reader, a database handle').toBeNull();
  expect(queries).toEqual([]);
});
