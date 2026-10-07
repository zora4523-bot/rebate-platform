import { join } from 'node:path';
import { expect, it } from 'vitest';
import type {
  ClientPlatform,
  ScanInput,
  ScanResult,
} from '../../../../infra/release-scan/detect/index.ts';
import { scanArtifact } from '../../../../infra/release-scan/detect/index.ts';
import {
  FAKE,
  buildZip,
  manifestWith,
  realManifest,
  sorted,
  spread,
  tempDirs,
  want,
  writeTree,
  writeZip,
} from './fixtures.ts';

// 02 §12.6 发布制品密钥扫描：读取 + 检测 + 与公开标识清单比对（QA-09a compareHits），清单内放行、其余阻断；
// 服务端密钥与 BR-ID-09 签名材料不可豁免。口径：制品扩展名决定所属端（.ipa → ios；.apk / .aab → android；
// .hap / .app → harmony；目录 → h5 / admin），端与制品不符、读取错误、清单无效时退出码 2（fail-closed）。

const newDir = tempDirs();
const ALL: readonly ClientPlatform[] = ['ios', 'android', 'harmony', 'h5', 'admin'];
const ZIP_PLATFORM: ReadonlyArray<[string, ClientPlatform]> = [
  ['ipa', 'ios'],
  ['apk', 'android'],
  ['aab', 'android'],
  ['hap', 'harmony'],
  ['app', 'harmony'],
];

function scan(path: string, platform: ClientPlatform, over: Partial<ScanInput> = {}) {
  return scanArtifact({ path, platform, manifestYaml: realManifest(), approvals: [], ...over });
}

/** 整体结论自洽：读取有错或清单无效为 2，否则跟比对报告；passed 只在 0 时为真。 */
function expectExit(result: ScanResult, exit: 0 | 1 | 2, label = ''): void {
  expect(result.exit_code, label).toBe(exit);
  expect(result.passed, label).toBe(exit === 0);
  expect(result.report.decisions.length, label).toBe(result.hits.length);
}

/** 判定摘要（file、rule、verdict、reason），排序后与独立写出的期望比较。 */
function verdicts(result: ScanResult): string[] {
  return result.report.decisions
    .map((d) => [d.hit.file, d.hit.rule, d.verdict, d.reason].join(' '))
    .sort();
}

it('[02 §12.6 扫描#1] ipa 里的服务端密钥阻断（不可豁免），崩溃上报 DSN 按公开标识放行', async () => {
  const path = writeZip(newDir(), 'demo.ipa', [
    { name: 'Payload/Demo.app/config.json', data: `{\n"appSecret":"${FAKE.hex32Low}"}` },
    { name: 'Payload/Demo.app/main.jsbundle', data: `init({dsn:"${FAKE.dsn}"});` },
    { name: 'Payload/Demo.app/Info.plist', data: '<plist><dict/></plist>' },
  ]);
  const result = await scan(path, 'ios');
  expect(result.errors).toEqual([]);
  expect(result.platform).toBe('ios');
  expect(sorted(result.hits)).toEqual([
    want('server-secret', 'Payload/Demo.app/config.json', 2, FAKE.hex32Low),
    want('high-entropy', 'Payload/Demo.app/main.jsbundle', 1, FAKE.dsn),
  ]);
  expect(verdicts(result)).toEqual([
    'Payload/Demo.app/config.json server-secret block never_accepted',
    'Payload/Demo.app/main.jsbundle high-entropy allow public_id',
  ]);
  expectExit(result, 1);
});

it('[02 §12.6 扫描#2] 只有公开标识的制品通过，退出码 0', async () => {
  const path = writeZip(newDir(), 'demo.ipa', [
    { name: 'Payload/Demo.app/main.jsbundle', data: `init({dsn:"${FAKE.dsn}"});` },
  ]);
  const result = await scan(path, 'ios');
  expect(result.errors).toEqual([]);
  expect(verdicts(result)).toEqual(['Payload/Demo.app/main.jsbundle high-entropy allow public_id']);
  expectExit(result, 0);
});

it('[02 §12.6 扫描#3] 扩展名与端对应时照常扫描；对不上的端一律退出码 2', async () => {
  const dir = newDir();
  for (const [ext, own] of ZIP_PLATFORM) {
    const path = writeZip(dir, `demo.${ext}`, [
      { name: 'assets/conf.json', data: `{"app_secret":"${FAKE.hex32Low}"}` },
    ]);
    for (const platform of ALL) {
      const result = await scan(path, platform);
      const label = `${ext} ${platform}`;
      if (platform === own) {
        expect(result.errors, label).toEqual([]);
        expect(result.hits, label).toEqual([
          want('server-secret', 'assets/conf.json', 1, FAKE.hex32Low),
        ]);
        expectExit(result, 1, label);
      } else {
        expect(result.errors.length, label).toBeGreaterThan(0);
        expectExit(result, 2, label);
      }
    }
  }
});

it('[02 §12.6 扫描#4] 构建产物目录只属 h5 / admin；三端扫目录退出码 2', async () => {
  const root = writeTree(join(newDir(), 'dist'), {
    'assets/index.js': `const c={\napiKey:"${FAKE.hex32Low}"};`,
  });
  for (const platform of ALL) {
    const result = await scan(root, platform);
    if (platform === 'h5' || platform === 'admin') {
      expect(result.errors, platform).toEqual([]);
      expect(result.hits, platform).toEqual([
        want('keyed-credential', 'assets/index.js', 2, FAKE.hex32Low),
      ]);
      expect(verdicts(result), platform).toEqual([
        'assets/index.js keyed-credential block unlisted',
      ]);
      expectExit(result, 1, platform);
    } else {
      expect(result.errors.length, platform).toBeGreaterThan(0);
      expectExit(result, 2, platform);
    }
  }
});

