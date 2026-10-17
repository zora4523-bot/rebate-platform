// Bundled platform images and their URL map, kept apart from the page entry to avoid a cycle.
import type { PlatformIconKey } from '@couli/contracts-ts';
import taobao from './assets/taobao.svg?no-inline';
import tmall from './assets/tmall.svg?no-inline';
import jd from './assets/jd.svg?no-inline';
import pdd from './assets/pinduoduo.svg?no-inline';
import wechat from './assets/wechat.svg?no-inline';
import wechat_pay from './assets/wechat-pay.svg?no-inline';
import alipay from './assets/alipay.svg?no-inline';
import wecom from './assets/wecom.svg?no-inline';

/**
 * BR-TEXT-24 细则「标识键」: key → built-in file name. The built-in images are byte-identical
 * copies of apps/h5/src/components/platform/assets/<file>.svg kept in ./assets/<file>.svg and
 * shown with <img src> (import them with `?no-inline`, Vite would otherwise inline small SVGs).
 */
export interface BuiltinIconFiles {
  readonly taobao: 'taobao';
  readonly tmall: 'tmall';
  readonly jd: 'jd';
  readonly pdd: 'pinduoduo';
  readonly wechat: 'wechat';
  readonly wechat_pay: 'wechat-pay';
  readonly alipay: 'alipay';
  readonly wecom: 'wecom';
}

/** The built-in image URL of every key. */
export type BuiltinIconUrls = { readonly [K in PlatformIconKey]: string };

export const builtinIconUrls: BuiltinIconUrls = {
  taobao,
  tmall,
  jd,
  pdd,
  wechat,
  wechat_pay,
  alipay,
  wecom,
};
