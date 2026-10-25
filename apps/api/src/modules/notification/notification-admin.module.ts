// notification's admin console routes (B1-12z): /admin/v1/notify-channels* (CT-24t; 08 BR-TEXT-20
// 细则「短信渠道登记与后台渠道开关」). app.module imports this module on the admin entry only.
// Permission and step-up checks go through platform's AdminOperationGuard (notification never
// imports admin); each write and its audit row share one transaction (`auditWriter`: admin's
// writer bound to the transaction handle). The ports app.module assembles:
//   - verifyPhones: admin's read-only reader of the operator's verify phone (BR-ID-45);
//   - testSender: the entry's sender of the registration test SMS, provided under
//     notifySmsTestSenderToken() (the fake in local / test, which the HTTP tests script; the
//     Aliyun channel on staging / prod with the SMS_ variables);
//   - codeTtlSec: identity's BR-ID-05 code validity, which an SMS_CODE preview must state.
// Without a database or the field cipher (isolated HTTP tests) the routes still register and every
// call fails closed (50001).
import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  classifyTemplate,
  findBannedWords,
  getBannedWords,
  getFundTermKeys,
} from '../content/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  ROOT_LOGGER,
  type AppConfig,
  type AuditPort,
  type Clock,
  type FieldCrypto,
  type RootLogger,
} from '../platform/index.ts';
import { NotifyChannelsAdmin, type NotifyVerifyPhones } from './admin-channels/service.ts';
import {
  notifySmsTestSenderToken,
  type NotifySmsTestSender,
} from './admin-channels/sms-test-sender.ts';
import { createTemplateStore, type TemplateStore } from './admin-channels/store.ts';
import { AdminNotifyChannelsController } from './http/admin/notify-channels.controller.ts';
import { createNotifyValidators } from './http/admin/notify-channels.validation.ts';

/** D10-341: ordinary until specs/fund-term-keys.yaml registers them (personal data copy). */
const ORDINARY_UNTIL_LISTED: ReadonlySet<string> = new Set(['DATA_COPY_READY', 'DATA_COPY_CODE']);

/** BR-TEXT-12 细则「资金术语键」: a code in neither list counts as a fund code (D10-341 aside). */
export function isFundTemplateCode(code: string): boolean {
  const keys = getFundTermKeys();
  const listed = [...keys.fund_terms.notify_templates, ...keys.ordinary.notify_templates];
  if (!listed.includes(code) && ORDINARY_UNTIL_LISTED.has(code)) return false;
  return classifyTemplate(code, keys) === 'fund_terms';
}

/** BR-TEXT-13 forbidden words of an SMS text shown to users. */
function smsBannedWords(text: string): readonly string[] {
  return findBannedWords({ fragments: [{ text }] }, getBannedWords(), 'user_visible');
}

export interface NotificationAdminOptions {
  /** admin's audit writer bound to a transaction handle. */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /** admin's verify phone reader (decrypts with the field cipher). */
  readonly verifyPhones: (db: Kysely<Database>, crypto: FieldCrypto) => NotifyVerifyPhones;
  /** The entry's test SMS sender (one per entry process). */
  readonly testSender: (config: AppConfig, logger: RootLogger, clock: Clock) => NotifySmsTestSender;
  /** BR-ID-05 validity of the six-digit code, in seconds. */
  readonly codeTtlSec: number;
}

function unavailable(what: string): never {
  throw new Error(`notification: ${what} needs the database and the field cipher`);
}

export class NotificationAdminModule {
  static forAdmin(options: NotificationAdminOptions): DynamicModule {
    return {
      module: NotificationAdminModule,
      controllers: [AdminNotifyChannelsController],
      providers: [
        {
          provide: notifySmsTestSenderToken(),
          inject: [APP_CONFIG, ROOT_LOGGER, CLOCK],
          useFactory: (config: AppConfig, logger: RootLogger, clock: Clock) =>
            options.testSender(config, logger, clock),
        },
        {
          provide: NotifyChannelsAdmin,
          inject: [
            CLOCK,
            notifySmsTestSenderToken(),
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            sender: NotifySmsTestSender,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): NotifyChannelsAdmin => {
            let store: TemplateStore | undefined;
            let phones: NotifyVerifyPhones | undefined;
            return new NotifyChannelsAdmin({
              store: () => {
                if (db === undefined) return unavailable('the notify channel page');
                store ??= createTemplateStore({
                  db,
                  auditWriter: (trx) => options.auditWriter(trx, clock),
                });
                return store;
              },
              clock,
              sender,
              verifyPhones: () => {
                if (db === undefined || crypto === undefined) return unavailable('the test SMS');
                phones ??= options.verifyPhones(db, crypto);
                return phones;
              },
              validators: createNotifyValidators(),
              isFundCode: isFundTemplateCode,
              bannedWords: smsBannedWords,
              codeTtlSec: options.codeTtlSec,
            });
          },
        },
      ],
    };
  }
}

Module({})(NotificationAdminModule);
