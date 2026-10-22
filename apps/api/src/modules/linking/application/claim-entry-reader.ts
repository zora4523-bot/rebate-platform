// B1-10h (J-6): linking's raw reads for the order page's claim-entry pin (08 BR-ATTR-17). linking
// owns link_logs and union_bindings, so orders reads them only through this port (orders/AGENTS.md
// rule 8). Read only, no cache, every query names schema app and runs on the handle it is given:
// - logs: link_logs of one app whose actor COALESCE(opener_user_id, user_id) is the user (an open
//   is the opener's, a convert without an opener falls back to the link's user), created_at in
//   [from, to] (both ends), across all platforms. Only the app, actor, time, event (convert | open)
//   and result_code = 0 filters are pushed down; pid_scene, no_rebate and no_rebate_reason are
//   returned as stored and orders decides what counts.
// - bindings: the user's union_bindings rows of that app, every platform and status, with
//   platform, status, bound_at and relation_id as stored.
// A user id that is not a UUID has no rows (never a PG 22P02). Read errors propagate unchanged.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface ClaimEntryScope {
  readonly app_id: string;
  readonly user_id: string;
}

export interface ClaimEntryLog {
  readonly app_id: string;
  readonly user_id: string | null;
  readonly id: bigint;
  readonly opener_user_id: string | null;
  readonly platform: string | null;
  readonly event: string;
  readonly result_code: number;
  readonly pid_scene: string | null;
  readonly no_rebate: boolean;
  readonly no_rebate_reason: string | null;
  readonly created_at: Date;
}

export interface ClaimEntryBinding extends ClaimEntryScope {
  readonly platform: string;
  readonly status: string;
  readonly bound_at: Date | null;
  readonly relation_id: string | null;
}

export interface ClaimEntryFacts {
  readonly logs: readonly ClaimEntryLog[];
  readonly bindings: readonly ClaimEntryBinding[];
}

/** Raw linking facts across platforms; closed time range and COALESCE(opener_user_id,user_id).
 * Only app/actor/time/event/result filters may be pushed down; no pinning judgement here. */
export interface ClaimEntryReader {
  read(
    input: ClaimEntryScope & { readonly from: Date; readonly to: Date },
  ): Promise<ClaimEntryFacts>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The link_logs events that are a jump-out (BR-ATTR-17); precompute and register never are. */
const JUMP_EVENTS = ['convert', 'open'] as const;

const LOG_COLUMNS = [
  'app_id',
  'user_id',
  'id',
  'opener_user_id',
  'platform',
  'event',
  'result_code',
  'pid_scene',
  'no_rebate',
  'no_rebate_reason',
  'created_at',
] as const;

const BINDING_COLUMNS = [
  'app_id',
  'user_id',
  'platform',
  'status',
  'bound_at',
  'relation_id',
] as const;

export function createClaimEntryReader(db: Kysely<DB>): ClaimEntryReader {
  // The handle is touched on first use only: module startup never needs the database.
  const app = () => db.withSchema('app');
  return {
    async read({ app_id, user_id, from, to }) {
      if (!UUID.test(user_id)) return { logs: [], bindings: [] };
      // Sequential on purpose: the handle may be a single-connection transaction.
      const logs: ClaimEntryLog[] = await app()
        .selectFrom('link_logs')
        .select(LOG_COLUMNS)
        .where('app_id', '=', app_id)
        .where((eb) => eb(eb.fn.coalesce('opener_user_id', 'user_id'), '=', user_id))
        .where('event', 'in', JUMP_EVENTS)
        .where('result_code', '=', 0)
        .where('created_at', '>=', from)
        .where('created_at', '<=', to)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      const bindings: ClaimEntryBinding[] = await app()
        .selectFrom('union_bindings')
        .select(BINDING_COLUMNS)
        .where('app_id', '=', app_id)
        .where('user_id', '=', user_id)
        .execute();
      return { logs, bindings };
    },
  };
}
