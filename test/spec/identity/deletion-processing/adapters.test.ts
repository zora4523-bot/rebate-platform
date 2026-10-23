// B1-15g: the two stand-ins identity offers app.module until the owners ship (brief §9.2 #3 ②,
// #4 funds; D10-137 ①):
// - closingAdjustmentFromBalance: available_fen on the caller's transaction, 0 → none_needed,
//   anything else (positive, or negative as an anomaly) → pending; never none_needed for a balance;
// - unconfiguredAppleTokenRevoker: every call rejects (counted as a failed attempt), never
//   pretends to revoke, and its error does not carry the token.
// No database: the transaction is an opaque object that must be passed through unchanged.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { identity } from './kit.ts';

it.each([
  { fen: 0n, state: 'none_needed' },
  { fen: 1n, state: 'pending' },
  { fen: 800n, state: 'pending' },
  { fen: 9_007_199_254_740_993n, state: 'pending' },
  { fen: -1n, state: 'pending' },
])(
  '[AC-B1-15g#35] closingAdjustmentFromBalance：available_fen=$fen → $state，同一 trx 与 {appId, userId} 交给余额端口',
  async ({ fen, state }) => {
    const api = await identity();
    const trx = { isTransaction: true } as unknown as Transaction<DB>;
    const seen: { trx: unknown; input: object }[] = [];
    const reader = api.closingAdjustmentFromBalance({
      async availableFen(given, input) {
        seen.push({ trx: given, input: { ...input } });
        return fen;
      },
    });
    expect(await reader.closingAdjustmentState(trx, { appId: 'couli', userId: 'u-1' })).toBe(state);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.trx).toBe(trx);
    expect(seen[0]!.input).toEqual({ appId: 'couli', userId: 'u-1' });
  },
);

it('[AC-B1-15g#36] unconfiguredAppleTokenRevoker：每次调用都拒绝（不假装成功），错误里不含 token', async () => {
  const api = await identity();
  const revoker = api.unconfiguredAppleTokenRevoker();
  const token = 'synthetic apple refresh 77c1';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await revoker.revoke({ appId: 'couli', refreshToken: token }).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).not.toContain(token);
  }
});
