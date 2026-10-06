import { isInApp } from '@couli/bridge-sdk';

export type Runtime = 'app' | 'wechat' | 'browser';

export interface RuntimeWindow {
  navigator: { userAgent: string };
  __REBATE_BRIDGE__?: unknown;
}

const WECHAT_UA = /MicroMessenger/i;

/**
 * Bridge presence is authoritative; user-agent detection is only for presentation (规划/03 §8.3).
 * Read on every call: native may inject or remove the bridge, so nothing is cached.
 */
export function detectRuntime(win: RuntimeWindow): Runtime {
  // isInApp reads the document-start global __REBATE_BRIDGE__, never the UA.
  if (isInApp()) return 'app';
  return WECHAT_UA.test(win.navigator.userAgent) ? 'wechat' : 'browser';
}
