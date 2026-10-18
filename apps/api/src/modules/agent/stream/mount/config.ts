import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  createContentReader,
  type ContentConfig,
  type ContentReader,
} from '../../../content/index.ts';
import type { Clock } from '../../../platform/index.ts';

/** Refresh through content's public reader; never extend its older, process-wide cache. */
export function createAgentSwitchReader(
  db: Kysely<DB>,
  clock: Clock,
  ordinary: Pick<ContentReader, 'configValue'>,
): Pick<ContentReader, 'configValue'> {
  const cache = new Map<string, { at: number; value: ContentConfig | null }>();
  return {
    async configValue(appId, key) {
      if (!key.startsWith('agent.')) return ordinary.configValue(appId, key);
      const id = JSON.stringify([appId, key]);
      const at = clock.now().getTime();
      const hit = cache.get(id);
      if (hit && at >= hit.at && at - hit.at < 1_000) return structuredClone(hit.value);
      cache.delete(id);
      const value = await createContentReader({ db, clock }).configValue(appId, key);
      // Age starts before the query: a slow read must not extend the freshness window.
      cache.set(id, { at, value });
      return structuredClone(value);
    },
  };
}
