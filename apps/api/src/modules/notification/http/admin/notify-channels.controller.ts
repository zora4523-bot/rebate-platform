// /admin/v1/notify-channels* (B1-12z; contract CT-24t: adminListNotifyChannels,
// adminSwitchNotifyChannels, adminRegisterNotifySms, adminRetestNotifySms, adminEnableNotifySms,
// adminDiscardNotifySms). Served by the admin entry only (NotificationAdminModule). Access through
// platform's AdminOperationGuard (04 §11.2; 08 BR-TEXT-20 细则; orchestrator rulings D10-337 ④,
// D10-339 ②③):
//   - list: content.article or notify.channels, read only (no step-up, the token untouched);
//   - switch, register, retest, enable: notify.channels with its totp step-up on every call;
//   - discard: notify.channels without step-up (the guard's no-step-up mode, `readOnly`);
//   - register and enable of a fund code: content.fund_terms as well, checked by a second,
//     no-step-up pass of the guard at the contract's point (after `code`), 10403 when missing.
// The routes mount no route schema: the use cases validate the query and body against the contract
// at the contract's place in the order of checks (./notify-channels.validation.ts). Refusals are
// thrown through the guard, so a refused call never uses up the step-up token; the app and admin
// are the guard's actor, never request fields.
//
// Nest's decorators are applied as plain calls below (not decorator syntax).
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  fieldsErrorEnvelope,
  type AdminActor,
  type AdminOperationInput,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  NotifyChannelsAdmin,
  NotifyConflictError,
  NotifyFieldsError,
  NotifyTestNotAcceptedError,
  NotifyVerifyPhoneMissingError,
  type NotifyActor,
  type NotifyFundAccess,
} from '../../admin-channels/service.ts';

export interface NotifyChannelsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

const ARTICLE = 'content.article';
const CHANNELS = 'notify.channels';
const FUND_TERMS = 'content.fund_terms';

type Access = Pick<AdminOperationInput, 'permission' | 'readOnly'>;
type Envelope<T> = { code: 0; msg: string; data: T; trace_id: string };

const READ: Access = { permission: [ARTICLE, CHANNELS], readOnly: true };
const WRITE: Access = { permission: CHANNELS };
/** 放弃新配置: notify.channels without a dynamic code (D10-339 ②). */
const DISCARD: Access = { permission: CHANNELS, readOnly: true };

/** Fallback texts (the console shows its dictionary text error.<code>). */
const MESSAGES = {
  20001: '参数错误',
  20902: '状态已变化，请刷新后重试',
  10003: '请先登记验证手机号',
  50301: '短信服务暂不可用，原配置继续生效',
  50401: '短信服务响应超时，原配置继续生效',
} as const;

function actorOf(actor: AdminActor, request: NotifyChannelsRequest): NotifyActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

export class AdminNotifyChannelsController {
  readonly #guard: AdminOperationGuard;
  readonly #channels: NotifyChannelsAdmin;

  constructor(guard: AdminOperationGuard, channels: NotifyChannelsAdmin) {
    this.#guard = guard;
    this.#channels = channels;
  }

  /** adminListNotifyChannels. */
  list(request: NotifyChannelsRequest): Promise<Schema<'AdminNotifyChannelListResponse'>> {
    return this.#run(request, READ, (actor) => this.#channels.list(actor.appId));
  }

