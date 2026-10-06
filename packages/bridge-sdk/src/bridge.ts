// H5 side of the JSBridge (规划/03 §5.2–§5.4). Method names, params, results, timeouts, events and
// error codes come only from the generated contract; nothing here keeps its own method table.
import { bridge as Contract } from '@couli/contracts-ts';

export type BridgeMethodName = Contract.BridgeMethodName;
export type BridgeMethods = Contract.BridgeMethods;
export type BridgeEvents = Contract.BridgeEvents;
export type BridgeErrorCode = (typeof Contract.bridgeErrorCodes)[number];

export interface BridgeRequest {
  v: 1;
  id: string;
  method: string;
  params: unknown;
}

export interface BridgeResponse {
  id: string;
  code: 0 | BridgeErrorCode;
  msg: string;
  data?: unknown;
}

export interface BridgeFailure {
  code: BridgeErrorCode;
  msg: string;
  data?: unknown;
}

export type BridgeEvent = {
  [E in keyof BridgeEvents]: { event: E; data: BridgeEvents[E] };
}[keyof BridgeEvents];

/**
 * Injection seam on window.__REBATE_BRIDGE__. Native platform adapters provide this surface.
 * postMessage returns the matching response (immediate or Promise); subscribe carries events.
 * methods may include future native methods unknown to this version of the generated contract.
 */
export interface BridgeTransport {
  version: number;
  methods: readonly string[];
  postMessage(request: BridgeRequest): BridgeResponse | Promise<BridgeResponse>;
  subscribe(listener: (message: BridgeEvent) => void): () => void;
}

/** Rejection value of every bridge call: a BridgeFailure that also carries a stack. */
export class BridgeError extends Error implements BridgeFailure {
  readonly code: BridgeErrorCode;
  readonly msg: string;
  declare readonly data?: unknown;

  constructor(code: BridgeErrorCode, msg: string, data?: unknown) {
    super(msg);
    this.name = 'BridgeError';
    this.code = code;
    this.msg = msg;
    if (data !== undefined) Object.defineProperty(this, 'data', { value: data, enumerable: true });
  }
}

const NOT_SUPPORTED = 90001;
const TIMEOUT = 90003;
const NATIVE_ERROR = 90500;

const CAPABILITY_KEY: unique symbol = Symbol('bridge-capability');
const issued = new WeakSet<object>();

/** Opaque proof of has(); callers cannot construct or structurally forge this class. */
export class Capability<M extends BridgeMethodName> {
  readonly method: M;
  declare private readonly capabilityBrand: M;

  private constructor(method: M, key: symbol) {
    if (key !== CAPABILITY_KEY) throw new TypeError('Capability handles only come from has()');
    this.method = method;
    issued.add(this);
    Object.freeze(this);
  }
}

type CapabilityFactory = new <M extends BridgeMethodName>(method: M, key: symbol) => Capability<M>;
const createCapability = Capability as unknown as CapabilityFactory;

/** Whatever is on the global right now; nothing is cached, so injection and removal take effect. */
function currentBridge(): Partial<BridgeTransport> | null {
  const value: unknown = (globalThis as { __REBATE_BRIDGE__?: unknown }).__REBATE_BRIDGE__;
  return typeof value === 'object' && value !== null ? (value as Partial<BridgeTransport>) : null;
}

function isContractMethod(method: string): method is BridgeMethodName {
  return Object.hasOwn(Contract.bridgeMethods, method);
}

function nativeSupports(bridge: Partial<BridgeTransport>, method: string): boolean {
  return Array.isArray(bridge.methods) && bridge.methods.includes(method);
}

function isBridgeErrorCode(code: unknown): code is BridgeErrorCode {
  return (Contract.bridgeErrorCodes as readonly unknown[]).includes(code);
}

/** In the trusted container iff the document-start script defined __REBATE_BRIDGE__ (never the UA). */
export function isInApp(): boolean {
  return currentBridge() !== null;
}

/** Capability probe: a handle only when the contract knows the method and native declares it. */
export function has<M extends BridgeMethodName>(method: M): Capability<M> | null {
  const bridge = currentBridge();
  if (bridge === null || !isContractMethod(method) || !nativeSupports(bridge, method)) return null;
  return new createCapability(method, CAPABILITY_KEY);
}

let sequence = 0;

