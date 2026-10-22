// B1-12m: GET / PUT /v1/me/notification-settings (contract getNotificationSettings /
// updateNotificationSettings: x-auth login, unsigned, not idempotent; PUT behind the version gate).
// The subject is the request's token principal only (app_id, uid → user_id), never X-App-Id or
// the body. The PUT body is checked by the contract route schema (exactly the three booleans,
// otherwise 20001 data.fields) before the handler runs. No principal → 401 / 10001 without
// calling the service. Mounted by NotificationModule (api entry) with plain decorator calls like
// messages.controller.ts.
import type { Schema } from '@couli/contracts-ts';
import { Body, Controller, Get, HttpCode, HttpException, Inject, Put, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  contractRouteSchema,
  tokenPrincipal,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type {
  NotificationSettingsOwner,
  NotificationSettingsService,
} from '../../application/notification-settings.ts';

export const NOTIFICATION_SETTINGS = Symbol('NOTIFICATION_SETTINGS');

export interface NotificationSettingsHttpRequest {
  readonly id: string;
  readonly principal?: TokenPrincipal;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export class NotificationSettingsController {
  readonly #settings: NotificationSettingsService;

  constructor(settings: NotificationSettingsService) {
    this.#settings = settings;
  }

  #owner(request: NotificationSettingsHttpRequest): NotificationSettingsOwner {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    return { app_id: principal.app_id, user_id: principal.uid };
  }

  async get(
    request: NotificationSettingsHttpRequest,
  ): Promise<Schema<'NotificationSettingsResponse'>> {
    const owner = this.#owner(request);
    const data = await this.#settings.get(owner);
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  async update(
    request: NotificationSettingsHttpRequest,
    body: Schema<'NotificationSettings'>,
  ): Promise<Schema<'NotificationSettingsResponse'>> {
    const owner = this.#owner(request);
    const data = await this.#settings.update(owner, {
      service_push: body.service_push,
      subscription_push: body.subscription_push,
      marketing_push: body.marketing_push,
    });
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

Controller('v1/me/notification-settings')(NotificationSettingsController);
Inject(NOTIFICATION_SETTINGS)(NotificationSettingsController, undefined, 0);
{
  const prototype = NotificationSettingsController.prototype;
  const getMethod = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  Get()(prototype, 'get', getMethod);
  RouteSchema(contractRouteSchema('getNotificationSettings'))(prototype, 'get', getMethod);
  Req()(prototype, 'get', 0);

  const updateMethod = Object.getOwnPropertyDescriptor(prototype, 'update')!;
  Put()(prototype, 'update', updateMethod);
  HttpCode(200)(prototype, 'update', updateMethod);
  RouteSchema(contractRouteSchema('updateNotificationSettings'))(prototype, 'update', updateMethod);
  Req()(prototype, 'update', 0);
  Body()(prototype, 'update', 1);
}
