// The read-only active-pid query of union (B1-19b) as linking uses it. linking only reads, so the
// union service is built with a verifier and an audit writer that refuse: no admin write can run
// through it.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { createUnionPidService, type UnionPidService } from '../../union/index.ts';

export type LinkingPidReader = Pick<UnionPidService, 'getActivePid'>;

export function createLinkingPidReader(db: Kysely<DB>, clock: Clock): LinkingPidReader {
  const service = createUnionPidService({
    db,
    clock,
    superVerifier: { verify: () => Promise.resolve(null) },
    auditWriter: () => ({
      append: () => Promise.reject(new Error('linking: union pid writes are not served here')),
    }),
  });
  return { getActivePid: (input) => service.getActivePid(input) };
}