function nextRequestId(): string {
  sequence += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${random}-${sequence.toString(36)}`.slice(0, 64);
}

function interpret(response: unknown, id: string): { data: unknown } | BridgeError {
  if (typeof response !== 'object' || response === null) {
    return new BridgeError(NATIVE_ERROR, 'Malformed bridge response');
  }
  const { id: replyId, code, msg, data } = response as Partial<Record<string, unknown>>;
  if (replyId !== id) return new BridgeError(NATIVE_ERROR, 'Bridge response id mismatch');
  if (code === 0) return { data: data ?? {} };
  if (!isBridgeErrorCode(code)) return new BridgeError(NATIVE_ERROR, 'Unknown bridge error code');
  return new BridgeError(code, typeof msg === 'string' ? msg : '', data);
}

/**
 * Sends one v1 envelope for a probed capability. Resolves with data; failures reject with
 * BridgeError (a BridgeFailure), including 90001 outside the App. Never retried automatically.
 */
export function call<M extends BridgeMethodName>(
  cap: Capability<M>,
  params: BridgeMethods[NoInfer<M>]['params'],
): Promise<BridgeMethods[M]['result']> {
  return new Promise<BridgeMethods[M]['result']>((resolve, reject) => {
    const bridge = currentBridge();
    if (!issued.has(cap)) {
      reject(new BridgeError(NOT_SUPPORTED, 'Bridge call without a capability from has()'));
      return;
    }
    const method = cap.method;
    if (
      bridge === null ||
      !nativeSupports(bridge, method) ||
      typeof bridge.postMessage !== 'function'
    ) {
      reject(new BridgeError(NOT_SUPPORTED, `Bridge method not supported: ${method}`));
      return;
    }
    const id = nextRequestId();
    const request: BridgeRequest = { v: 1, id, method, params: params ?? {} };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: { data: unknown } | BridgeError) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (outcome instanceof BridgeError) reject(outcome);
      else resolve(outcome.data as BridgeMethods[M]['result']);
    };
    const timeoutMs = Contract.bridgeMethods[method].timeout_ms;
    if (timeoutMs !== null) {
      timer = setTimeout(
        () => settle(new BridgeError(TIMEOUT, 'Bridge call timed out')),
        timeoutMs,
      );
    }
    let reply: unknown;
    try {
      reply = bridge.postMessage(request);
    } catch {
      settle(new BridgeError(NATIVE_ERROR, 'Bridge transport failed'));
      return;
    }
    Promise.resolve(reply).then(
      (response) => settle(interpret(response, id)),
      () => settle(new BridgeError(NATIVE_ERROR, 'Bridge transport failed')),
    );
  });
}

function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

type FieldKind = 'boolean' | 'string' | 'number';
type KindOf<T> = T extends boolean
  ? 'boolean'
  : T extends string
    ? 'string'
    : T extends number
      ? 'number'
      : never;

/**
 * Per-event data allowlist, transcribed from contracts/bridge.schema.json `events` (every event is
 * additionalProperties:false and every listed field is required). The generated contract only has
 * the types, so this table is type-checked against BridgeEvents and compared with the schema in
 * the package tests. Event names not in this table are never dispatched by on().
 */
export const eventDataFields = {
  'app.resume': {},
  'app.pause': {},
  'auth.changed': { logged_in: 'boolean' },
  'page.visible': { visible: 'boolean' },
} as const satisfies {
  [E in keyof BridgeEvents]: {
    readonly [K in keyof BridgeEvents[E]]-?: KindOf<BridgeEvents[E][K]>;
  };
};

function isContractEvent(event: unknown): event is keyof BridgeEvents {
  return typeof event === 'string' && Object.hasOwn(eventDataFields, event);
}

/**
 * Copies only the contract fields of one event. Fields outside the allowlist (e.g. a token or
 * clipboard text from a misbehaving native side) never reach subscribers; a missing or mistyped
 * required field makes the whole event undeliverable (null).
 */
function pickEventData<E extends keyof BridgeEvents>(
  event: E,
  data: unknown,
): BridgeEvents[E] | null {
  const fields: Readonly<Record<string, FieldKind>> = eventDataFields[event];
  const source = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const picked: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(fields)) {
    const value = Object.hasOwn(source, field) ? source[field] : undefined;
    if (typeof value !== kind) return null;
    picked[field] = value;
  }
  return picked as BridgeEvents[E];
}

function subscribe(event: string, deliver: (data: unknown) => void): () => void {
  const bridge = currentBridge();
  if (bridge === null || typeof bridge.subscribe !== 'function') return () => {};
  let active = true;
  let unsubscribe: () => void;
  try {
    unsubscribe = bridge.subscribe((message) => {
      if (!active || typeof message !== 'object' || message === null) return;
      if (message.event !== event) return;
      try {
        deliver(message.data);
      } catch (error) {
        rethrowLater(error);
      }
    });
  } catch {
    return () => {};
  }
  return () => {
    if (!active) return;
    active = false;
    if (typeof unsubscribe === 'function') unsubscribe();
  };
}

/**
 * Subscribes to one contract event; the returned function removes only this subscription.
 * Subscribers receive only the contract fields of that event (eventDataFields); event names
 * outside the contract are never dispatched, even when a caller bypasses the types.
 */
export function on<E extends keyof BridgeEvents>(
  event: E,
  handler: (data: BridgeEvents[E]) => void,
): () => void {
  if (!isContractEvent(event)) return () => {};
  return subscribe(event, (raw) => {
    const data = pickEventData(event, raw);
    if (data !== null) handler(data);
  });
}

/**
 * Untyped entry behind @couli/bridge-sdk/conformance: delivers the native data unfiltered so the
 * conformance page can record contract violations for the native UI tests. Not for business pages.
 */
export function onUntyped(event: string, handler: (data: unknown) => void): () => void {
  return subscribe(event, (raw) => handler(raw ?? {}));
}

/**
 * Untyped entry behind @couli/bridge-sdk/conformance: unknown to the contract, or not declared
 * by native, rejects with the same 90001 BridgeError as call(); otherwise behaves like call().
 */
export async function invokeUntyped(method: string, params: unknown): Promise<unknown> {
  const cap = isContractMethod(method) ? has(method) : null;
  if (cap === null) throw new BridgeError(NOT_SUPPORTED, `Bridge method not supported: ${method}`);
  return call(cap, params as never);
}
