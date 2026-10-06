import { expect, it } from 'vitest';
import type { ScanHit } from './index.ts';
import type { PublicItem } from './manifest.ts';
import { containsPrivateKey, isPublicId } from './public-ids.ts';

const serviceHosts: PublicItem = {
  id: 'service_hosts',
  category: 'request_routing',
  platforms: ['h5'],
};

function urlHit(match: string, rule = 'url'): ScanHit {
  return { rule, file: 'assets/main.js', line: 1, match, never_accepted: false };
}

it('[AC-QA-09a#1] 服务地址格式不覆盖 webhook 凭据上下文', () => {
  const webhook = `https://hooks.slack.com/services/EXAMPLE/EXAMPLE/${'Ab9'.repeat(8)}`;
  expect(isPublicId(serviceHosts, urlHit(webhook, 'slack-webhook-url'))).toBe(false);
  // 即使令牌路径碰巧长得像普通静态路径，检测到的凭据上下文仍然优先。
  expect(
    isPublicId(serviceHosts, urlHit('https://hooks.example.test/services/demo', 'webhook-url')),
  ).toBe(false);
});

it('[AC-QA-09a#2] 服务地址仅自动识别静态路径，不经 URL 归一化隐藏令牌', () => {
  for (const path of ['', '/', '/v1/products']) {
    expect(isPublicId(serviceHosts, urlHit(`https://api.example.test${path}`))).toBe(true);
  }
  for (const path of [
    `/services/${'Ab9'.repeat(8)}`,
    `/services/${'abc'.repeat(8)}`,
    '/services/123456',
    '/services/%61%62%63',
    `/${'Ab9'.repeat(8)}/../v1/products`,
    '/v1/products?token=example',
    '/v1/products#example',
  ]) {
    expect(isPublicId(serviceHosts, urlHit(`https://api.example.test${path}`)), path).toBe(false);
  }
});

it('[AC-QA-09a#3] 私钥头兜底识别 PGP BLOCK 后缀与大小写变体', () => {
  for (const kind of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
    const header = ['-----BEGIN', `${kind}-----`].join(' ');
    expect(containsPrivateKey(`prefix\n${header}\nsuffix`)).toBe(true);
    expect(containsPrivateKey(header.toLowerCase())).toBe(true);
  }
  expect(containsPrivateKey(['-----BEGIN', 'PUBLIC KEY-----'].join(' '))).toBe(false);
});
