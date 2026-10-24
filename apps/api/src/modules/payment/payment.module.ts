// B2-15b: the payment module on the api entry (task §9.1): the four /v1/pay/orders routes over
// the pay order use cases. app.module hands in content's configuration reader as a factory, so
// this module imports no other module's implementation; the business type registry follows
// APP_ENV (prod registers nothing); the channel set is FakePayChannel outside prod and empty in
// prod until the real adapters land (B2-15k: fail closed, payment/AGENTS.md rule 6). Without a
// database or job queue the use cases are not assembled and the routes fail closed (50001).
// The worker side (jobs/ handlers) is B2-15c / B2-15d.
import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../content/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  JOB_QUEUE,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type JobQueue,
  type RootLogger,
} from '../platform/index.ts';
import { createBizRegistry } from './application/biz-registry.ts';
import { PayChannelSet } from './application/pay-channel.ts';
import type { PayOrderDeps } from './application/pay-orders.ts';
import { PAY_ORDER_DEPS, PayOrdersController } from './http/public/pay-orders.controller.ts';
import { FakePayChannel } from './infra/channels/fake-pay-channel.ts';

export interface PaymentModuleOptions {
  /** content's ContentReader over the primary handle (pay.enabled, pay.channel_enabled.*, …). */
  readonly config: (db: Kysely<Database>, clock: Clock) => ContentReader;
}

/** The channels of an environment: synthetic outside prod; none in prod until B2-15k. */
export function payChannelSetFor(appEnv: AppConfig['appEnv']): PayChannelSet {
  if (appEnv === 'prod') return new PayChannelSet([]);
  return new PayChannelSet([new FakePayChannel('wechat_pay'), new FakePayChannel('alipay')]);
}

@Module({})
export class PaymentModule {
  static forApi(options: PaymentModuleOptions): DynamicModule {
    return {
      module: PaymentModule,
      controllers: [PayOrdersController],
      providers: [
        {
          provide: PayChannelSet,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): PayChannelSet => payChannelSetFor(config.appEnv),
        },
        {
          provide: PAY_ORDER_DEPS,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            PayChannelSet,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
            channels: PayChannelSet,
            db?: Kysely<Database>,
            queue?: JobQueue,
          ): PayOrderDeps | null =>
            db === undefined || queue === undefined
              ? null
              : {
                  db,
                  clock,
                  config: options.config(db, clock),
                  queue,
                  channels,
                  registry: createBizRegistry(config.appEnv),
                  logger: logger.child({ module: 'payment' }),
                },
        },
      ],
      exports: [PayChannelSet],
    };
  }
}
