// B3-09i（D10-311 ③，BR-AI-22）：agent 的 index 导出 B3-09e 的注销清理端口，组合根才能把
// purgeAgentDataForUser 装进 identity 的 DeletionCleanupStep。只核对出口：与 ./deletion/index.ts 是同一个
// 引用、类型可赋给 DeletionCleanupStep、抽样行为一致；清理的 SQL 行为由 test/spec/agent/deletion 覆盖。
// 不连库：唯一一次调用 purgeAgentDataForUser 用非法输入，在第一条语句之前就被拒绝。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';

import * as agent from '../../../../apps/api/src/modules/agent/index.ts';
import {
  agentUserHash,
  createAgentDataPurge,
  purgedCardText,
  readAgentUserHashKey,
  type AgentDataPurge,
  type PurgeAgentDataInput,
  type PurgeAgentDataResult,
} from '../../../../apps/api/src/modules/agent/index.ts';
import * as deletion from '../../../../apps/api/src/modules/agent/deletion/index.ts';
import type {
  DeletionCleanupPort,
  DeletionCleanupStep,
} from '../../../../apps/api/src/modules/identity/index.ts';

const KEY = 'synthetic-agent-user-hash-key';
const USER = '019a0000-0000-7000-8000-0000000000e1';
const APP = 'couli';

/** The error a refused call threw; it must be a real refusal, not the skeleton. */
function refusal(call: () => unknown): Error {
  let caught: unknown;
  let returned = false;
  try {
    call();
    returned = true;
  } catch (error) {
    caught = error;
  }
  expect(returned, 'the call must be refused').toBe(false);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message, 'refused, not the skeleton').not.toMatch(/NotImplemented/);
  return caught as Error;
}

it('[AC-B3-09i#1][BR-AI-22] index 导出的四个函数与 ./deletion/index.ts 是同一个引用', () => {
  const names = [
    'createAgentDataPurge',
    'readAgentUserHashKey',
    'agentUserHash',
    'purgedCardText',
  ] as const;
  for (const name of names) {
    expect(typeof agent[name], `${name} is exported as a function`).toBe('function');
    expect(agent[name], `${name} is the deletion module's own function`).toBe(deletion[name]);
  }
  expect(createAgentDataPurge).toBe(deletion.createAgentDataPurge);
  expect(readAgentUserHashKey).toBe(deletion.readAgentUserHashKey);
  expect(agentUserHash).toBe(deletion.agentUserHash);
  expect(purgedCardText).toBe(deletion.purgedCardText);
  // Same behaviour as well as same reference (a sample, not B3-09e's full suite).
  expect(agentUserHash(KEY, USER)).toBe(deletion.agentUserHash(KEY, USER));
  expect(agentUserHash(KEY, USER)).toMatch(/^[0-9a-f]{64}$/);
});

it('[AC-B3-09i#2][BR-AI-22] createAgentDataPurge(…).purgeAgentDataForUser 可直接装进 DeletionCleanupStep', async () => {
  // Type level: these lines fail `pnpm typecheck` when the port and the step drift apart. The
  // skeleton throws NotImplemented on the next line; the implementation gets past it.
  const typedFactory: typeof deletion.createAgentDataPurge = createAgentDataPurge;
  const port: AgentDataPurge = createAgentDataPurge({ userHashKey: KEY });
  const step = port.purgeAgentDataForUser satisfies DeletionCleanupStep;
  const assembled: DeletionCleanupPort = step;
  const valid: PurgeAgentDataInput = { appId: APP, userId: USER, at: new Date(0) };
  void typedFactory;

  expect(typeof step).toBe('function');
  expect(typeof assembled).toBe('function');
  expect(step.length).toBe(2);
  // Unbound, as the assembly hands it over: a bad input is refused before any statement runs,
  // so the transaction is never touched (no database here).
  const untouched = {} as Transaction<DB>;
  const pending: Promise<PurgeAgentDataResult> = step(untouched, {
    ...valid,
    userId: 'not-a-uuid',
  });
  const refused: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(TypeError);
  expect((refused as Error).message).not.toMatch(/NotImplemented/);
});

it('[AC-B3-09i#3][BR-AI-22] 经 index 的 readAgentUserHashKey：有值原样返回，缺失、空串、全空白抛错', () => {
  // The present case first: a skeleton that throws for everything is not a refusal.
  expect(readAgentUserHashKey({ AGENT_USER_HASH_KEY: KEY })).toBe(KEY);
  expect(readAgentUserHashKey({ AGENT_USER_HASH_KEY: '合成密钥-ü-1', OTHER: 'x' })).toBe(
    '合成密钥-ü-1',
  );
  const missing: readonly Readonly<Record<string, string | undefined>>[] = [
    {},
    { AGENT_USER_HASH_KEY: undefined },
    { AGENT_USER_HASH_KEY: '' },
    { AGENT_USER_HASH_KEY: ' \t\n ' },
  ];
  for (const env of missing) refusal(() => readAgentUserHashKey(env));
});

it('[AC-B3-09i#4][BR-AI-22] 经 index 的 purgedCardText() 是迁移 0073 的占位「内容已删除」', () => {
  expect(purgedCardText()).toBe('内容已删除');
  expect(purgedCardText()).toBe(deletion.purgedCardText());
});
