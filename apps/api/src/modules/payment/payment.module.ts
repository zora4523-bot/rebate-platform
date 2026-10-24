// B2-15b / B2-15c: the payment module on the api entry (task B2-15b §9.1: the four /v1/pay/orders
// routes over the pay order use cases; B2-15c §9.1: the notification entry POST
// /notify/pay/<channel>), on the worker entry (B2-15c: the handler of queue `pay`; B2-15e adds
// refund.query) and, from B2-15e, on the admin entry (the console's original-route refund,
// http/admin/, over platform idempotency and admin's audit writer handed in by app.module).
// app.module hands in content's configuration reader as a factory, so this module imports no other
// module's implementation but ledger's posting port (LedgerModule, index.ts); the business type
// registry follows APP_ENV (prod registers nothing); the channel set is FakePayChannel outside
// prod and empty in prod until the real adapters land (B2-15k: fail closed, payment/AGENTS.md
// rule 6). Without a database or job queue the pay order use cases are not assembled and the
// routes fail closed (50001).
// The notification entry exists only in a process with a database (`notifyEntry`): it is outside
// the client contract and, without a database, the queue and the field cipher, nothing of a
// notification could be verified against an order or kept, so there is no route to register (the
// contract smoke of the entries builds without a database). On the api entry the module also
// installs the raw-body capture of the notification routes on the Fastify instance before it is
// ready (http/public/notify-body.ts), through Nest's HttpAdapterHost in its init hook.
import { Module, type DynamicModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../content/index.ts';
import { LEDGER, LedgerModule, registerReconDiff, type Ledger } from '../ledger/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  EVENT_BUS,
  FIELD_CRYPTO,
  IDEMPOTENCY,
  JOB_QUEUE,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type AuditPort,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type Idempotency,
  type JobQueue,
  type QueueRuntime,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import { createBizRegistry } from './application/biz-registry.ts';
import { PayChannelSet } from './application/pay-channel.ts';
import type { PayOrderDeps } from './application/pay-orders.ts';
import type { PayRefundDeps } from './application/pay-refunds.ts';
import type { PayLedgerPort } from './application/pay-settlement.ts';
import { AdminPayRefundsController, PAY_REFUND_DEPS } from './http/admin/pay-refunds.controller.ts';
import { installNotifyBodyCapture } from './http/public/notify-body.ts';
import {
  PAY_NOTIFY_DEPS,
  PayNotifyController,
  isNotifyRoute,
  type PayNotifyDeps,
} from './http/public/pay-notify.controller.ts';
import { PAY_ORDER_DEPS, PayOrdersController } from './http/public/pay-orders.controller.ts';
import { FakePayChannel } from './infra/channels/fake-pay-channel.ts';
import { createNotifyRateLimiter } from './infra/notify-rate-limit.ts';
import { createPayJobHandler } from './jobs/pay-jobs.ts';
import { PAY_QUEUE } from './jobs/names.ts';

export interface PaymentModuleOptions {
  /** content's ContentReader over the primary handle (pay.enabled, pay.channel_enabled.*, …). */
  readonly config: (db: Kysely<Database>, clock: Clock) => ContentReader;
  /**
   * api entry: register the notification entry (POST /notify/pay/<channel>). app.module passes
   * whether the process has a database; without one the entry is left out (see the header).
   */
  readonly notifyEntry?: boolean;
}

/** B2-15e: the admin entry's options (the console's original-route refund). */
export interface PaymentAdminOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
}

/** Nest token of the worker's registered pay queue handler (null without database or queue). */
export const PAY_JOBS = Symbol('PAYMENT_PAY_JOBS');
/** Nest token of the api entry's notification body capture (an init hook). */
const NOTIFY_BODY_CAPTURE = Symbol('PAYMENT_NOTIFY_BODY_CAPTURE');

/** The channels of an environment: synthetic outside prod; none in prod until B2-15k. */
export function payChannelSetFor(appEnv: AppConfig['appEnv']): PayChannelSet {
  if (appEnv === 'prod') return new PayChannelSet([]);
  return new PayChannelSet([new FakePayChannel('wechat_pay'), new FakePayChannel('alipay')]);
}

/** ledger's posting and recon diff registration as payment's port (BR-PAY-07). */
function ledgerPort(ledger: Ledger, clock: Clock): PayLedgerPort {
  return {
    post: (trx, voucher) => ledger.post(trx, voucher),
    registerReconDiff: (trx, input) => registerReconDiff(trx, input, { clock }),
  };
}

const channelSetProvider = {
  provide: PayChannelSet,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): PayChannelSet => payChannelSetFor(config.appEnv),
};

