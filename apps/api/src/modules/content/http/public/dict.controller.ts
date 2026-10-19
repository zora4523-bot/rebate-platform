import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { DictReader } from '../../application/dict-reader.ts';
import { ConfigViewerContext } from '../../application/client-config.ts';

interface DictRequest {
  readonly id: string;
}

/**
 * GET /v1/dict (F1-02s): anonymous, unsigned; the viewer supplies only the app scope. The
 * `version` query is validated by the contract schema and otherwise ignored (L13: no 304).
 */
export class DictController {
  readonly #reader: DictReader;
  readonly #viewer: ConfigViewerContext;

  constructor(reader: DictReader, viewer: ConfigViewerContext) {
    this.#reader = reader;
    this.#viewer = viewer;
  }

  async read(request: DictRequest): Promise<Schema<'DictResponse'>> {
    const viewer = await this.#viewer.current();
    const data = await this.#reader.read(viewer.appId);
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

// Plain decorator calls keep the test project's erasable-syntax compilation compatible.
{
  const prototype = DictController.prototype;
  const read = Object.getOwnPropertyDescriptor(prototype, 'read')!;
  Inject(DictReader)(DictController, undefined, 0);
  Inject(ConfigViewerContext)(DictController, undefined, 1);
  Req()(prototype, 'read', 0);
  Get()(prototype, 'read', read);
  RouteSchema(contractRouteSchema('getDict'))(prototype, 'read', read);
  Controller('v1/dict')(DictController);
}
