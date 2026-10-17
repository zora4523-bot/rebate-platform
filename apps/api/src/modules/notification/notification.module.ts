import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB, ROOT_LOGGER, type Clock, type RootLogger } from '../platform/index.ts';
import { createMessageReader, type MessageReader } from './application/message-read.ts';
import {
  createPushTokenReporter,
  type PushTokenConfigReader,
  type PushTokenReporter,
} from './application/push-token-report.ts';
import { PUSH_TOKEN_REPORTER, PushTokenController } from './http/public/push-token.controller.ts';
import { MESSAGE_READER, MessagesController } from './http/public/messages.controller.ts';

/** API-only assembly; content implements the configuration port in app.module. */
export class NotificationModule {
  static forApi(
    configReader: (db: Kysely<Database>, clock: Clock) => PushTokenConfigReader,
  ): DynamicModule {
    return {
      module: NotificationModule,
      controllers: [PushTokenController, MessagesController],
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
              : createMessageReader({ db }),
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
}

Module({})(NotificationModule);
