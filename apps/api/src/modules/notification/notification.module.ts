import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  JOB_QUEUE,
  ROOT_LOGGER,
  registerEventConsumer,
  type Clock,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import { createMessageReader, type MessageReader } from './application/message-read.ts';
import {
  createPushTokenReporter,
  type PushTokenConfigReader,
  type PushTokenReporter,
} from './application/push-token-report.ts';
import { PUSH_TOKEN_REPORTER, PushTokenController } from './http/public/push-token.controller.ts';
import {
  INBOX_MESSAGES,
  MESSAGE_READER,
  MessagesController,
} from './http/public/messages.controller.ts';
import { createInboxMessages, type InboxMessages } from './application/inbox-messages.ts';
import {
  createNotificationSettings,
  type NotificationSettingsService,
} from './application/notification-settings.ts';
import {
  NOTIFICATION_SETTINGS,
  NotificationSettingsController,
} from './http/public/notification-settings.controller.ts';
import type { TaobaoReauthReader } from '../linking/index.ts';
import {
  RISK_STATE_MESSAGE_CONSUMER,
  createRiskStateMessageHandler,
} from './application/risk-state-message.ts';
import {
  APPEAL_RESULT_MESSAGE_CONSUMER,
  createAppealResultMessageHandler,
} from './application/appeal-result-message.ts';

/** Nest token of the worker's registration of the risk state message consumer (B1-12g). */
export const RISK_STATE_MESSAGE_CONSUMER_TOKEN = Symbol('RISK_STATE_MESSAGE_CONSUMER');

/** Nest token of the worker's registration of the appeal result message consumer (B1-12p). */
export const APPEAL_RESULT_MESSAGE_CONSUMER_TOKEN = Symbol('APPEAL_RESULT_MESSAGE_CONSUMER');

/** Build on first read so module startup never touches the database handle. */
function lazyMessageReader(db: Kysely<Database>): MessageReader {
  let reader: MessageReader | undefined;
  return {
    get: async (query) => {
      reader ??= createMessageReader({ db });
      return reader.get(query);
    },
  };
}

/** Build on first call so module startup never touches the database handle. */
function lazyInboxMessages(db: Kysely<Database>, clock: Clock): InboxMessages {
  let inbox: InboxMessages | undefined;
  const get = (): InboxMessages => (inbox ??= createInboxMessages({ db, clock }));
  return {
    list: async (query) => get().list(query),
    markRead: async (command) => get().markRead(command),
    unreadCount: async (owner) => get().unreadCount(owner),
  };
}

/** B1-12m: build on first call so module startup never touches the database handle. */
function lazyNotificationSettings(db: Kysely<Database>, clock: Clock): NotificationSettingsService {
  let settings: NotificationSettingsService | undefined;
  const get = (): NotificationSettingsService =>
    (settings ??= createNotificationSettings({ db, clock }));
  return {
    get: async (owner) => get().get(owner),
    update: async (owner, values) => get().update(owner, values),
  };
}

/** API-only assembly; content implements the configuration port in app.module. */
export class NotificationModule {
  static forApi(
    configReader: (db: Kysely<Database>, clock: Clock) => PushTokenConfigReader,
  ): DynamicModule {
    return {
      module: NotificationModule,
      controllers: [PushTokenController, MessagesController, NotificationSettingsController],
      providers: [
        {
          provide: MESSAGE_READER,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): MessageReader =>
            db === undefined
              ? {
                  get: () =>
                    Promise.reject(new Error('notification: message reads need the database')),
                }
              : lazyMessageReader(db),
        },
        {
          provide: INBOX_MESSAGES,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): InboxMessages => {
            if (db !== undefined) return lazyInboxMessages(db, clock);
            const missing = (): Promise<never> =>
              Promise.reject(new Error('notification: inbox messages need the database'));
            return { list: missing, markRead: missing, unreadCount: missing };
          },
        },
        {
          provide: NOTIFICATION_SETTINGS,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): NotificationSettingsService => {
            if (db !== undefined) return lazyNotificationSettings(db, clock);
            const missing = (): Promise<never> =>
              Promise.reject(new Error('notification: notification settings need the database'));
            return { get: missing, update: missing };
          },
        },
        {
          provide: PUSH_TOKEN_REPORTER,
          inject: [CLOCK, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
          ): PushTokenReporter =>
            db === undefined
              ? {
                  report: () =>
                    Promise.reject(new Error('notification: push reports need the database')),
                }
              : createPushTokenReporter({
                  db,
                  clock,
                  logger: logger.child({ module: 'notification' }),
                  config: configReader(db, clock),
                }),
        },
      ],
    };
  }

  /**
   * Worker-only assembly (B1-12g): registers the risk.state_changed consumer on queue
   * `evt.notification-risk-state`. Registration runs no statement; the handler touches the
   * database only inside the consumer's transaction. Without a database handle or queue nothing
   * is registered and one info line `risk_state_message_disabled` is logged.
   * B1-12p: likewise the appeal.resolved consumer on queue `evt.notification-appeal-result`
   * (APPEAL_RESULT, BR-ID-36); disabled line `appeal_result_message_disabled`.
   */
  static forWorker(ports: {
    /** linking's read-only Taobao binding port, assembled by app.module (dependency inversion). */
    readonly taobaoReauthReader: TaobaoReauthReader;
  }): DynamicModule {
    return {
      module: NotificationModule,
      providers: [
        {
          provide: RISK_STATE_MESSAGE_CONSUMER_TOKEN,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
          ): boolean => {
            if (db === undefined || queue === undefined) {
              logger.info({ consumer: RISK_STATE_MESSAGE_CONSUMER }, 'risk_state_message_disabled');
              return false;
            }
            registerEventConsumer(queue, {
              consumer: RISK_STATE_MESSAGE_CONSUMER,
              db,
              logger,
              handler: createRiskStateMessageHandler({
                clock,
                taobaoReauthReader: ports.taobaoReauthReader,
              }),
            });
            return true;
          },
        },
        {
          provide: APPEAL_RESULT_MESSAGE_CONSUMER_TOKEN,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
          ): boolean => {
            if (db === undefined || queue === undefined) {
              logger.info(
                { consumer: APPEAL_RESULT_MESSAGE_CONSUMER },
                'appeal_result_message_disabled',
              );
              return false;
            }
            registerEventConsumer(queue, {
              consumer: APPEAL_RESULT_MESSAGE_CONSUMER,
              db,
              logger,
              handler: createAppealResultMessageHandler({ clock }),
            });
            return true;
          },
        },
      ],
    };
  }
}

Module({})(NotificationModule);
