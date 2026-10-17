// B1-12d: GET /v1/messages/{message_id} (contract getMessage: x-auth login, unsigned, not
// idempotent, 30701). The subject is the request's token principal only (app_id, uid → user_id),
// never X-App-Id or other headers; message_id is the path parameter. Found → InboxMessageResponse
// { code: 0, msg: '', data, trace_id: request.id }; null → 404 / 30701 (same answer for unknown,
// someone else's and another app's). No principal → reject without calling the reader.
// To be mounted by NotificationModule (api entry) with contractRouteSchema('getMessage'), using
// plain decorator calls like push-token.controller.ts (erasable syntax for the `test` project).
import type { Schema } from '@couli/contracts-ts';
import type { TokenPrincipal } from '../../../platform/index.ts';
import type { MessageReader } from '../../application/message-read.ts';

/** What the handler reads of the Fastify request, already checked by the request checks. */
export interface MessageHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
}

export class MessagesController {
  constructor(reader: MessageReader) {
    void reader;
    throw new Error('NotImplemented: MessagesController');
  }

  async get(
    request: MessageHttpRequest,
    messageId: string,
  ): Promise<Schema<'InboxMessageResponse'>> {
    void request;
    void messageId;
    throw new Error('NotImplemented: MessagesController.get');
  }
}
