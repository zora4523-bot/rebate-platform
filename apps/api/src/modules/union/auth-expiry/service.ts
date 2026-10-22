import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ConfigValue, ContentReader } from '../../content/index.ts';
import type { SiteAuthAlertPort } from '../../notification/index.ts';
import type {
  Clock,
  FieldCrypto,
  JobQueue,
  ReceivedJob,
  RootLogger,
} from '../../platform/index.ts';
import type { RegisteredPlatform } from '../domain/types.ts';

// Test phase: the runtime constant is added by the implementer; no initialized bindings here.
export type UnionAuthQueue = 'union-auth';
export type SiteAuthProbeResult =
  | { kind: 'ok' }
  | { kind: 'auth_invalid'; error: string }
  | { kind: 'transient'; error: string }
  | { kind: 'unsupported' };
export interface SiteAuthAccount {
  appId: string;
  platform: RegisteredPlatform;
  unionAccountId: string;
}
export interface SiteAuthProbe {
  probe(account: SiteAuthAccount): Promise<SiteAuthProbeResult>;
}
export interface SiteAuthRefresher {
  refresh(
    account: SiteAuthAccount,
  ): Promise<{ ok: true; expiresAt: Date | null } | { ok: false; error: string }>;
}
export interface SiteAuthMonitorOptions {
  db: Kysely<DB>;
  clock: Clock;
  queue: JobQueue;
  logger: RootLogger;
  crypto: FieldCrypto;
  config: Pick<ContentReader, 'configValue'>;
  probe: SiteAuthProbe;
  refresher?: SiteAuthRefresher;
  alerts: SiteAuthAlertPort;
}
export interface SiteAuthMonitor {
  dailyCheck(): Promise<void>;
  probeRetry(appId: string, unionAccountId: string): Promise<void>;
  expiryDue(appId: string, unionAccountId: string, expiresAt: string): Promise<void>;
  reportAuthFailure(input: SiteAuthAccount & { error: string }): Promise<void>;
  deliverAlerts(appId: string, unionAccountId: string): Promise<void>;
  seed(): Promise<void>;
  handle(job: ReceivedJob): Promise<void>;
  heal(): Promise<void>;
}
export function createSiteAuthMonitor(options: SiteAuthMonitorOptions): SiteAuthMonitor {
  void options;
  throw new Error('NotImplemented: createSiteAuthMonitor');
}
export function encodeAlertPhones(crypto: FieldCrypto, phones: readonly string[]): ConfigValue {
  void crypto;
  void phones;
  throw new Error('NotImplemented: encodeAlertPhones');
}
export function decodeAlertPhones(crypto: FieldCrypto, value: ConfigValue): string[] {
  void crypto;
  void value;
  throw new Error('NotImplemented: decodeAlertPhones');
}
export function alertPhoneId(crypto: FieldCrypto, phone: string): string {
  void crypto;
  void phone;
  throw new Error('NotImplemented: alertPhoneId');
}
