// B1-10j: orders' /admin/v1 routes, the read side of the console's claim review (GET
// /admin/v1/claims, GET /admin/v1/claims/{claim_id}) and, B1-10i, the console's order list and
// detail (GET /admin/v1/orders, GET /admin/v1/orders/{order_id}). app.module imports this module on the admin
// entry only; the api and stream entries do not serve /admin/v1. Permission checks go through
// platform's AdminOperationGuard, which the admin module provides on the admin entry (orders never
// imports admin). Other modules' reads (identity's masked phones, admin's reviewer names,
// linking's link_logs time and scene) come in as one factory from app.module, so this module
// imports no other module's implementation. Without a database the routes still register and
// every read fails closed (50001); module startup never touches the database handle.
import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB, FIELD_CRYPTO, type Clock, type FieldCrypto } from '../platform/index.ts';
import { AdminClaims, type AdminClaimPorts } from './application/admin-claims.ts';
import { AdminOrders, type AdminOrderPorts } from './application/admin-orders.ts';
import { AdminClaimsController } from './http/admin/claims.controller.ts';
import { AdminOrdersController } from './http/admin/orders.controller.ts';
import { createAdminClaimReads } from './infra/admin-claim-reads.ts';
import { createAdminOrderReads } from './infra/admin-order-reads.ts';

export interface OrdersAdminOptions {
  /** identity's masked phones, admin's reviewer names and linking's link_logs moments. */
  readonly ports: (db: Kysely<Database>, crypto: FieldCrypto | null) => AdminClaimPorts;
  /**
   * B1-10i: identity's masked phones, admin's latest manual hold audit and display names,
   * commission's snapshot, linking's link_logs of a link and content's credit.enabled.
   */
  readonly orderPorts: (
    db: Kysely<Database>,
    crypto: FieldCrypto | null,
    clock: Clock,
  ) => AdminOrderPorts;
}

export class OrdersAdminModule {
  static forAdmin(options: OrdersAdminOptions): DynamicModule {
    return {
      module: OrdersAdminModule,
      controllers: [AdminClaimsController, AdminOrdersController],
      providers: [
        {
          provide: AdminClaims,
          inject: [
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (db?: Kysely<Database>, crypto?: FieldCrypto): AdminClaims =>
            db === undefined
              ? new AdminClaims()
              : new AdminClaims({
                  reads: createAdminClaimReads(db),
                  ...options.ports(db, crypto ?? null),
                }),
        },
        {
          provide: AdminOrders,
          inject: [CLOCK, { token: DB, optional: true }, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>, crypto?: FieldCrypto): AdminOrders =>
            db === undefined
              ? new AdminOrders()
              : new AdminOrders({
                  reads: createAdminOrderReads(db),
                  ...options.orderPorts(db, crypto ?? null, clock),
                }),
        },
      ],
    };
  }
}

Module({})(OrdersAdminModule);
