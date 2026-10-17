// B1-08l: the api entry's orders assembly — the shared OrderQueries provider (class token, also
// what B3-08 will inject) and the /v1/orders controller. Other modules' readers come in as
// factories from app.module (content's configuration reader, linking's order-link reader), so
// this module imports no other module's implementation. Without a database the queries fail
// closed on first use; module startup never touches the database handle.
import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../content/index.ts';
import { CLOCK, DB, type Clock } from '../platform/index.ts';
import {
  OrderQueries,
  createOrderQueries,
  type OrderLinkReader,
} from './application/order-queries.ts';
import { OrdersController } from './http/public/orders.controller.ts';

export interface OrdersModuleOptions {
  /** content's ContentReader over the primary handle (order.user_query_months, credit.enabled.*). */
  readonly config: (db: Kysely<Database>, clock: Clock) => ContentReader;
  /** linking's order-link reader (links.product_key by app_id and link_id). */
  readonly links: (db: Kysely<Database>) => OrderLinkReader;
}

export class OrdersModule {
  static forRoot(options: OrdersModuleOptions): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [OrdersController],
      providers: [
        {
          provide: OrderQueries,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): OrderQueries =>
            db === undefined
              ? new OrderQueries()
              : createOrderQueries({
                  db,
                  clock,
                  config: options.config(db, clock),
                  // TODO(规划/11 §4.5): figures 端口接 settlement / ledger / commission 读端口 — blocked on 这些模块尚无可用导出
                  links: options.links(db),
                }),
        },
      ],
      exports: [OrderQueries],
    };
  }
}

Module({})(OrdersModule);
