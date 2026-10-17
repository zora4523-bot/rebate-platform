// B1-12d: GET /v1/messages/{message_id} (contract getMessage: x-auth login, unsigned, not
// idempotent, 30701). The subject is the request's token principal only (app_id, uid → user_id),
// never X-App-Id or other headers; message_id is the path parameter. Found → InboxMessageResponse
// { code: 0, msg: '', data, trace_id: request.id }; null → 404 / 30701 (same answer for unknown,
// someone else's and another app's). No principal → reject without calling the reader.
// To be mounted by NotificationModule (api entry) with contractRouteSchema('getMessage'), using
// plain decorator calls like push-token.controller.ts (erasable syntax for the `test` project).
import type { Schema } from '@couli/contracts-ts';
import { Controller, Get, HttpException, Inject, Param, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  contractRouteSchema,
  tokenPrincipal,
  type ContractOperationId,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { MessageReader } from '../../application/message-read.ts';

export const MESSAGE_READER = Symbol('MESSAGE_READER');

/** What the handler reads of the Fastify request, already checked by the request checks. */
export interface MessageHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
}

export class MessagesController {
  readonly #reader: MessageReader;

  constructor(reader: MessageReader) {
    this.#reader = reader;
  }

  async get(
    request: MessageHttpRequest,
    messageId: string,
  ): Promise<Schema<'InboxMessageResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    const data = await this.#reader.get({
      app_id: principal.app_id,
      user_id: principal.uid,
      message_id: messageId,
    });
    if (data === null) {
      throw new HttpException({ code: 30701, msg: '消息不存在', trace_id: request.id }, 404);
    }
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

Controller('v1/messages')(MessagesController);
Inject(MESSAGE_READER)(MessagesController, undefined, 0);
const getMethod = Object.getOwnPropertyDescriptor(MessagesController.prototype, 'get')!;
Get(':message_id')(MessagesController.prototype, 'get', getMethod);
// The orchestrator removes planned and regenerates this operation in its mechanical change.
// Until then the type assertion permits static checking; the runtime lookup still fails closed.
RouteSchema(contractRouteSchema('getMessage' as ContractOperationId))(
  MessagesController.prototype,
  'get',
  getMethod,
);
Req()(MessagesController.prototype, 'get', 0);
Param('message_id')(MessagesController.prototype, 'get', 1);
