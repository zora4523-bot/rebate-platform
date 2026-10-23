// B3-09e (BR-AI-22 细则「哈希」, D10-137 ⑥): the user hash key comes from AGENT_USER_HASH_KEY and is
// read only by the wiring layer; the hash is HMAC-SHA256 over the user id. No database here.
import { createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  agentUserHash,
  createAgentDataPurge,
  purgedCardText,
  readAgentUserHashKey,
} from '../../../../apps/api/src/modules/agent/deletion/index.ts';

const KEY = 'synthetic-agent-user-hash-key';
const USER = '019a0000-0000-7000-8000-0000000000e1';
const OTHER_USER = '019a0000-0000-7000-8000-0000000000e2';

function hmac(key: string, userId: string): string {
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(userId, 'utf8').digest('hex');
}

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

it('[AC-B3-09e#11][BR-AI-22] readAgentUserHashKey 有值时原样返回 AGENT_USER_HASH_KEY', () => {
  expect(readAgentUserHashKey({ AGENT_USER_HASH_KEY: KEY })).toBe(KEY);
  expect(readAgentUserHashKey({ AGENT_USER_HASH_KEY: '合成密钥-ü-1', OTHER: 'x' })).toBe(
    '合成密钥-ü-1',
  );
  expect(readAgentUserHashKey({ AGENT_USER_HASH_KEY: 'k' })).toBe('k');
});

it('[AC-B3-09e#11][BR-AI-22] readAgentUserHashKey 在缺失、空串、只有空白时抛错', () => {
  // The present case first: a skeleton that throws for everything is not a refusal.
  expect(readAgentUserHashKey({ AGENT_USER_HASH_KEY: KEY })).toBe(KEY);
  const missing: readonly Readonly<Record<string, string | undefined>>[] = [
    {},
    { AGENT_USER_HASH_KEY: undefined },
    { AGENT_USER_HASH_KEY: '' },
    { AGENT_USER_HASH_KEY: ' ' },
    { AGENT_USER_HASH_KEY: ' \t\n ' },
    { agent_user_hash_key: KEY },
    { PHONE_HMAC_KEY: KEY },
  ];
  for (const env of missing) refusal(() => readAgentUserHashKey(env));
});

it('[AC-B3-09e#11][BR-AI-22] createAgentDataPurge 的 userHashKey 为空或只有空白时抛错（D10-137 ⑥）', () => {
  const port = createAgentDataPurge({ userHashKey: KEY });
  expect(typeof port.purgeAgentDataForUser).toBe('function');
  for (const userHashKey of ['', ' ', '\t\n']) {
    refusal(() => createAgentDataPurge({ userHashKey }));
  }
});

it('[AC-B3-09e#7][BR-AI-22] agentUserHash 是以密钥做的 HMAC-SHA256（64 位小写 hex），不是裸 sha256', () => {
  for (const [key, userId] of [
    [KEY, USER],
    [KEY, OTHER_USER],
    ['合成密钥', USER],
    ['k', USER],
  ] as const) {
    const hash = agentUserHash(key, userId);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hmac(key, userId));
    expect(hash).not.toBe(createHash('sha256').update(userId, 'utf8').digest('hex'));
    expect(agentUserHash(key, userId)).toBe(hash);
  }
});

it('[AC-B3-09e#7][BR-AI-22] agentUserHash 换密钥或换用户结果都不同', () => {
  const base = agentUserHash(KEY, USER);
  expect(agentUserHash(`${KEY}-rotated`, USER)).not.toBe(base);
  expect(agentUserHash(KEY, OTHER_USER)).not.toBe(base);
  expect(base).not.toContain(USER.replaceAll('-', ''));
});

it('[AC-B3-09e#4][BR-AI-22] purgedCardText 是固定占位「内容已删除」', () => {
  expect(purgedCardText()).toBe('内容已删除');
  expect(purgedCardText()).toBe(purgedCardText());
});
