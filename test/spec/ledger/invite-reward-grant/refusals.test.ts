import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import {
  LedgerError,
  createInviteRewardGrantWriter,
  createLedger,
  type InviteRewardGrantRequest,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

const INSTANT = '2032-06-15T15:59:59.999Z';
const APP = 'invite-grant-unit';
const INVITER = '00000000-0000-4000-8000-000000000001';
const INVITEE = '00000000-0000-4000-8000-000000000002';

/** A transaction handle that fails on any use: the checks must run before any SQL. */
function untouchable(): Transaction<DB> {
  const handle = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`database handle used: ${String(property)}`);
      },
    },
  );
  return handle as unknown as Transaction<DB>;
}

function valid(): InviteRewardGrantRequest {
  return {
    app_id: APP,
    invitee_id: INVITEE,
    party: 'inviter',
    user_id: INVITER,
    amount_fen: 1000n,
    at: new FixedClock(INSTANT).now(),
  };
}

const CASES: [string, () => InviteRewardGrantRequest][] = [
  ['amount_fen 为负', () => ({ ...valid(), amount_fen: -1n })],
  ['amount_fen 为 number 整数', () => ({ ...valid(), amount_fen: 1000 as unknown as bigint })],
  ['amount_fen 为非整数', () => ({ ...valid(), amount_fen: 10.5 as unknown as bigint })],
  ['amount_fen 为字符串', () => ({ ...valid(), amount_fen: '1000' as unknown as bigint })],
  ['party 不是 inviter / invitee', () => ({ ...valid(), party: 'self' as unknown as 'inviter' })],
  ['invitee 一方付给了别人', () => ({ ...valid(), party: 'invitee', user_id: INVITER })],
  ['inviter 一方付给了被邀请人本人', () => ({ ...valid(), user_id: INVITEE })],
  ['app_id 为空', () => ({ ...valid(), app_id: '' })],
  ['invitee_id 为空', () => ({ ...valid(), invitee_id: '' })],
  ['user_id 为空', () => ({ ...valid(), user_id: '' })],
  ['at 不是有效时间', () => ({ ...valid(), at: new Date(Number.NaN) })],
];

it.each(CASES)(
  '[AC-B2-16b#13] 入参 %s：SQL 之前拒绝，LedgerError INVALID_INPUT',
  async (_name, make) => {
    const writer = createInviteRewardGrantWriter({
      ledger: createLedger({ clock: new FixedClock(INSTANT) }),
    });
    const error = await writer.grant(untouchable(), make()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
  },
);
