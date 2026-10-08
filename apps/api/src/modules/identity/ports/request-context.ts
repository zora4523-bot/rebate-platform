import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { CheckedRequest } from '../../platform/index.ts';

/** Structural ports: identity does not depend on catalog or linking. */
export interface IdentityRequest extends CheckedRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export interface IdentityContext {
  current(): Promise<{
    readonly appId: string;
    readonly userId: string | null;
    readonly deviceId: string | null;
  }>;
}

export interface IdentityAttrCodeReader {
  attrCode(appId: string, userId: string): Promise<string | null>;
}

export function createIdentityViewerContext(request: IdentityRequest): IdentityContext {
  void request;
  throw new Error('NotImplemented: createIdentityViewerContext');
}

export function createIdentityCallerContext(request: IdentityRequest): IdentityContext {
  void request;
  throw new Error('NotImplemented: createIdentityCallerContext');
}

export function createIdentityAttrCodeReader(db: Kysely<DB>): IdentityAttrCodeReader {
  void db;
  throw new Error('NotImplemented: createIdentityAttrCodeReader');
}
