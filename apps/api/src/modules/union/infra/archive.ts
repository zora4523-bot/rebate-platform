import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { UnionTransport } from './replay.ts';

export interface ArchiveContext {
  readonly appId: string;
  readonly kind: string;
}

export interface ArchiveDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'warn' | 'error'>;
}

export function createArchivingTransport(
  inner: UnionTransport,
  deps: ArchiveDependencies,
): UnionTransport {
  void inner;
  void deps;
  throw new Error('NotImplemented: createArchivingTransport');
}
