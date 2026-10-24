// B2-15c: the notification entry paths of the two channels (08 BR-PAY-04; specs/pay-notify.md).
// One source for both sides: the notify URL handed to the channel when an order is placed
// (pay-orders.ts notifyPathOf) and the routes of the entry (http/public/pay-notify.controller.ts),
// so the two cannot drift apart. Kept in application so neither side imports the other's layer.
import type { PayChannelCode } from '../domain/types.ts';

/** The controller path of the entry (the controller's `Controller(...)` argument). */
export const NOTIFY_CONTROLLER_PATH = 'notify/pay';

/** The prefix of every notification route, as a path (Fastify template). */
export const NOTIFY_ROUTE_PREFIX = `/${NOTIFY_CONTROLLER_PATH}/`;

/** The route segment of each channel under the prefix (the controller's `Post(...)` argument). */
export const NOTIFY_ROUTE_SEGMENTS: Readonly<Record<PayChannelCode, string>> = Object.freeze({
  wechat_pay: 'wechat',
  alipay: 'alipay',
});

/** The full notification route of each channel (Fastify templates). */
export const NOTIFY_ROUTES: Readonly<Record<PayChannelCode, string>> = Object.freeze({
  wechat_pay: `${NOTIFY_ROUTE_PREFIX}${NOTIFY_ROUTE_SEGMENTS.wechat_pay}`,
  alipay: `${NOTIFY_ROUTE_PREFIX}${NOTIFY_ROUTE_SEGMENTS.alipay}`,
});

/** Whether a request (method, route template) is one of the notification routes. */
export function isNotifyRoute(method: string, routeTemplate: string): boolean {
  return (
    method.toUpperCase() === 'POST' &&
    Object.values(NOTIFY_ROUTES).some((route) => route === routeTemplate)
  );
}
