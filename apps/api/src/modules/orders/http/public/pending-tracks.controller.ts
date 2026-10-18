// B1-08m: GET /v1/orders/pending-tracks (listPendingTracks: x-auth login, unsigned, not
// idempotent) and POST /v1/orders/pending-tracks/{link_id}/dismiss (dismissPendingTrack: x-auth
// login, unsigned, not idempotent, version gate 10405 applied by the platform checks). A thin
// wrapper over the shared PendingTracks: the subject is the request's token principal only
// (app_id, uid → user_id), never X-App-Id, X-User-Id or the body (BR-AI-03); the path and body
// are already checked by contractRouteSchema (a missing attempt_id is 20001 there). A dismissal
// the queries cannot place in the subject's attempts is 20001 with data.fields=[attempt_id]
// (04 §6.4). Logs carry flat fields only (app_id, outcome, count): never a link or order number.
//
// Static paths win over /v1/orders/:order_id in Fastify's router (find-my-way matches a static
// segment before a parametric one regardless of registration order), so pending-tracks never
// reaches getOrder.
//
// Nest's decorators are applied as plain calls (erasable syntax, as in the notification module).
import type { Schema } from '@couli/contracts-ts';
import { Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  ROOT_LOGGER,
  contractRouteSchema,
  fieldsErrorEnvelope,
  tokenPrincipal,
  type RootLogger,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { OrderSubject } from '../../application/order-queries.ts';
import { PendingTrackError, PendingTracks } from '../../application/pending-tracks.ts';

/** What the handlers read of the Fastify request, already checked by the request checks. */
export interface PendingTracksHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly body?: Partial<Schema<'DismissPendingTrackRequest'>>;
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
}

export class PendingTracksController {
  readonly #tracks: PendingTracks;
  readonly #logger: RootLogger;

  constructor(tracks: PendingTracks, logger: RootLogger) {
    this.#tracks = tracks;
    this.#logger = logger.child({ module: 'orders' });
  }

  async list(request: PendingTracksHttpRequest): Promise<Schema<'PendingTracksResponse'>> {
    const subject = this.#subject(request);
    const data = await this.#tracks.list(subject);
    this.#logger.info(
      { app_id: subject.app_id, outcome: 'ok', count: data.items.length },
      'orders.pending_tracks.list',
    );
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  async dismiss(
    request: PendingTracksHttpRequest,
    linkId: string,
  ): Promise<Schema<'EmptyResponse'>> {
    const subject = this.#subject(request);
    const attemptId = request.body?.attempt_id;
    if (typeof attemptId !== 'string') throw this.#refused(request.id);
    try {
      await this.#tracks.dismiss(subject, linkId, attemptId);
    } catch (error) {
      if (error instanceof PendingTrackError) {
        this.#logger.info(
          { app_id: subject.app_id, outcome: 'not_found' },
          'orders.pending_tracks.dismiss',
        );
        throw this.#refused(request.id, error.fields);
      }
      throw error;
    }
    this.#logger.info({ app_id: subject.app_id, outcome: 'ok' }, 'orders.pending_tracks.dismiss');
    return { code: 0, msg: '', data: {}, trace_id: request.id };
  }

  #refused(traceId: string, fields: readonly string[] = ['attempt_id']): HttpException {
    const refused = fieldsErrorEnvelope(fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }

  #subject(request: PendingTracksHttpRequest): OrderSubject {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    return { app_id: principal.app_id, user_id: principal.uid };
  }
}

{
  const prototype = PendingTracksController.prototype;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  const dismiss = Object.getOwnPropertyDescriptor(prototype, 'dismiss')!;
  Inject(PendingTracks)(PendingTracksController, undefined, 0);
  Inject(ROOT_LOGGER)(PendingTracksController, undefined, 1);
  Req()(prototype, 'list', 0);
  Get()(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listPendingTracks'))(prototype, 'list', list);
  Req()(prototype, 'dismiss', 0);
  Param('link_id')(prototype, 'dismiss', 1);
  Post(':link_id/dismiss')(prototype, 'dismiss', dismiss);
  HttpCode(200)(prototype, 'dismiss', dismiss);
  RouteSchema(contractRouteSchema('dismissPendingTrack'))(prototype, 'dismiss', dismiss);
  Controller('v1/orders/pending-tracks')(PendingTracksController);
}
