import type { RunEnding } from '../admission/index.ts';
import type {
  RedisRunRegistryDeps,
  RunFacts,
  RunRegistration,
  RunRegistry,
  TerminalFrame,
} from './types.ts';

export function createRedisRunRegistry(deps: RedisRunRegistryDeps): RunRegistry {
  if (!Number.isSafeInteger(deps.ttlSeconds) || deps.ttlSeconds < 1) {
    throw new RangeError('Run registry TTL must be a positive integer');
  }
  const key = (runId: string, fact: string): string => `run:${encodeURIComponent(runId)}:${fact}`;
  const read = async <T>(runId: string, fact: string): Promise<T | null> => {
    const value = await deps.redis.get(key(runId, fact));
    return value === null ? null : (JSON.parse(value) as T);
  };
  const save = (runId: string, fact: string, value: unknown): Promise<void> =>
    deps.redis.set(key(runId, fact), JSON.stringify(value), deps.ttlSeconds);

  return {
    async register(run): Promise<void> {
      await save(run.runId, 'owner', run);
    },
    async requestCancel(runId, ownerKey): Promise<'ok' | 'not_found'> {
      const run = await read<RunRegistration>(runId, 'owner');
      if (run === null || run.ownerKey !== ownerKey || (await read(runId, 'final')) !== null) {
        return 'not_found';
      }
      await save(runId, 'cancel', true);
      return 'ok';
    },
    async cancelRequested(runId): Promise<boolean> {
      return (await read(runId, 'cancel')) === true;
    },
    async recordFacts(runId, facts): Promise<void> {
      if (!Number.isSafeInteger(facts.cardsDelivered) || facts.cardsDelivered < 0) {
        throw new RangeError('Delivered card count must be a nonnegative integer');
      }
      // Independent, cumulative markers: an old card count cannot overwrite a newer one,
      // nor can a live update erase an ending, cancellation or terminal. No get/modify/set.
      // Refresh the complete prefix so all its markers survive for this save's full TTL.
      for (let n = 0; n <= facts.cardsDelivered; n += 1) {
        await save(runId, `delivered:${n}`, true);
      }
      if (facts.ending !== null) await save(runId, 'ending', facts.ending);
    },
    async facts(runId): Promise<RunFacts | null> {
      // Read the ending before the count: observing a completed ending must also observe
      // its already-saved delivery markers, never an older count sampled before that save.
      const ending = await read<RunEnding>(runId, 'ending');
      if ((await read(runId, 'delivered:0')) === null) return null;
      let cardsDelivered = 0;
      while ((await read(runId, `delivered:${cardsDelivered + 1}`)) === true) {
        cardsDelivered += 1;
      }
      return { ending, cardsDelivered };
    },
    async finish(runId, terminal): Promise<void> {
      await save(runId, 'final', terminal);
    },
    final: (runId): Promise<TerminalFrame | null> => read<TerminalFrame>(runId, 'final'),
  };
}
