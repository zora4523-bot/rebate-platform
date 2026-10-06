import type { ScanHit } from './index.ts';
import type { PublicItem } from './manifest.ts';

/** 私钥头即使嵌在其他内容中也不能被误报或 SDK 豁免覆盖。 */
export function containsPrivateKey(value: string): boolean {
  return /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/i.test(value);
}

function full(pattern: RegExp, value: string): boolean {
  // JS 的 $ 可匹配末尾换行之前；额外比对整段，不能自动 trim 原始命中。
  return pattern.exec(value)?.[0] === value;
}

function publicUrl(value: string): URL | null {
  if (!full(/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/, value) || /[^\x21-\x7e]|\\/.test(value))
    return null;
  try {
    const url = new URL(value);
    // 不自动放行 query/fragment：里面可能携带签名、令牌或其他凭据。
    if (!url.hostname.includes('.') || value.includes('?') || value.includes('#')) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * 同时约束条目 id、类别与整段格式，防止一个类别下的宽格式覆盖另一条目的端限制。
 * 没有可辨认公开结构的裸 AppKey/client_id 不作猜测，也不按高熵串长度放行。
 */
export function isPublicId(item: PublicItem, hit: ScanHit): boolean {
  const value = hit.match;
  switch (item.category) {
    case 'request_routing': {
      if (item.id === 'service_hosts') {
        // HTTPS 不代表公开：webhook 等检测规则已提供凭据上下文，不能被地址格式覆盖。
        if (/(?:webhook|token|secret|password|credential|private[-_]key)/i.test(hit.rule))
          return false;
        // 只自动识别主机及短的静态路径段（含 v1 一类版本段）。长串、混合大小写、
        // 动态数字与编码路径无法证明不含凭据，交回清单逐项判定；不先用 URL
        // 归一化，避免 /<令牌>/../ 等路径把凭据抹掉。这里不猜测令牌的熵。
        if (!full(/^https:\/\/[^/?#]+(?:\/(?:v[1-9][0-9]*|[a-z][a-z-]{0,22}))*\/?$/, value))
          return false;
        const url = publicUrl(value);
        return url !== null && url.username === '' && url.password === '' && !value.includes('@');
      }
      // app_id 的字符集来自 contracts/openapi.yaml AppId；只有专用检测规则提供
      // 字段上下文时才识别，普通高熵串不能借这个较宽的字符集放行。
      if (item.id === 'app_id' && hit.rule === 'app_id') {
        return full(/^[a-z0-9_]{1,32}$/, value) && !full(/^[a-f0-9]{32}$/, value);
      }
      if (item.id === 'custom_scheme') {
        return full(/^[a-z][a-z0-9+.-]*:\/\/$/, value);
      }
      return false;
    }
    case 'wechat':
      return item.id === 'wechat_app_id' && full(/^wx[a-f0-9]{16}$/, value);
    case 'system_capability':
      return (
        item.id === 'bundle_identity' &&
        // 裸的点分字符串也可能是令牌，包身份需要检测段确认字段上下文。
        hit.rule === 'bundle_identity' &&
        full(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/, value)
      );
    case 'crash_report': {
      if (item.id !== 'crash_report_endpoint') return false;
      const url = publicUrl(value);
      return (
        url !== null &&
        url.password === '' &&
        full(/^[a-f0-9]{32}$/, url.username) &&
        full(/^\/[0-9]+$/, url.pathname) &&
        // URL 会丢掉空密码分隔符；要求原始 authority 也没有 secret 段。
        value.startsWith(`https://${url.username}@`)
      );
    }
    case 'config_verification':
      return (
        item.id === 'config_public_keys' &&
        full(
          /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/]+={0,2}\r?\n)+-----END PUBLIC KEY-----$/,
          value,
        )
      );
    case 'huawei':
    case 'push_client':
    case 'union_sdk':
      // TODO(规划/11 §7.1): 补充可区分服务端凭据的 SDK 公开标识格式 — blocked on 尚未提供平台资料
      return false;
  }
}
