// @vitest-environment jsdom
// Compiled by pnpm typecheck. Negative examples stay in an uncalled function, never at runtime.
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { Capability, call, has, on } from '@couli/bridge-sdk';
import { installBridge } from './kit.ts';
import type {
  BridgeContract,
  BridgeMethodName,
  BridgeMethods,
  BridgeEvents,
  Capability as CapabilityType,
} from '@couli/bridge-sdk';
type ContractMethods = BridgeContract.BridgeMethods;
type ContractMethodName = BridgeContract.BridgeMethodName;
type ContractEvents = BridgeContract.BridgeEvents;

function compileTimeContract() {
  // @ts-expect-error TECH-28: a literal method string is not a capability.
  void call('ui.toast', { text: 'unchecked' });
  // @ts-expect-error TECH-28: annotating a generic cannot bypass the handle.
  void call<'ui.toast'>('ui.toast', { text: 'unchecked' });
  // @ts-expect-error A structural object cannot forge the private brand.
  void call({ method: 'ui.toast' }, { text: 'forged' });
  // @ts-expect-error The handle constructor is private.
  new Capability<'ui.toast'>();
  // @ts-expect-error Unknown methods are absent from the generated contract.
  has('auth.getAccessToken');
  const toast = has('ui.toast');
  // @ts-expect-error A nullable probe must be narrowed before call.
  void call(toast, { text: 'not narrowed' });
  if (toast !== null) {
    const result = call(toast, { text: 'checked', duration: 'short' });
    expectTypeOf(result).toEqualTypeOf<Promise<ContractMethods['ui.toast']['result']>>();
    // @ts-expect-error Required text cannot be omitted.
    void call(toast, {});
    // @ts-expect-error Params must belong to the method proven by this handle.
    void call(toast, { keys: ['foo'] });
    // @ts-expect-error Contract enums cannot widen during generic inference.
    void call(toast, { text: 'checked', duration: 'forever' });
    // @ts-expect-error The wrong explicit method type cannot accept this handle.
    void call<'auth.getH5Token'>(toast, {});
  }
  const auth = has('auth.getH5Token');
  if (auth !== null) {
    const result = call(auth, {});
    expectTypeOf(result).toEqualTypeOf<Promise<ContractMethods['auth.getH5Token']['result']>>();
  }
  const user = has('auth.getUser');
  if (user !== null) {
    void call(user, {}).then((data) => {
      // @ts-expect-error BR-ID-32: auth.getUser never returns any token.
      return data.token;
    });
  }
  // @ts-expect-error Unknown events cannot be subscribed to.
  on('clipboard.changed', () => {});
  on('auth.changed', (data) => {
    expectTypeOf(data).toEqualTypeOf<ContractEvents['auth.changed']>();
    // @ts-expect-error BR-ID-32: event data does not expose tokens.
    void data.token;
    // @ts-expect-error Event data does not expose device identifiers.
    void data.device_id;
  });
  // @ts-expect-error Listener data type must match the event.
  on('page.visible', (data: { visible: string }) => {
    void data;
  });
}

afterEach(() => vi.unstubAllGlobals());

it('[AC-F1-01b#32] 编译期能力句柄、参数、结果和事件类型与生成契约一致；运行时必须先探测', () => {
  installBridge(['ui.toast']);
  const capability = has('ui.toast');
  expect(capability).not.toBeNull();
  expectTypeOf<BridgeMethodName>().toEqualTypeOf<ContractMethodName>();
  expectTypeOf<BridgeMethods>().toEqualTypeOf<ContractMethods>();
  expectTypeOf<BridgeEvents>().toEqualTypeOf<ContractEvents>();
  expectTypeOf(capability).toEqualTypeOf<CapabilityType<'ui.toast'> | null>();
  // Keep the compile-only examples referenced without executing their intentionally invalid calls.
  expect(compileTimeContract).toBeTypeOf('function');
});
