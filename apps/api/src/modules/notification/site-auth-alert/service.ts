import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RegisteredPlatform } from '../../union/index.ts';

export interface SiteAuthAlertPlan {
  appId: string;
  unionAccountId: string;
  platform: RegisteredPlatform;
  authExpiresAt: Date | null;
  stage: string;
  code: 'UNION_AUTH_EXPIRING' | 'UNION_AUTH_EXPIRED';
  phoneIds: readonly string[];
}
export interface SiteAuthAlertPort {
  plan(trx: Transaction<DB>, plan: SiteAuthAlertPlan): Promise<number>;
  deliver(
    appId: string,
    unionAccountId: string,
    phones: readonly { phoneId: string; phone: string }[],
  ): Promise<void>;
}
export type TemplateSmsResult = 'accepted' | 'rejected' | 'unknown';
export interface TemplateSmsMessage {
  appId: string;
  phone: string;
  template: string;
  params: Record<string, string>;
}
export interface TemplateSmsSender {
  send(m: TemplateSmsMessage): Promise<TemplateSmsResult>;
}
export interface FakeTemplateSmsSender extends TemplateSmsSender {
  outbox(): readonly {
    phone: string;
    template: string;
    params: Record<string, string>;
    text: string;
  }[];
  enqueueResult(r: TemplateSmsResult): void;
}
export interface SiteAuthAlertOptions {
  db: Kysely<DB>;
  clock: Clock;
  sms: TemplateSmsSender;
  logger: RootLogger;
}
export function createSiteAuthAlertPort(o: SiteAuthAlertOptions): SiteAuthAlertPort {
  void o;
  throw new Error('NotImplemented: createSiteAuthAlertPort');
}
export function createFakeTemplateSmsSender(appEnv: string): FakeTemplateSmsSender {
  void appEnv;
  throw new Error('NotImplemented: createFakeTemplateSmsSender');
}
