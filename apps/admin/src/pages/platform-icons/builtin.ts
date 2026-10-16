// Built-in images of the platform marks page (F1-06zd skeleton; types only, the implementation
// adds the URL map). Kept apart from index.ts so the page can import it without a cycle.
import type { PlatformIconKey } from '@couli/contracts-ts';

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

/** The built-in image URL of every key (the map the implementation fills from ./assets). */
export type BuiltinIconUrls = { readonly [K in PlatformIconKey]: string };
