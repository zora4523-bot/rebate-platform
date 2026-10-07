import { createPropStats, propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { DetectOptions } from '../../../../infra/release-scan/detect/index.ts';
import {
  defaultDetectOptions,
  detectSecrets,
  scanArtifact,
  shannonEntropy,
} from '../../../../infra/release-scan/detect/index.ts';
import { realManifest, spread, tempDirs, want, writeZip } from './fixtures.ts';

// 02 §12.6 规则里的「高熵字符串」：候选串 = 最长连续的 [A-Za-z0-9+/=_-]（'-'、'_' 不切段），
// 长度 ≥ minLength、同时含字母与数字、香农熵 ≥ minEntropy（都含等号）。
// 二进制条目除按 latin1 外，还要提取无 BOM 的 UTF-16LE 可打印串一并检测（编译后资源的字符串池）。
// 口径：默认 minLength = 20、minEntropy = 3.5 bit / 字符（与仓库 .gitleaks.toml cn-doc-secret 的熵阈值一致；
// 「不含数字的串不报」同该规则的放行写法）。两个阈值都可配置，部分覆盖时其余取默认。

const FILE = 'assets/app.js';
const newDir = tempDirs();
const wrap = (s: string) => `f("${s}");`;
const flagged = (s: string, options?: Partial<DetectOptions>) =>
  detectSecrets(FILE, wrap(s), options);

it('[02 §12.6 高熵#1] 默认阈值为 minLength 20、minEntropy 3.5', () => {
  expect(defaultDetectOptions()).toEqual({ minLength: 20, minEntropy: 3.5 });
});

it('[02 §12.6 高熵#2] 香农熵按 bit / 字符计算', () => {
  const cases: Array<[string, number]> = [
    ['', 0],
    ['aaaa', 0],
    ['aabb', 1],
    ['abcd', 2],
    [spread(8, 16), 3],
    [spread(16, 32), 4],
    [spread(12, 24), Math.log2(12)],
  ];
  for (const [s, h] of cases) expect(shannonEntropy(s), s).toBeCloseTo(h, 9);
});

it('[02 §12.6 高熵#3] 默认阈值：熵 3.585 报、3.459 不报；长度 20 报、19 不报', () => {
  expect(flagged(spread(12, 24))).toEqual([want('high-entropy', FILE, 1, spread(12, 24))]);
  expect(flagged(spread(11, 22))).toEqual([]);
  expect(flagged(spread(16, 20))).toEqual([want('high-entropy', FILE, 1, spread(16, 20))]);
  expect(flagged(spread(16, 19))).toEqual([]);
});

it('[02 §12.6 高熵#4] 换熵阈值后按新值判定（3.0、3.95），长度仍取默认', () => {
  expect(flagged(spread(11, 22), { minEntropy: 3.0 })).toEqual([
    want('high-entropy', FILE, 1, spread(11, 22)),
  ]);
  expect(flagged(spread(7, 21), { minEntropy: 3.0 })).toEqual([]);
  expect(flagged(spread(16, 32), { minEntropy: 3.95 })).toEqual([
    want('high-entropy', FILE, 1, spread(16, 32)),
  ]);
  expect(flagged(spread(15, 30), { minEntropy: 3.95 })).toEqual([]);
  expect(flagged(spread(16, 12), { minEntropy: 3.0 })).toEqual([]);
});

it('[02 §12.6 高熵#5] 换长度阈值后按新值判定（32、12），熵仍取默认', () => {
  expect(flagged(spread(16, 32), { minLength: 32 })).toEqual([
    want('high-entropy', FILE, 1, spread(16, 32)),
  ]);
  expect(flagged(spread(16, 31), { minLength: 32 })).toEqual([]);
  expect(flagged(spread(16, 12), { minLength: 12 })).toEqual([
    want('high-entropy', FILE, 1, spread(16, 12)),
  ]);
  expect(flagged(spread(16, 11), { minLength: 12 })).toEqual([]);
  expect(flagged(spread(8, 16), { minLength: 12 })).toEqual([]);
});

it('[02 §12.6 高熵#6] 只有字母或只有数字的串不按高熵报；同长度的字母数字混合串报', () => {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCD';
  expect(flagged(letters)).toEqual([]);
  expect(flagged('0123456789'.repeat(3), { minEntropy: 3.0 })).toEqual([]);
  expect(flagged(spread(30, 30))).toEqual([want('high-entropy', FILE, 1, spread(30, 30))]);
});

/** 测试自带的参照实现（不调用被测函数）。 */
function refEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** base64url 字母表：字母数字加 '-'、'_'（候选串可跨这两个字符连成一段）。 */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * 43 位无填充 base64url 形状的假签名密钥：'_'、'-' 把它切成 16、12、13 位三段（都短于默认长度 20），
 * 整体熵约 4.10。运行时拼接，不是任何真实密钥。
 */
const KEY43 = `${spread(16, 16)}_${spread(12, 12)}-${spread(13, 12)}A`;

it('[BR-ID-09][02 §12.6 高熵#9] 无字段名的 43 位 base64url 签名密钥按整段检出（不按 - _ 切段）', () => {
  expect(KEY43).toHaveLength(43);
  for (const content of [`sign(req, "${KEY43}");`, `sign(req,${KEY43})`, `\n${KEY43}\n`]) {
    const line = content.startsWith('\n') ? 2 : 1;
    expect(detectSecrets(FILE, content), content).toEqual([
      want('high-entropy', FILE, line, KEY43),
    ]);
  }
});

it('[BR-ID-09][02 §12.6 高熵#10] 扫描制品：无字段名的 base64url 签名密钥使制品被阻断（不是公开标识）', async () => {
  const path = writeZip(newDir(), 'demo.ipa', [
    { name: 'Payload/Demo.app/main.jsbundle', data: `x=sign(req,"${KEY43}");` },
  ]);
  const result = await scanArtifact({
    path,
    platform: 'ios',
    manifestYaml: realManifest(),
    approvals: [],
  });
  expect(result.errors).toEqual([]);
  expect(result.hits).toEqual([want('high-entropy', 'Payload/Demo.app/main.jsbundle', 1, KEY43)]);
  expect(result.report.decisions.map((d) => [d.verdict, d.reason])).toEqual([
    ['block', 'unlisted'],
  ]);
  expect(result.exit_code).toBe(1);
  expect(result.passed).toBe(false);
});

it('[02 §12.6 高熵#11] 二进制里无 BOM 的 UTF-16LE 串（如编译后资源的字符串池）也按高熵检出', () => {
  const bytes = Buffer.concat([
    Buffer.from([0x03, 0x00, 0x08, 0x00, 0x2b, 0x01]),
    Buffer.from(KEY43, 'utf16le'),
    Buffer.from([0x00, 0x00, 0xff, 0x7f]),
  ]);
  const found = detectSecrets('resources.arsc', bytes).filter(
    (h) => h.rule === 'high-entropy' && h.match === KEY43 && h.file === 'resources.arsc',
  );
  expect(found).toHaveLength(1);
});

it('[02 §12.6 高熵#7] 属性：任意阈值与 base64url 字符串（含 - _），报与不报和参照判定一致', () => {
  const stats = createPropStats('release-scan:detect:entropy');
  const arb = fc.record({
    s: fc
      .array(fc.constantFrom(...B64URL.split('')), { minLength: 6, maxLength: 48 })
      .map((cs) => cs.join(''))
      .filter((s) => !s.includes(['LT', 'AI'].join(''))),
    minLength: fc.integer({ min: 6, max: 40 }),
    minEntropy: fc.integer({ min: 200, max: 450 }).map((n) => n / 100),
  });
  fc.assert(
    fc.property(arb, ({ s, minLength, minEntropy }) => {
      const h = refEntropy(s);
      if (Math.abs(h - minEntropy) < 1e-9) {
        stats.hit('boundary');
        return true;
      }
      const expected =
        s.length >= minLength && /[A-Za-z]/.test(s) && /[0-9]/.test(s) && h >= minEntropy;
      const hits = flagged(s, { minLength, minEntropy });
      const h0 = hits[0];
      const ok = expected
        ? hits.length === 1 &&
          h0 !== undefined &&
          h0.rule === 'high-entropy' &&
          h0.match === s &&
          h0.line === 1 &&
          h0.file === FILE &&
          !h0.never_accepted
        : hits.length === 0;
      stats.hit(ok ? (expected ? 'flagged' : 'clean') : 'bad');
      return ok;
    }),
    propParams(),
  );
  const record = stats.flush();
  expect(record.hits['bad']).toBeUndefined();
  expect(Object.values(record.hits).reduce((a, b) => a + b, 0)).toBe(propRuns());
}, 900_000);
