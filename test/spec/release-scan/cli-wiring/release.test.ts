import { expect, it } from 'vitest';
import { protoManifest } from '../detect-assoc/android-fixtures.ts';
import { manifestWith } from '../detect/fixtures.ts';
import { axmlApplication } from '../residue/fixtures.ts';
import { expectBlocked, expectClean, runCli } from './fixtures.ts';

// QA-09e §9 的残留接线验收；只测 CLI，不能用单独解析器的成功代替发布检查。
it.each(['base', 'feature'])(
  '[AC-QA-09e-RELEASE#1] --release 阻断 %s 模块 proto 清单 compiled debuggable=true',
  async (module) => {
    const file = `${module}/manifest/AndroidManifest.xml`;
    const result = await runCli(
      'aab',
      [
        ...(module === 'base'
          ? []
          : [{ name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) }]),
        { name: file, data: protoManifest([], [{ name: 'debuggable', compiled: { bool: true } }]) },
      ],
      true,
    );
    expectBlocked(result, 'residue', 'debuggable', file);
    expect(result.report.release).toBe(true);
  },
  30_000,
);

it.each(['false', 'absent'] as const)(
  '[AC-QA-09e-RELEASE#2] --release 放行 proto 清单 debuggable=%s 的 AAB',
  async (kind) => {
    const result = await runCli(
      'aab',
      [
        {
          name: 'base/manifest/AndroidManifest.xml',
          data: protoManifest(
            [],
            kind === 'false' ? [{ name: 'debuggable', compiled: { bool: false } }] : [],
          ),
        },
      ],
      true,
    );
    expectClean(result);
    expect(result.report.release).toBe(true);
  },
  30_000,
);

it('[AC-QA-09e-RELEASE#3] 不带 --release 时 proto 调试标志不升级为密钥命中', async () => {
  const result = await runCli(
    'aab',
    [
      {
        name: 'base/manifest/AndroidManifest.xml',
        data: protoManifest([], [{ name: 'debuggable', compiled: { bool: true } }]),
      },
    ],
    false,
  );
  expectClean(result);
  expect(result.report.release).toBe(false);
}, 30_000);

it.each([
  ['双引号', '"api.staging.example.Com"'],
  ['单引号', "'api.staging.example.cOm'"],
  ['反引号', '`api.staging.example.CoM`'],
  ['XML 文本', '<host>api.staging.example.Com</host>'],
  ['配置行', 'API_HOST=api.staging.example.Com\n'],
  ['全大写', '"API.STAGING.EXAMPLE.COM"'],
  ['小写基准', '"api.staging.example.com"'],
  ['端口与路径', '"api.staging.example.Com:8443/v1"'],
  ['URL', '"https://api.staging.example.Com/v1"'],
])(
  '[AC-QA-09e-RELEASE#4] %s 中测试主机末段大小写不影响 CLI 阻断',
  async (_context, data) => {
    const result = await runCli(
      'apk',
      [
        { name: 'AndroidManifest.xml', data: axmlApplication(0) },
        { name: 'assets/vendor/config.txt', data },
      ],
      true,
    );
    expectBlocked(result, 'residue', 'test-domain', 'assets/vendor/config.txt');
    expect(result.report.release).toBe(true);
  },
  30_000,
);

it.each([
  ['test-domain', 'const host = "api.staging.example.Com";'],
  ['env-switch', 'function switchEnvironment() {}'],
])(
  '[AC-QA-09e-RELEASE#5] 第三方 SDK 的 %s 残留不接受误报清单或已批准例外豁免',
  async (rule, data) => {
    const file = 'assets/vendor/sdk.js';
    const manifest = manifestWith(
      [
        'false_positives:',
        `  - rule: ${rule}\n    file: ${file}\n    reason: 测试用豁免`,
        'exceptions:',
        `  - sdk: Demo\n    item: Demo\n    rule: ${rule}\n    file: ${file}`,
        '    scope_if_leaked: 无\n    server_side_limit: 无\n    approval: 30',
        '',
      ].join('\n'),
    );
    const result = await runCli(
      'apk',
      [
        { name: 'AndroidManifest.xml', data: axmlApplication(0) },
        { name: file, data },
      ],
      true,
      manifest,
    );
    expectBlocked(result, 'residue', rule, file);
    expect(
      result.report.findings
        .filter((finding) => finding.kind === 'residue')
        .every((finding) => finding.verdict === 'block'),
    ).toBe(true);
  },
  30_000,
);
