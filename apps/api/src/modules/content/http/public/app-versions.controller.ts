import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import { contractRouteSchema, type ContractOperationId } from '../../../platform/index.ts';
import { AppVersionCheckService } from '../../application/app-version-check.ts';
import { ConfigViewerContext } from '../../application/client-config.ts';

interface AppVersionRequest {
  readonly id: string;
  /** Validated by the contract route schema; device/version/build are not used by this read. */
  readonly headers: {
    readonly 'x-platform': ClientPlatform;
    readonly 'x-channel'?: string;
  };
}

export class AppVersionsController {
  readonly #service: AppVersionCheckService;
  readonly #viewer: ConfigViewerContext;

  constructor(service: AppVersionCheckService, viewer: ConfigViewerContext) {
    this.#service = service;
    this.#viewer = viewer;
  }

  async check(request: AppVersionRequest): Promise<Schema<'AppVersionCheckResponse'>> {
    const viewer = await this.#viewer.current();
    const data = await this.#service.read(
      viewer.appId,
      request.headers['x-platform'],
      request.headers['x-channel'] ?? null,
    );
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

{
  const prototype = AppVersionsController.prototype;
  const check = Object.getOwnPropertyDescriptor(prototype, 'check')!;
  Inject(AppVersionCheckService)(AppVersionsController, undefined, 0);
  Inject(ConfigViewerContext)(AppVersionsController, undefined, 1);
  Req()(prototype, 'check', 0);
  Get('app-versions/check')(prototype, 'check', check);
  // The orchestrator's mechanical commit removes planned and regenerates this schema.
  // No fallback: this route must never register without its contract validation.
  RouteSchema(contractRouteSchema('checkAppVersion' as ContractOperationId))(
    prototype,
    'check',
    check,
  );
  Controller('v1')(AppVersionsController);
}
