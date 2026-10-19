import { Controller, Get, HttpException, Inject, Param, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { PublicAgreementReader } from '../../application/agreement-reader.ts';
import {
  AgreementVersionReader,
  type PublicAgreementVersion,
} from '../../application/agreement-version-reader.ts';
import { ConfigViewerContext } from '../../application/client-config.ts';
import type { AgreementType } from '../../domain/agreements/index.ts';

interface AgreementsRequest {
  readonly id: string;
}

/**
 * GET /v1/agreements (F1-02n) and GET /v1/agreements/{type} (F1-02ze): anonymous, unsigned; the
 * viewer supplies only the app scope (no token, no device id). type and version are validated by
 * the contract route schema (20001) before the handler runs.
 */
export class AgreementsController {
  readonly #reader: PublicAgreementReader;
  readonly #viewer: ConfigViewerContext;
  readonly #versions: AgreementVersionReader;

  constructor(
    reader: PublicAgreementReader,
    viewer: ConfigViewerContext,
    versions: AgreementVersionReader,
  ) {
    this.#reader = reader;
    this.#viewer = viewer;
    this.#versions = versions;
  }

  async read(request: AgreementsRequest): Promise<Schema<'AgreementsResponse'>> {
    const viewer = await this.#viewer.current();
    const data = await this.#reader.read(viewer.appId);
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  async version(
    request: AgreementsRequest,
    type: AgreementType,
    query: { readonly version?: number },
  ): Promise<Schema<'PublicAgreementVersionResponse'>> {
    const viewer = await this.#viewer.current();
    const data: PublicAgreementVersion | null = await this.#versions.read(
      viewer.appId,
      type,
      query.version ?? null,
    );
    if (data === null) {
      throw new HttpException(
        { code: 30701, msg: '页面或内容不存在', data: {}, trace_id: request.id },
        404,
      );
    }
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

// Plain decorator calls keep the test project's erasable-syntax compilation compatible.
{
  const prototype = AgreementsController.prototype;
  const read = Object.getOwnPropertyDescriptor(prototype, 'read')!;
  Inject(PublicAgreementReader)(AgreementsController, undefined, 0);
  Inject(ConfigViewerContext)(AgreementsController, undefined, 1);
  Inject(AgreementVersionReader)(AgreementsController, undefined, 2);
  Req()(prototype, 'read', 0);
  Get()(prototype, 'read', read);
  RouteSchema(contractRouteSchema('getAgreements'))(prototype, 'read', read);
  const version = Object.getOwnPropertyDescriptor(prototype, 'version')!;
  Req()(prototype, 'version', 0);
  Param('type')(prototype, 'version', 1);
  Query()(prototype, 'version', 2);
  Get(':type')(prototype, 'version', version);
  RouteSchema(contractRouteSchema('getAgreementVersion'))(prototype, 'version', version);
  Controller('v1/agreements')(AgreementsController);
}
