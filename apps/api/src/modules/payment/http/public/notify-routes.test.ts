// B2-15c unit test: the notify URL handed to the channel when an order is placed and the routes
// the notification entry is mounted on come from one constant (application/notify-routes.ts), so
// they cannot drift apart (specs/pay-notify.md §1). No database, no Fastify: the Nest route
// metadata of the controller is read directly.
import { RequestMethod } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  NOTIFY_CONTROLLER_PATH,
  NOTIFY_ROUTE_PREFIX,
  NOTIFY_ROUTE_SEGMENTS,
  NOTIFY_ROUTES,
} from '../../application/notify-routes.ts';
import { notifyPathOf } from '../../application/pay-orders.ts';
import type { PayChannelCode } from '../../domain/types.ts';
import { PayNotifyController } from './pay-notify.controller.ts';

// Nest's PATH_METADATA / METHOD_METADATA keys (@nestjs/common/constants).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

const HANDLERS: Readonly<Record<PayChannelCode, 'wechat' | 'alipay'>> = {
  wechat_pay: 'wechat',
  alipay: 'alipay',
};

it('[AC-B2-15c#17] notifyPathOf gives each channel exactly its notification route', () => {
  expect(notifyPathOf('wechat_pay')).toBe('/notify/pay/wechat');
  expect(notifyPathOf('alipay')).toBe('/notify/pay/alipay');
  for (const channel of Object.keys(NOTIFY_ROUTES) as PayChannelCode[]) {
    expect(notifyPathOf(channel)).toBe(NOTIFY_ROUTES[channel]);
  }
});

it('[AC-B2-15c#17] the controller is mounted on the same prefix and segments as NOTIFY_ROUTES', () => {
  const controllerPath = Reflect.getMetadata(PATH_METADATA, PayNotifyController) as unknown;
  expect(controllerPath).toBe(NOTIFY_CONTROLLER_PATH);
  expect(`/${String(controllerPath)}/`).toBe(NOTIFY_ROUTE_PREFIX);
  for (const [channel, handler] of Object.entries(HANDLERS) as [
    PayChannelCode,
    'wechat' | 'alipay',
  ][]) {
    const method = PayNotifyController.prototype[handler];
    const segment = Reflect.getMetadata(PATH_METADATA, method) as unknown;
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
    expect(segment).toBe(NOTIFY_ROUTE_SEGMENTS[channel]);
    expect(`/${String(controllerPath)}/${String(segment)}`).toBe(NOTIFY_ROUTES[channel]);
    expect(`/${String(controllerPath)}/${String(segment)}`).toBe(notifyPathOf(channel));
  }
});
