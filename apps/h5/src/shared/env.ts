export type Runtime = 'app' | 'wechat' | 'browser';

export interface RuntimeWindow {
  navigator: { userAgent: string };
  __REBATE_BRIDGE__?: unknown;
}

/** Bridge presence is authoritative; user-agent detection is only for presentation. */
export function detectRuntime(win: RuntimeWindow): Runtime {
  void win;
  throw new Error('NotImplemented: detectRuntime');
}
