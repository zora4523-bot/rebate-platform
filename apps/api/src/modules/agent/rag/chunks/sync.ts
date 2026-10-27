// B3-08i: syncing app.agent_rule_chunks of one app with its published help / rule articles, read
// only through the injected content reader (app.module builds it; D10-386, as B3-08k). Missing
// (article_id, version, seq) chunks of current revisions are inserted as active; every other active
// chunk of the app (older version, offline, draft, not help / rule) is retired at the Clock's now.
// Repeating the call changes nothing (at-least-once delivery); a unique-key conflict on insert
// counts as already written. `db` is used for app.agent_rule_chunks only. Called by the agent worker
// on agent.rag.sync_interval_seconds (wiring with B3-08g).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { PublishedArticlesReader } from '../../../content/index.ts';
import type { Clock } from '../../../platform/index.ts';

export interface RuleChunkSyncOptions {
  /** Primary couli_app handle, for app.agent_rule_chunks only. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** content's published help / rule articles reader. */
  readonly articles: PublishedArticlesReader;
}

export interface RuleChunkSyncResult {
  /** Chunk rows this call inserted. */
  readonly inserted: number;
  /** Active chunk rows this call retired. */
  readonly retired: number;
}

export function syncRuleChunks(
  options: RuleChunkSyncOptions,
  appId: string,
): Promise<RuleChunkSyncResult> {
  void options;
  void appId;
  throw new Error('NotImplemented: syncRuleChunks');
}
