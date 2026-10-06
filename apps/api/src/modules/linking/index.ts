// B1-06c test-stage public surface. Request identity comes only from CallerContext.
// Scene belongs to the request, independently of an inherited entry_source.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { LinkRegistrar, SourceLinkReader } from '../catalog/index.ts';
import type { Clock } from '../platform/index.ts';
import type { UnionPidService } from '../union/index.ts';

export interface Caller {
  readonly appId: string;
  readonly userId: string | null;
  readonly deviceId: string | null;
}

/** Port classes also serve as Nest injection tokens. */
export class CallerContext {
  current(): Promise<Caller> {
    throw new Error('NotImplemented: CallerContext.current');
  }
}

/** null means unavailable; it must never be replaced with a user ID. */
export class AttrCodeReader {
  attrCode(appId: string, userId: string): Promise<string | null> {
    void appId;
    void userId;
    throw new Error('NotImplemented: AttrCodeReader.attrCode');
  }
}

/** Structural match for content's configValue port, wired at the composition root. */
export class LinkingConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: DB['config_items']['value']; readonly version: number } | null> {
    void appId;
    void key;
    throw new Error('NotImplemented: LinkingConfigReader.configValue');
  }
}

export interface RegistrationContext {
  /** Validated against the contract scene enum; invalid/missing values fail with code 20001. */
  readonly scene: string;
  readonly subScene?: string | null;
  readonly agentSessionId?: string | null;
  readonly agentCardId?: string | null;
}

export interface LinkingOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  /** Omitted until identity wiring: unavailable, never a userId fallback. */
  readonly attrCodes?: AttrCodeReader;
  readonly config: LinkingConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly context: RegistrationContext;
}

/** Implements both catalog ports without making catalog depend on linking. */
export interface LinkRegistration extends LinkRegistrar, SourceLinkReader {}

export function createLinkRegistration(options: LinkingOptions): LinkRegistration {
  void options;
  throw new Error('NotImplemented: createLinkRegistration');
}

export function createGuestCallerContext(scope: {
  readonly appId: string;
  readonly deviceId: string | null;
}): CallerContext {
  void scope;
  throw new Error('NotImplemented: createGuestCallerContext');
}

export function createUnavailableAttrCodeReader(): AttrCodeReader {
  throw new Error('NotImplemented: createUnavailableAttrCodeReader');
}