@Module({})
export class PaymentModule {
  static forApi(options: PaymentModuleOptions): DynamicModule {
    const notifyEntry = options.notifyEntry === true;
    return {
      module: PaymentModule,
      imports: [LedgerModule.forRoot()],
      controllers: [PayOrdersController, ...(notifyEntry ? [PayNotifyController] : [])],
      providers: [
        channelSetProvider,
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
        ...(notifyEntry
          ? [
              {
                provide: PAY_NOTIFY_DEPS,
                inject: [
                  CLOCK,
                  ROOT_LOGGER,
                  PayChannelSet,
                  LEDGER,
                  DB,
                  JOB_QUEUE,
                  EVENT_BUS,
                  { token: FIELD_CRYPTO, optional: true },
                  { token: REDIS, optional: true },
                ],
                useFactory: (
                  clock: Clock,
                  logger: RootLogger,
                  channels: PayChannelSet,
                  ledger: Ledger,
                  db: Kysely<Database>,
                  queue: JobQueue,
                  events: EventBus,
                  crypto?: FieldCrypto,
                  redis?: RedisHandle,
                ): PayNotifyDeps => {
                  const child = logger.child({ module: 'payment', entry_point: 'notify' });
                  if (crypto === undefined) {
                    // Fail closed from now on (rule 6): announced once, every notification nacked.
                    child.error({}, 'pay_notify_crypto_missing');
                  }
                  if (redis === undefined) child.warn({}, 'pay_notify_rate_limit_disabled');
                  return {
                    handler: {
                      db,
                      clock,
                      config: options.config(db, clock),
                      queue,
                      events,
                      channels,
                      ledger: ledgerPort(ledger, clock),
                      crypto: crypto ?? null,
                      logger: child,
                    },
                    rateLimiter:
                      redis === undefined
                        ? null
                        : createNotifyRateLimiter({ redis, clock, crypto: crypto ?? null }),
                    logger: child,
                  };
                },
              },
              {
                provide: NOTIFY_BODY_CAPTURE,
                inject: [HttpAdapterHost],
                useFactory: (host: HttpAdapterHost): { onModuleInit(): void } => ({
                  onModuleInit() {
                    // Only where an HTTP server exists: a module graph built without one (an
                    // application context, a wiring test) has no adapter and nothing to capture.
                    const adapter: { getInstance?: () => unknown } | null | undefined =
                      host.httpAdapter;
                    const instance = adapter?.getInstance?.();
                    if (instance === undefined || instance === null) return;
                    installNotifyBodyCapture(instance, isNotifyRoute);
                  },
                }),
              },
            ]
          : []),
      ],
      exports: [PayChannelSet],
    };
  }

  /**
   * B2-15e: the admin entry's original-route refund (POST /admin/v1/pay-orders/{id}/refunds, POST
   * /admin/v1/pay-anomalies/{id}/refunds) over platform idempotency, the queue (the first
   * refund.query slot) and admin's audit writer bound to the creating transaction. Without the
   * database, the queue or the idempotency primitive the routes fail closed (50001).
   */
  static forAdmin(options: PaymentAdminOptions): DynamicModule {
    return {
      module: PaymentModule,
      controllers: [AdminPayRefundsController],
      providers: [
        channelSetProvider,
        {
          provide: PAY_REFUND_DEPS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            PayChannelSet,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: IDEMPOTENCY, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            channels: PayChannelSet,
            db?: Kysely<Database>,
            queue?: JobQueue,
            idempotency?: Idempotency,
          ): PayRefundDeps | null =>
            db === undefined || queue === undefined || idempotency === undefined
              ? null
              : {
                  db,
                  clock,
                  queue,
                  channels,
                  idempotency,
                  auditOn: (trx) => options.auditWriter(trx, clock),
                  logger: logger.child({ module: 'payment', entry_point: 'admin' }),
                },
        },
      ],
      exports: [PayChannelSet],
    };
  }

  /** The worker entry: the handler of queue `pay` (order.query, biz.reconcile, order.close, refund.query). */
  static forWorker(options: Pick<PaymentModuleOptions, 'config'>): DynamicModule {
    return {
      module: PaymentModule,
      imports: [LedgerModule.forRoot()],
      providers: [
        channelSetProvider,
        {
          provide: PAY_JOBS,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            PayChannelSet,
            LEDGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
            channels: PayChannelSet,
            ledger: Ledger,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
            events?: EventBus,
          ): { readonly queue: string } | null => {
            const child = logger.child({ module: 'payment', queue: PAY_QUEUE });
            if (db === undefined || queue === undefined || events === undefined) {
              child.info({}, 'pay_jobs_disabled');
              return null;
            }
            queue.register(
              PAY_QUEUE,
              createPayJobHandler({
                db,
                clock,
                config: options.config(db, clock),
                queue,
                events,
                channels,
                registry: createBizRegistry(config.appEnv),
                ledger: ledgerPort(ledger, clock),
                logger: child,
              }),
            );
            return { queue: PAY_QUEUE };
          },
        },
      ],
      exports: [PayChannelSet],
    };
  }
}