it('[BR-ID-09][02 §12.6 不可豁免#1] 签名材料与服务端密钥即使登记了误报与已批准的例外也阻断', async () => {
  const file = 'res/raw/sdk.json';
  const entries = (rule: string) =>
    [`  - rule: ${rule}`, `    file: ${file}`, '    reason: 示例'].join('\n');
  const exception = (rule: string) =>
    [
      '  - sdk: 示例 SDK',
      '    item: 随包配置',
      `    rule: ${rule}`,
      `    file: ${file}`,
      '    scope_if_leaked: 示例',
      '    server_side_limit: 示例',
      '    approval: 30',
    ].join('\n');
  const rules = ['request-sign-material', 'server-secret'];
  const manifestYaml = manifestWith(
    `false_positives:\n${rules.map(entries).join('\n')}\nexceptions:\n${rules.map(exception).join('\n')}\n`,
  );
  const path = writeZip(newDir(), 'demo.apk', [
    { name: file, data: `{"install_secret":"${spread(16, 32)}",\n"appSecret":"${FAKE.hex32Low}"}` },
  ]);
  const result = await scan(path, 'android', {
    manifestYaml,
    approvals: [{ id: 30, granted: true }],
  });
  expect(result.errors).toEqual([]);
  expect(result.report.errors).toEqual([]);
  expect(sorted(result.hits)).toEqual([
    want('request-sign-material', file, 1, spread(16, 32)),
    want('server-secret', file, 2, FAKE.hex32Low),
  ]);
  expect(verdicts(result)).toEqual([
    `${file} request-sign-material block never_accepted`,
    `${file} server-secret block never_accepted`,
  ]);
  expectExit(result, 1);
});

it('[02 §12.6 扫描#5] 鸿蒙 .app 内层 .hap 的密钥与 Android .so 里的私钥头都能扫到', async () => {
  const dir = newDir();
  const hap = buildZip([
    { name: 'resources/rawfile/config.json', data: `{"signKey":"${FAKE.hex32Low}"}` },
  ]);
  const app = await scan(
    writeZip(dir, 'demo.app', [{ name: 'entry-default.hap', data: hap }]),
    'harmony',
  );
  expect(app.hits).toEqual([
    want(
      'request-sign-material',
      'entry-default.hap/resources/rawfile/config.json',
      1,
      FAKE.hex32Low,
    ),
  ]);
  expectExit(app, 1, 'app');
  const header = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  const so = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]),
    Buffer.from(header),
    Buffer.from([0]),
  ]);
  const apk = await scan(
    writeZip(dir, 'demo.apk', [{ name: 'lib/arm64-v8a/libdemo.so', data: so }]),
    'android',
  );
  expect(apk.hits).toHaveLength(1);
  expect(apk.hits[0]).toMatchObject({
    rule: 'private-key',
    file: 'lib/arm64-v8a/libdemo.so',
    line: 1,
    never_accepted: true,
  });
  expect(verdicts(apk)).toEqual(['lib/arm64-v8a/libdemo.so private-key block never_accepted']);
  expectExit(apk, 1, 'apk');
});

it('[02 §12.6 扫描#6] 读取出错时退出码 2，即使已读到的命中全部放行；已读到的命中照常列出', async () => {
  const path = writeZip(newDir(), 'demo.ipa', [
    { name: 'Payload/Demo.app/main.jsbundle', data: `init({dsn:"${FAKE.dsn}"});` },
    { name: 'Payload/Demo.app/packed.bin', data: 'x'.repeat(64), method: 12 },
  ]);
  const result = await scan(path, 'ios');
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.hits).toEqual([
    want('high-entropy', 'Payload/Demo.app/main.jsbundle', 1, FAKE.dsn),
  ]);
  expectExit(result, 2);
});

it('[02 §12.6 扫描#7] 清单无法解析时退出码 2', async () => {
  const path = writeZip(newDir(), 'demo.ipa', [{ name: 'a.txt', data: 'plain' }]);
  const result = await scan(path, 'ios', { manifestYaml: 'version: [\n\titems' });
  expect(result.errors).toEqual([]);
  expect(result.report.exit_code).toBe(2);
  expectExit(result, 2);
});

it('[02 §12.6 高熵#8] 扫描函数把阈值传给检测：调高后不报、调低长度后新报', async () => {
  const root = writeTree(join(newDir(), 'dist'), {
    'a.js': `f("${spread(16, 24)}");`,
    'b.js': `f("${spread(16, 12)}");`,
  });
  const base = await scan(root, 'h5');
  expect(base.hits).toEqual([want('high-entropy', 'a.js', 1, spread(16, 24))]);
  expectExit(base, 1, 'default');
  for (const options of [{ minLength: 32 }, { minEntropy: 3.95 }]) {
    const quiet = await scan(root, 'h5', { options });
    expect(quiet.hits, JSON.stringify(options)).toEqual([]);
    expectExit(quiet, 0, JSON.stringify(options));
  }
  const low = await scan(root, 'h5', { options: { minLength: 12 } });
  expect(sorted(low.hits)).toEqual([
    want('high-entropy', 'a.js', 1, spread(16, 24)),
    want('high-entropy', 'b.js', 1, spread(16, 12)),
  ]);
  expectExit(low, 1, 'minLength 12');
});
