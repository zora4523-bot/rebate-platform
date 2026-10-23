// B3-09e unit tests (implementer's own, no database): input is refused before the transaction is
// touched, and the hash is stable for the canonical lowercase user id.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { agentUserHash, createAgentDataPurge, type PurgeAgentDataInput } from './index.ts';

const KEY = 'unit-agent-user-hash-key';
const USER = '019a0000-0000-7000-8000-0000000000f1';
const AT = new Date(Date.UTC(2026, 11, 1));

/** A transaction stand-in that records any use; a refused call must never touch it. */
function untouchedTrx(): { trx: Transaction<DB>; touched: () => boolean } {
  let used = false;
  const trx = new Proxy(
    {},
    {
      get() {
        used = true;
        throw new Error('transaction used');
      },
    },
  ) as unknown as Transaction<DB>;
  return { trx, touched: () => used };
}

it('[AC-B3-09e#12] 参数非法时在发出任何 SQL 前拒绝', async () => {
  const port = createAgentDataPurge({ userHashKey: KEY });
  const invalid: readonly unknown[] = [
    null,
    { appId: '', userId: USER, at: AT },
    { appId: 'app', userId: 'not-a-uuid', at: AT },
    { appId: 'app', userId: USER, at: '2026-12-01T00:00:00Z' },
    { appId: 'app', userId: USER, at: new Date(Number.NaN) },
  ];
  for (const input of invalid) {
    const { trx, touched } = untouchedTrx();
    const call = port.purgeAgentDataForUser(trx, input as PurgeAgentDataInput);
    await expect(call).rejects.toBeInstanceOf(TypeError);
    expect(touched()).toBe(false);
  }
});

it('[AC-B3-09e#7] 哈希是 64 位小写 hex，同一密钥同一用户结果稳定', () => {
  const hash = agentUserHash(KEY, USER);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(agentUserHash(KEY, USER)).toBe(hash);
  expect(() => agentUserHash(' ', USER)).toThrow();
});
