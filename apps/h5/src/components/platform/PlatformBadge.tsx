import { useEffect, useState, type ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';
import { getPlatformName } from '../../texts/platform.ts';
import alipayIcon from './assets/alipay.svg';
import jdIcon from './assets/jd.svg';
import pinduoduoIcon from './assets/pinduoduo.svg';
import taobaoIcon from './assets/taobao.svg';
import tmallIcon from './assets/tmall.svg';
import wechatPayIcon from './assets/wechat-pay.svg';
import wechatIcon from './assets/wechat.svg';
import wecomIcon from './assets/wecom.svg';

export type PlatformKey = keyof Schema<'ConfigPlatformIcons'>;

export interface PlatformBadgeProps {
  platform: PlatformKey;
  /** The key's item from /v1/config.platform_icons; the caller fetches the config. */
  remote?: Schema<'ConfigPlatformIcon'> | undefined;
}

/** Built-in icons bundled with the app, named after the BR-TEXT-24 built-in file names. */
const builtinIcons: Readonly<Record<PlatformKey, string>> = {
  taobao: taobaoIcon,
  tmall: tmallIcon,
  jd: jdIcon,
  pdd: pinduoduoIcon,
  wechat: wechatIcon,
  wechat_pay: wechatPayIcon,
  alipay: alipayIcon,
  wecom: wecomIcon,
};

/**
 * Replacement urls that failed to load in this page session (BR-TEXT-24: no repeated retries
 * within a session). Shared by every instance; never reset.
 */
const failedUrls = new Set<string>();

function usableUrl(url: string | undefined): string | undefined {
  return url !== undefined && url.startsWith('https://') && !failedUrls.has(url) ? url : undefined;
}

interface Loaded {
  platform: PlatformKey;
  url: string;
}

const BADGE =
  'inline-flex h-couli-5 shrink-0 items-center gap-couli-1 whitespace-nowrap rounded-couli-pill border border-couli-source-border bg-couli-source-background px-couli-2 align-middle text-couli-caption leading-couli-caption text-couli-source-text';
const ICON = 'block size-couli-3 shrink-0';

/**
 * Source platform badge (03 §10.2): small icon plus the platform's Chinese name. The built-in
 * icon shows first; a delivered https replacement swaps in once it has loaded and falls back to
 * the built-in icon on error. Image bytes are never read. The accessible name is always the
 * platform name, whatever the icon.
 */
export function PlatformBadge({ platform, remote }: PlatformBadgeProps): ReactElement {
  const url = usableUrl(remote?.url);
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);

  useEffect(() => {
    if (url === undefined || failedUrls.has(url)) return;
    let active = true;
    const loader = new Image();
    loader.onload = () => {
      if (active) setLoaded({ platform, url });
    };
    loader.onerror = () => {
      failedUrls.add(url);
      if (active) setLoaded(undefined);
    };
    loader.src = url;
    return () => {
      active = false;
      loader.onload = null;
      loader.onerror = null;
    };
  }, [platform, url]);

  const showRemote =
    url !== undefined && loaded !== undefined && loaded.platform === platform && loaded.url === url;
  const src = showRemote ? url : builtinIcons[platform];

  function handleError(): void {
    if (!showRemote || url === undefined) return;
    failedUrls.add(url);
    setLoaded(undefined);
  }

  return (
    <span className={BADGE}>
      <img className={ICON} src={src} alt="" aria-hidden="true" onError={handleError} />
      {getPlatformName(platform)}
    </span>
  );
}
