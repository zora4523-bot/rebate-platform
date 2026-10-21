// B1-12k adds GET /v1/messages (listMessages), POST /v1/messages/read (markMessagesRead) and
// GET /v1/messages/unread-count (getUnreadMessageCount), same principal rule; a bad cursor → 20001
// fields [cursor].
// B1-12d: GET /v1/messages/{message_id} (contract getMessage: x-auth login, unsigned, not
// idempotent, 30701). The subject is the request's token principal only (app_id, uid → user_id),
// never X-App-Id or other headers; message_id is the path parameter. Found → InboxMessageResponse
// { code: 0, msg: '', data, trace_id: request.id }; null → 404 / 30701 (same answer for unknown,
// someone else's and another app's). No principal → reject without calling the reader.
// To be mounted by NotificationModule (api entry) with contractRouteSchema('getMessage'), using
// plain decorator calls like push-token.controller.ts (erasable syntax for the `test` project).
import type { Schema } from '@couli/contracts-ts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  contractRouteSchema,
  fieldsErrorEnvelope,
  tokenPrincipal,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import { InboxCursorError, type InboxMessages } from '../../application/inbox-messages.ts';
import type { MessageReader } from '../../application/message-read.ts';

export const MESSAGE_READER = Symbol('MESSAGE_READER');
/** B1-12k: list / mark read / unread count of the caller's inbox. */
export const INBOX_MESSAGES = Symbol('INBOX_MESSAGES');

/** What the handler reads of the Fastify request, already checked by the request checks. */
export interface MessageHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
  /** listMessages query, already checked and coerced by the contract route schema. */
  readonly query?: { readonly cursor?: string; readonly limit?: number };
}

export class MessagesController {
  readonly #reader: MessageReader;
  readonly #inboxPort: InboxMessages | undefined;

  /** The inbox port is always provided by NotificationModule; B1-12d's tests build reader-only. */
  constructor(reader: MessageReader, inbox?: InboxMessages) {
    this.#reader = reader;
    this.#inboxPort = inbox;
  }

  get #inbox(): InboxMessages {
    if (this.#inboxPort === undefined) throw new Error('notification: inbox port not provided');
    return this.#inboxPort;
  }

  /** The verified owner (app_id, uid → user_id); no principal → 401 / 10001. */
  #owner(request: MessageHttpRequest): { app_id: string; user_id: string } {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    return { app_id: principal.app_id, user_id: principal.uid };
  }

  async list(request: MessageHttpRequest): Promise<Schema<'InboxMessageListResponse'>> {
    const owner = this.#owner(request);
    const query = request.query ?? {};
    try {
      const data = await this.#inbox.list({
        ...owner,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error) {
      if (error instanceof InboxCursorError) {
        const refused = fieldsErrorEnvelope(error.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      throw error;
    }
  }

  async markRead(
    request: MessageHttpRequest,
    body: Schema<'MarkMessagesReadRequest'>,
  ): Promise<Schema<'MarkMessagesReadResponse'>> {
    const owner = this.#owner(request);
    // The body schema allows exactly one of the two forms; identity never comes from the body.
    const command =
      'all' in body ? { ...owner, all: body.all } : { ...owner, message_ids: body.message_ids };
    const data = await this.#inbox.markRead(command);
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  async unreadCount(request: MessageHttpRequest): Promise<Schema<'UnreadMessageCountResponse'>> {
    const owner = this.#owner(request);
    const data = await this.#inbox.unreadCount(owner);
    return { code: 0, msg: '', data, trace_id: request.id };
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
Inject(INBOX_MESSAGES)(MessagesController, undefined, 1);
{
  const prototype = MessagesController.prototype;
  // Static paths (read, unread-count) are declared before :message_id; find-my-way also matches
  // static segments first, so neither is ever taken as a message id.
  const listMethod = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Get()(prototype, 'list', listMethod);
  RouteSchema(contractRouteSchema('listMessages'))(prototype, 'list', listMethod);
  Req()(prototype, 'list', 0);

  const countMethod = Object.getOwnPropertyDescriptor(prototype, 'unreadCount')!;
  Get('unread-count')(prototype, 'unreadCount', countMethod);
  RouteSchema(contractRouteSchema('getUnreadMessageCount'))(prototype, 'unreadCount', countMethod);
  Req()(prototype, 'unreadCount', 0);

  const readMethod = Object.getOwnPropertyDescriptor(prototype, 'markRead')!;
  Post('read')(prototype, 'markRead', readMethod);
  HttpCode(200)(prototype, 'markRead', readMethod);
  RouteSchema(contractRouteSchema('markMessagesRead'))(prototype, 'markRead', readMethod);
  Req()(prototype, 'markRead', 0);
  Body()(prototype, 'markRead', 1);

  const getMethod = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  Get(':message_id')(prototype, 'get', getMethod);
  RouteSchema(contractRouteSchema('getMessage'))(prototype, 'get', getMethod);
  Req()(prototype, 'get', 0);
  Param('message_id')(prototype, 'get', 1);
}
