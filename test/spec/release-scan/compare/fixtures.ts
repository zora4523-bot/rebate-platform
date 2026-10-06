import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type {
  ApprovalRecord,
  ClientPlatform,
  CompareReport,
  ScanHit,
} from '../../../../infra/release-scan/compare/index.ts';
import { compareHits } from '../../../../infra/release-scan/compare/index.ts';

// 假值一律在运行时拼接（不在源码里留下像密钥的字面量，仓库 gitleaks 不会命中），且一眼可辨是假的。
export const FAKE = {
  /** 32 位小写十六进制（02 §12.6 联盟 / 微信 AppSecret 一类的格式）。 */
  hex32: 'ab12'.repeat(8),
  /** 40 位小写十六进制。 */
  hex40: 'cd345'.repeat(8),
  /** 微信开放平台 AppID 形状：wx + 16 位小写十六进制。 */
  wxAppId: `wx${'0a1b2c3d'.repeat(2)}`,
  privateKeyHeader: ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '),
  rsaPrivateKeyHeader: ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
  publicKeyPem: [
    ['-----BEGIN', 'PUBLIC', 'KEY-----'].join(' '),
    `MFkw${'EXAMPLE0'.repeat(8)}`,
    ['-----END', 'PUBLIC', 'KEY-----'].join(' '),
  ].join('\n'),
  get sentryDsn(): string {
    return `https://${this.hex32}@o1.ingest.example.test/42`;
  },
  get sentryDsnWithSecret(): string {
    return `https://${this.hex32}:${this.hex32}@o1.ingest.example.test/42`;
  },
  apiUrl: 'https://api.example.test/v1/products',
  apiUrlWithUserinfo: ['https://', 'demo', ':', 'EXAMPLEpass', '@api.example.test/v1'].join(''),
};

export const ALL_PLATFORMS: readonly ClientPlatform[] = [
  'ios',
  'android',
  'harmony',
  'h5',
  'admin',
];

const MANIFEST_URL = new URL('../../../../specs/client-public-ids.yaml', import.meta.url);
const EMPTY_LISTS = 'false_positives: []\nexceptions: []\n';

/** 仓库里的真实清单原文。 */
export function realManifest(): string {
  return readFileSync(MANIFEST_URL, 'utf8');
}

/** 真实清单，把 false_positives / exceptions 换成给定的 YAML 片段（各自带键名）。 */
export function manifestWith(lists: { falsePositives?: string; exceptions?: string }): string {
  const text = realManifest();
  expect(text.includes(EMPTY_LISTS), '真实清单的 false_positives/exceptions 应为空列表').toBe(true);
  const fp = lists.falsePositives ?? 'false_positives: []\n';
  const ex = lists.exceptions ?? 'exceptions: []\n';
  return text.replace(EMPTY_LISTS, `${fp}${ex}`);
}

export const GRANTED: readonly ApprovalRecord[] = [
  { id: 30, granted: true },
  { id: 31, granted: false },
];

export function hit(over: Partial<ScanHit> = {}): ScanHit {
  return {
    rule: 'generic-high-entropy',
    file: 'assets/main.js',
    line: 1,
    match: FAKE.hex32,
    never_accepted: false,
    ...over,
  };
}

export function run(
  hits: readonly ScanHit[],
  opts: {
    platform?: ClientPlatform;
    manifestYaml?: string;
    approvals?: readonly ApprovalRecord[];
  } = {},
): CompareReport {
  return compareHits({
    manifestYaml: opts.manifestYaml ?? realManifest(),
    approvals: opts.approvals ?? GRANTED,
    platform: opts.platform ?? 'ios',
    hits,
  });
}

/**
 * 整体结论核对：退出码、passed、汇总都必须与期望一致，且汇总与逐项判定自洽
 * （防止逐项判定对了、汇总或退出码却另按别的依据放行）。
 */
export function expectOutcome(
  report: CompareReport,
  want: { exit_code: 0 | 1 | 2; allowed: number; blocked: number },
  label = '',
): void {
  expect(report.exit_code, label).toBe(want.exit_code);
  expect(report.passed, label).toBe(want.exit_code === 0);
  expect(report.summary, label).toEqual({
    total: want.allowed + want.blocked,
    allowed: want.allowed,
    blocked: want.blocked,
  });
  expect(report.decisions.filter((d) => d.verdict === 'allow').length, label).toBe(want.allowed);
  expect(report.decisions.filter((d) => d.verdict === 'block').length, label).toBe(want.blocked);
}
