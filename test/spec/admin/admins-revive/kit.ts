import type { DB } from '@couli/db';
import type { Selectable, Updateable } from 'kysely';
import type { Seed } from '../accounts/kit.ts';
import { signedIn, type Harness, type Session } from '../auth/kit.ts';
import { alive, bodyOf, ok, type Setup } from '../admins-write/kit.ts';

export { alive, dead, harness, setup, signInAgain } from '../admins-write/kit.ts';
export { binding, login, success, totp, type Session } from '../auth/kit.ts';

/** The voiding changes a login's last step can interleave with (B1-34h r2 S2). */
export type Voiding = 'disable' | 'reset';

/**
 * [label, voiding instant, admin_token issue], both in ms after a whole second. The token's iat
 * (whole seconds) is never earlier than the voiding instant, so the instant alone does not void it.
 */
export const WINDOWS = [
  ['跨整秒 20 毫秒', 990, 1_010],
  ['签发恰在下一整秒', 500, 1_000],
  ['作废恰在整秒、同一秒内签发', 0, 400],
] as const;

type Row = Selectable<DB['admin_users']>;

/** The columns of admin_users `operation` changes (row_version aside). */
function changed(operation: Voiding, row: Row): Updateable<DB['admin_users']> {
  return operation === 'disable'
    ? { status: row.status }
    : {
        totp_secret_cipher: row.totp_secret_cipher,
        totp_bound_at: row.totp_bound_at,
        totp_last_step: row.totp_last_step,
      };
}

/**
 * Leaves `a` as the interleaving does: `operation` reads its voiding instant and commits, while
 * the login's last step wrote on the row as it was before the change, issued its admin_token in a
 * whole second no earlier than that instant and read the voiding instant before the operation
 * stored it. Replayed in order on the real admin entry: the operation through the console, the
 * row put back as the login read it, the login, the row as the operation committed it. Returns
 * the session of that login, which by then the admin check refuses only for the account's state.
 */
export async function raced(
  h: Harness,
  f: Setup,
  a: Seed,
  operation: Voiding,
  voidMs: number,
  issueMs: number,
): Promise<Session> {
  const step = await f.issue();
  const second = Math.ceil(f.clock.now().getTime() / 1000) * 1000 + 1000;
  const before = await f.row(a.id);
  f.clock.set(new Date(second + voidMs));
  await ok(
    await f.send(operation, { token: f.token, id: a.id, body: bodyOf(operation)!, step }),
    operation,
  );
  const committed = await f.row(a.id);
  const write = (row: Row) =>
    h.db.updateTable('admin_users').set(changed(operation, row)).where('id', '=', a.id).execute();

  await write(before);
  f.clock.set(new Date(second + issueMs));
  const session = await signedIn(f, a);
  // Premise: the voiding instant the operation wrote does not void this session by itself.
  await alive(f, session.admin_token);
  await write(committed);
  return session;
}
