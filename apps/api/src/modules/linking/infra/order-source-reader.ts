// B1-08q: orders' source backfill reader over linking's link_logs (BR-ATTR-15 ②③; window
// BR-ATTR-13 ③). The rows of one App, one user (link_logs.user_id) and one platform whose
// created_at lies in [from, to], both ends included, returned as stored: event, result_code,
// pid_scene and no_rebate are not filtered (orders' matchOrderSource decides what counts). One
// SELECT per call on the handle given, no cache, no write; a user id that is not a UUID owns no
// row (link_logs.user_id is uuid) and reads as [] without a query. Assembled by app.module.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface OrderSourceLogScope {
  readonly appId: string;
  readonly userId: string;
  readonly platform: string;
  readonly from: Date;
  readonly to: Date;
}

/** A raw link_logs row as orders' source backfill reads it. */
export interface OrderSourceLog {
  readonly id: bigint;
  readonly link_id: string | null;
  readonly event: string;
  readonly user_id: string | null;
  readonly platform: string | null;
  readonly product_key: string | null;
  readonly shop_id: string | null;
  readonly pid_scene: string | null;
  readonly scene: string | null;
  readonly agent_session_id: string | null;
  readonly result_code: number;
  readonly no_rebate: boolean;
  readonly no_rebate_reason: string | null;
  readonly created_at: Date;
}

export interface OrderSourceReader {
  linkLogs(input: OrderSourceLogScope): Promise<readonly OrderSourceLog[]>;
}

const LOG_COLUMNS = [
  'id',
  'link_id',
  'event',
  'user_id',
  'platform',
  'product_key',
  'shop_id',
  'pid_scene',
  'scene',
  'agent_session_id',
  'result_code',
  'no_rebate',
  'no_rebate_reason',
  'created_at',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createOrderSourceReader(db: Kysely<DB>): OrderSourceReader {
  return {
    async linkLogs(input) {
      if (!UUID.test(input.userId)) return [];
      return await db
        .withSchema('app')
        .selectFrom('link_logs')
        .select(LOG_COLUMNS)
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('platform', '=', input.platform)
        .where('created_at', '>=', input.from)
        .where('created_at', '<=', input.to)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
    },
  };
}
