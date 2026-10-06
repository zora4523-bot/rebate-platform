// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { on, type BridgeEvents } from '@couli/bridge-sdk';
import { installBridge } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

// @couli/contracts-ts bridge.gen.ts exposes BridgeEvents types but no runtime data-property table.
// Expectations below come directly from contracts/bridge.schema.json events (additionalProperties:
// false): app.resume/app.pause {}, auth.changed { logged_in }, page.visible { visible }.
const cases = [
  { event: 'app.pause', data: { token: 'x', clipboard: 'y' }, expected: {} },
  { event: 'app.resume', data: { token: 'x', clipboard: 'y' }, expected: {} },
  { event: 'auth.changed', data: { logged_in: true, uid: 'u1' }, expected: { logged_in: true } },
  { event: 'auth.changed', data: { logged_in: false, uid: 'u1' }, expected: { logged_in: false } },
  { event: 'page.visible', data: { visible: true, token: 'x' }, expected: { visible: true } },
  { event: 'page.visible', data: { visible: false, clipboard: 'y' }, expected: { visible: false } },
] satisfies {
  event: keyof BridgeEvents;
  data: unknown;
  expected: BridgeEvents[keyof BridgeEvents];
}[];

it.each(cases)(
  '[F1-01l] [AC-F1-01l#5] $event 仅向订阅者交付契约字段 $expected',
  ({ event, data, expected }) => {
    const native = installBridge((request) => ({ id: request.id, code: 0, msg: '', data: {} }));
    const listener = vi.fn();
    const stop = on(event, listener);
    try {
      // Also reject arbitrary future fields and fields belonging to a different contract event;
      // deleting only today's token/clipboard/uid examples is not an event-specific allowlist.
      native.emit(event, { future_field: 'extra', logged_in: false, visible: false, ...data });
      expect(listener).toHaveBeenCalledExactlyOnceWith(expected);
    } finally {
      stop();
    }
  },
);

it('[F1-01l] [AC-F1-01l#6] 契约外事件即使被未类型化调用方订阅也不派发', () => {
  const native = installBridge((request) => ({ id: request.id, code: 0, msg: '', data: {} }));
  const unknownListener = vi.fn();
  const knownListener = vi.fn();
  // Simulate JavaScript/native input: a TypeScript cast must not bypass the runtime allowlist.
  const unknownEvent = 'auth.future' as keyof BridgeEvents;
  const stopUnknown = on(unknownEvent, unknownListener);
  const stopKnown = on('auth.changed', knownListener);
  try {
    native.emit('auth.future', { logged_in: true, token: 'x' });
    expect(unknownListener).not.toHaveBeenCalled();
    expect(knownListener).not.toHaveBeenCalled();
    native.emit('auth.changed', { logged_in: false });
    expect(knownListener).toHaveBeenCalledExactlyOnceWith({ logged_in: false });
    expect(unknownListener).not.toHaveBeenCalled();
  } finally {
    stopUnknown();
    stopKnown();
  }
});
