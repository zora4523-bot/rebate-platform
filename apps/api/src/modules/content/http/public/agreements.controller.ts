import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { PublicAgreementReader } from '../../application/agreement-reader.ts';
import { ConfigViewerContext } from '../../application/client-config.ts';

interface AgreementsRequest {
  readonly id: string;
}

/** GET /v1/agreements (F1-02n): anonymous, unsigned; the viewer supplies only the app scope. */
export class AgreementsController {
  readonly #reader: PublicAgreementReader;
  readonly #viewer: ConfigViewerContext;

  constructor(reader: PublicAgreementReader, viewer: ConfigViewerContext) {
    this.#reader = reader;
    this.#viewer = viewer;
  }

  async read(request: AgreementsRequest): Promise<Schema<'AgreementsResponse'>> {
    const viewer = await this.#viewer.current();
    const data = await this.#reader.read(viewer.appId);
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

// Plain decorator calls keep the test project's erasable-syntax compilation compatible.
{
  const prototype = AgreementsController.prototype;
  const read = Object.getOwnPropertyDescriptor(prototype, 'read')!;
  Inject(PublicAgreementReader)(AgreementsController, undefined, 0);
  Inject(ConfigViewerContext)(AgreementsController, undefined, 1);
  Req()(prototype, 'read', 0);
  Get()(prototype, 'read', read);
  RouteSchema(contractRouteSchema('getAgreements'))(prototype, 'read', read);
  Controller('v1/agreements')(AgreementsController);
}
