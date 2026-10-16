// GET /v1/config (task F1-02c; contract getConfig: x-auth optional, unsigned, session scopes
// full and deletion_only). The request checks have already verified any bearer token; the caller
// comes from the request-scoped ConfigViewerContext (identity's, assembled by app.module). The
// X-Device-Id header is read only to bucket a guest's h5_release, never as an identity.
// Served by the api entry only (ContentPublicModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax): content's index.ts
// is reachable from the test project, whose compiler settings have no legacy decorators.
import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema, type ContractOperationId } from '../../../platform/index.ts';
import { ClientConfigService, ConfigViewerContext } from '../../application/client-config.ts';

export interface ConfigRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

const OPERATION = 'getConfig';

/**
 * The contract's route schema of getConfig once the operation is implemented in
 * contracts/openapi.yaml and the route schemas are regenerated; until then (the contract slot is
 * held by another task, F1-02c §9.6) the route registers without a request schema.
 * TODO(规划/11 §3.2): drop the fallback once getConfig loses `x-implementation: planned` — blocked
 * on the contract slot.
 */
function routeSchema(): ReturnType<typeof contractRouteSchema> | Record<string, never> {
  try {
    return contractRouteSchema(OPERATION as ContractOperationId);
  } catch {
    return {};
  }
}

export class ConfigController {
  readonly #service: ClientConfigService;
  readonly #viewer: ConfigViewerContext;

  constructor(service: ClientConfigService, viewer: ConfigViewerContext) {
    this.#service = service;
    this.#viewer = viewer;
  }

  async read(request: ConfigRequest): Promise<Schema<'ConfigResponse'>> {
    const viewer = await this.#viewer.current();
    const device = request.headers['x-device-id'];
    const data = await this.#service.read(
      { appId: viewer.appId, userId: viewer.userId },
      typeof device === 'string' && device !== '' ? device : null,
    );
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

{
  const prototype = ConfigController.prototype;
  const read = Object.getOwnPropertyDescriptor(prototype, 'read')!;
  Inject(ClientConfigService)(ConfigController, undefined, 0);
  Inject(ConfigViewerContext)(ConfigController, undefined, 1);
  Req()(prototype, 'read', 0);
  Get('config')(prototype, 'read', read);
  RouteSchema(routeSchema())(prototype, 'read', read);
  Controller('v1')(ConfigController);
}
