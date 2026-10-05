// F1-01b test-phase surface. All method and event payloads come from generated contracts.
import type { bridge as Contract } from '@couli/contracts-ts';
export { bridge as BridgeContract } from '@couli/contracts-ts';

/** Workspace package name; the only export until F1-01b lands. */
export const PACKAGE_NAME = '@couli/bridge-sdk';

export type BridgeMethodName = Contract.BridgeMethodName;
export type BridgeMethods = Contract.BridgeMethods;
export type BridgeEvents = Contract.BridgeEvents;
export type BridgeErrorCode = (typeof Contract.bridgeErrorCodes)[number];

/** Opaque proof of has(); callers cannot construct or structurally forge this class. */
export class Capability<M extends BridgeMethodName> {
  declare readonly method: M;
  declare private readonly capabilityBrand: M;

  private constructor() {
    throw new Error('NotImplemented: Capability');
  }
}

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

export function isInApp(): boolean {
  throw new Error('NotImplemented: isInApp');
}

export function has<M extends BridgeMethodName>(method: M): Capability<M> | null {
  void method;
  throw new Error('NotImplemented: has');
}

/** Resolves with data; failures reject with BridgeFailure, including outside-App 90001. */
export function call<M extends BridgeMethodName>(
  cap: Capability<M>,
  params: BridgeMethods[NoInfer<M>]['params'],
): Promise<BridgeMethods[M]['result']> {
  void cap;
  void params;
  throw new Error('NotImplemented: call');
}

export function on<E extends keyof BridgeEvents>(
  event: E,
  handler: (data: BridgeEvents[E]) => void,
): () => void {
  void event;
  void handler;
  throw new Error('NotImplemented: on');
}

export type H5Token = BridgeMethods['auth.getH5Token']['result'];

/** Parsed server envelope; request does not interpret HTTP status as a business code. */
export interface H5ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

export interface H5TokenManager {
  getToken(options: { forWrite: boolean }): Promise<H5Token>;
  invalidate(): void;
  /**
   * send is an injected authenticated request, never a storage or navigation callback.
   * Every method other than GET is a write for read_only handling. A 10002 envelope triggers
   * one fresh acquisition and one replay; 10403 is returned unchanged, never retried or logged in.
   * Only 10403 with data.reason=h5_read_only discards the cached token.
   */
  request<T>(
    method: string,
    send: (token: string) => Promise<H5ApiResponse<T>>,
  ): Promise<H5ApiResponse<T>>;
}

/** Acquires via has('auth.getH5Token') + call; the returned manager owns only page memory. */
export function createH5TokenManager(): H5TokenManager {
  throw new Error('NotImplemented: createH5TokenManager');
}
