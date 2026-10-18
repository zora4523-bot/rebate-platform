// Contract operation `getMyInvite` (GET /v1/invites/me: x-auth phone, unsigned, not idempotent) —
// task B1-11j; 08 BR-INV-18, BR-INV-19, BR-INV-16. HTTP entry only: every judgement is growth's
// invite page read (application/my-invite.ts); nothing here judges a rule.
//
// - The subject is the verified token (stage ②: uid, app_id); no header or query names a user.
// - 10005 (no phone bound) is the global guard's stage ⑧ and never reaches this handler.
// - 'minor' → 30413 with data.reason=self_minor (HTTP status from contracts/error-codes.yaml, msg
//   the BR-TEXT-14 fallback text error.30413); otherwise 200 with the read's fields as they are.
// Without the read (no database, field cipher or event bus) the route fails closed with 50001.
//
// Also compiled by the `test` project (through ../../index.ts): Nest metadata is applied by plain
// calls below, no parameter properties.
import { Controller, Get, HttpException, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import { errorCodes, type Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { MyInviteReader } from '../../application/my-invite.ts';

/** Nest token of growth's invite page read (null when it cannot be assembled). */
export const MY_INVITE_READER = Symbol('GROWTH_MY_INVITE_READER');

/** BR-TEXT-14 fallback text of contracts/texts.default.json error.30413. */
const SELF_MINOR_MSG = '未满 18 周岁，暂不开放邀请与分享';

/** What this controller reads of the Fastify request, already checked by stages ①–⑧. */
export interface MyInviteHttpRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

export class MyInviteController {
  readonly #reader: MyInviteReader | null;

  constructor(reader: MyInviteReader | null) {
    this.#reader = reader;
  }

  async getMyInvite(request: MyInviteHttpRequest): Promise<Schema<'MyInviteResponse'>> {
    const principal = tokenPrincipal(request);
    const reader = this.#reader;
    if (principal === undefined || reader === null) {
      throw new Error('growth: invite page needs its read and a verified token');
    }
    const traceId = request.id;
    const result = await reader.read({ app_id: principal.app_id, user_id: principal.uid });
    if (result.result === 'minor') {
      throw new HttpException(
        { code: 30413, msg: SELF_MINOR_MSG, data: { reason: 'self_minor' }, trace_id: traceId },
        errorCodes[30413].http,
      );
    }
    return { code: 0, msg: '', data: { ...result.invite }, trace_id: traceId };
  }
}

{
  const prototype = MyInviteController.prototype;
  const getMyInvite = Object.getOwnPropertyDescriptor(prototype, 'getMyInvite')!;
  Inject(MY_INVITE_READER)(MyInviteController, undefined, 0);
  Req()(prototype, 'getMyInvite', 0);
  Get('invites/me')(prototype, 'getMyInvite', getMyInvite);
  RouteSchema(contractRouteSchema('getMyInvite'))(prototype, 'getMyInvite', getMyInvite);
  Controller('v1')(MyInviteController);
}
