import type { components } from '@couli/contracts-ts';
import type { Clock } from '../../platform/index.ts';
import type { UnionIdentity, UnionPidService, UnionRegistry } from '../../union/index.ts';
import type { AttrCodeReader, CallerContext, LinkingConfigReader } from '../ports.ts';
import type {
  LinkOpenConversionInput,
  LinkOpenJump,
  LinkOpenRequoteInput,
} from './link-open-requote.ts';

/** Internal adapter identity; only attr_code is carried in platform attribution parameters. */
export interface JdPddIdentity extends UnionIdentity {
  readonly subUnionId?: string;
  readonly custom_parameters?: Readonly<{ app: 'n'; uid?: string; sc: string; lk?: string }>;
}

export interface LinkConversionOptions {
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  readonly attrCodes?: AttrCodeReader;
  readonly config: LinkingConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly registry: Pick<UnionRegistry, 'get'>;
  readonly logger: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
}

export interface JdPddConversionInput extends LinkOpenConversionInput {
  readonly client: LinkOpenRequoteInput['client'];
  readonly idempotencyKey: string;
  readonly traceId: string;
}

export interface LinkConversion {
  convert(input: JdPddConversionInput): Promise<LinkOpenJump>;
}

/** Internal failure payload for the explicit no-rebate action, not a new HTTP error field. */
export interface LinkConversionFailure extends Error {
  readonly code: 50303;
  readonly noRebateUrl: string;
}

// TODO(规划/11 §4.5): 真实转链 — blocked on 推广位 / siteId。
export function createLinkOpenConversion(options: LinkConversionOptions): LinkConversion {
  void options;
  throw new Error('NotImplemented: createLinkOpenConversion');
}

/** Normalized adapter paths, not vendor response payloads. */
export interface LinkJumpPaths {
  readonly scheme: string;
  readonly universalLink: string;
  readonly h5: string;
}

/** Default matrix for non-production/demo; production capability admission is separate. */
export function buildDefaultLinkJump(input: {
  readonly platform: 'jd' | 'pdd';
  readonly client: LinkOpenRequoteInput['client'];
  readonly installed?: components['schemas']['InstalledState'];
  readonly paths: LinkJumpPaths;
  readonly expireAt: string;
}): LinkOpenJump {
  void input;
  throw new Error('NotImplemented: buildDefaultLinkJump');
}

/** Canonical unpromoted product page for the explicit no-rebate action; never a pasted URL. */
export function noRebateProductUrl(productKey: string): string {
  void productKey;
  throw new Error('NotImplemented: noRebateProductUrl');
}