  /** adminSwitchNotifyChannels. */
  switchChannels(
    request: NotifyChannelsRequest,
    code: string,
    body: unknown,
  ): Promise<Schema<'AdminNotifyChannelResponse'>> {
    return this.#run(request, WRITE, (actor) =>
      this.#channels.switchChannels(actorOf(actor, request), code, body),
    );
  }

  /** adminRegisterNotifySms. */
  register(
    request: NotifyChannelsRequest,
    code: string,
    query: unknown,
    body: unknown,
  ): Promise<Schema<'AdminNotifySmsResultResponse'>> {
    return this.#run(request, WRITE, (actor) =>
      this.#channels.register(actorOf(actor, request), code, query, body, this.#fund(request)),
    );
  }

  /** adminRetestNotifySms. */
  retest(
    request: NotifyChannelsRequest,
    code: string,
    query: unknown,
    body: unknown,
  ): Promise<Schema<'AdminNotifySmsResultResponse'>> {
    return this.#run(request, WRITE, (actor) =>
      this.#channels.retest(actorOf(actor, request), code, query, body),
    );
  }

  /** adminEnableNotifySms. */
  enable(
    request: NotifyChannelsRequest,
    code: string,
    query: unknown,
    body: unknown,
  ): Promise<Schema<'AdminNotifyChannelResponse'>> {
    return this.#run(request, WRITE, (actor) =>
      this.#channels.enable(actorOf(actor, request), code, query, body, this.#fund(request)),
    );
  }

  /** adminDiscardNotifySms. */
  discard(
    request: NotifyChannelsRequest,
    code: string,
    query: unknown,
  ): Promise<Schema<'AdminNotifyChannelResponse'>> {
    return this.#run(request, DISCARD, (actor) =>
      this.#channels.discard(actorOf(actor, request), code, query),
    );
  }

  /** content.fund_terms of the same account, without step-up (the outer pass holds the token). */
  #fund(request: NotifyChannelsRequest): NotifyFundAccess {
    return {
      requireFundTerms: async () => {
        await this.#guard.run({ request, permission: FUND_TERMS, readOnly: true }, () =>
          Promise.resolve({ statusCode: 200, body: { code: 0 } }),
        );
      },
    };
  }

  async #run<T>(
    request: NotifyChannelsRequest,
    access: Access,
    work: (actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, ...access }, async (actor) => {
      try {
        const data = await work(actor);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        // Thrown through the guard: a refused call releases, never consumes, the step-up token.
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) {
      throw new Error('notification: admin guard returned without the call');
    }
    return response;
  }
}

/** The error envelopes of the use cases' refusals; anything else is rethrown (50001). */
export function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof NotifyFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    const data =
      error.reason === null ? refused.body.data : { ...refused.body.data, reason: error.reason };
    return new HttpException({ ...refused.body, msg: MESSAGES[20001], data }, refused.statusCode);
  }
  if (error instanceof NotifyConflictError) {
    return new HttpException({ code: 20902, msg: MESSAGES[20902], trace_id: traceId }, 409);
  }
  if (error instanceof NotifyVerifyPhoneMissingError) {
    return new HttpException(
      {
        code: 10003,
        msg: MESSAGES[10003],
        data: { tier: 'totp', reason: 'verify_phone_missing' },
        trace_id: traceId,
      },
      403,
    );
  }
  if (error instanceof NotifyTestNotAcceptedError) {
    return error.result === 'rejected'
      ? new HttpException({ code: 50301, msg: MESSAGES[50301], trace_id: traceId }, 503)
      : new HttpException({ code: 50401, msg: MESSAGES[50401], trace_id: traceId }, 504);
  }
  return error;
}

{
  const prototype = AdminNotifyChannelsController.prototype;
  Inject(AdminOperationGuard)(AdminNotifyChannelsController, undefined, 0);
  Inject(NotifyChannelsAdmin)(AdminNotifyChannelsController, undefined, 1);
  const routes = [
    ['list', Get(), []],
    ['switchChannels', Patch(':code'), ['code', 'body']],
    ['register', Put(':code/sms'), ['code', 'query', 'body']],
    ['discard', Delete(':code/sms/pending'), ['code', 'query']],
    ['retest', Post(':code/sms/pending/test'), ['code', 'query', 'body']],
    ['enable', Post(':code/sms/pending/enable'), ['code', 'query', 'body']],
  ] as const;
  for (const [name, route, args] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    (args as readonly string[]).forEach((arg, index) => {
      if (arg === 'body') Body()(prototype, name, index + 1);
      else if (arg === 'query') Query()(prototype, name, index + 1);
      else Param(arg)(prototype, name, index + 1);
    });
    route(prototype, name, descriptor);
    HttpCode(200)(prototype, name, descriptor);
  }
  Controller('admin/v1/notify-channels')(AdminNotifyChannelsController);
}
