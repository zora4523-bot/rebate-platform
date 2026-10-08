import { expect, it } from 'vitest';
import { protoManifest, resourcesPb } from '../detect-assoc/android-fixtures.ts';
import { moduleJson, resourcesIndex } from '../detect-assoc/harmony-fixtures.ts';
import type { ZipFile } from '../detect/fixtures.ts';
import { expectBlocked, runCli } from './fixtures.ts';

// BR-ID-09 安装包不得内置签名材料；QA-09e §9 要求关联结果经 CLI 生效。
// 使用短、低熵的运行时假值，避免仅靠高熵扫描就通过测试。
it.each([false, true])(
  '[AC-QA-09e-ASSOC#1] AAB resources.pb 的签名字段经 CLI 阻断（release=%s）',
  async (release) => {
    const salt = ['demo', 'v1'].join('-');
    const result = await runCli(
      'aab',
      [
        { name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) },
        { name: 'base/resources.pb', data: resourcesPb([{ name: 'shared_salt', values: [salt] }]) },
      ],
      release,
    );
    expectBlocked(result, 'secret', 'request-sign-material', 'base/resources.pb');
    expect(result.report.release).toBe(release);
    expect(result.output).not.toContain(salt);
  },
  30_000,
);

it.each(['value', 'resource'] as const)(
  '[AC-QA-09e-ASSOC#2] AAB proto meta-data.%s 关联普通资源名后以引用方签名字段阻断',
  async (attribute) => {
    const salt = ['demo', 'v1'].join('-');
    const result = await runCli(
      'aab',
      [
        {
          name: 'base/manifest/AndroidManifest.xml',
          data: protoManifest([{ name: 'shared_salt', attribute, value: { ref: 0x7f010000 } }]),
        },
        { name: 'base/resources.pb', data: resourcesPb([{ name: 'build_value', values: [salt] }]) },
      ],
      false,
    );
    expectBlocked(result, 'secret', 'request-sign-material', 'base/manifest/AndroidManifest.xml');
    expect(result.output).not.toContain(salt);
  },
  30_000,
);

it('[AC-QA-09e-ASSOC#3] AAB feature 模块的 proto 清单也经 CLI 关联扫描', async () => {
  const salt = ['demo', 'v1'].join('-');
  const result = await runCli(
    'aab',
    [
      { name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) },
      {
        name: 'feature/manifest/AndroidManifest.xml',
        data: protoManifest([
          { name: 'shared_salt', attribute: 'value', value: { ref: 0x7f010000 } },
        ]),
      },
      {
        name: 'feature/resources.pb',
        data: resourcesPb([{ name: 'build_value', values: [salt] }]),
      },
    ],
    true,
  );
  expectBlocked(result, 'secret', 'request-sign-material', 'feature/manifest/AndroidManifest.xml');
  expect(result.output).not.toContain(salt);
}, 30_000);

it.each(['module', 'ability', 'extension'] as const)(
  '[AC-QA-09e-ASSOC#4] HAP %s metadata name/value 的短共享盐经 CLI 阻断',
  async (scope) => {
    const salt = ['demo', 'v1'].join('-');
    const result = await runCli(
      'hap',
      [{ name: 'module.json', data: moduleJson([{ name: 'shared_salt', value: salt }], scope) }],
      false,
    );
    expectBlocked(result, 'secret', 'request-sign-material', 'module.json');
    expect(result.output).not.toContain(salt);
  },
  30_000,
);

it.each([false, true])(
  '[AC-QA-09e-ASSOC#5] HAP resources.index 的签名字段经 CLI 阻断（release=%s）',
  async (release) => {
    const salt = ['demo', 'v1'].join('-');
    const result = await runCli(
      'hap',
      [
        { name: 'module.json', data: moduleJson([]) },
        {
          name: 'resources.index',
          data: resourcesIndex([{ id: 0x01000000, name: 'shared_salt', value: salt }]),
        },
      ],
      release,
    );
    expectBlocked(result, 'secret', 'request-sign-material', 'resources.index');
    expect(result.report.release).toBe(release);
    expect(result.output).not.toContain(salt);
  },
  30_000,
);

it('[AC-QA-09e-ASSOC#6] HAP metadata.resource 关联普通资源名后以引用方签名字段阻断', async () => {
  const salt = ['demo', 'v1'].join('-');
  const result = await runCli(
    'hap',
    [
      {
        name: 'module.json',
        data: moduleJson([{ name: 'shared_salt', resource: '$string:build_value' }]),
      },
      {
        name: 'resources.index',
        data: resourcesIndex([{ id: 0x01000000, name: 'build_value', value: salt }]),
      },
    ],
    true,
  );
  expectBlocked(result, 'secret', 'request-sign-material', 'module.json');
  expect(result.output).not.toContain(salt);
}, 30_000);

it.each(['missing-table', 'missing-id', 'cycle', 'partial-config'] as const)(
  '[AC-QA-09e-ASSOC#7] AAB 签名字段引用 %s 经 CLI 退出 2 并报告读取失败',
  async (kind) => {
    const files: ZipFile[] = [
      {
        name: 'base/manifest/AndroidManifest.xml',
        data: protoManifest([
          {
            name: 'shared_salt',
            attribute: 'value',
            value: { ref: kind === 'missing-id' ? 0x7f010099 : 0x7f010000 },
          },
        ]),
      },
    ];
    if (kind !== 'missing-table')
      files.push({
        name: 'base/resources.pb',
        data: resourcesPb([
          {
            name: 'build_value',
            values:
              kind === 'cycle'
                ? [{ ref: 0x7f010000 }]
                : kind === 'partial-config'
                  ? ['', { ref: 0x7f010099 }]
                  : ['Demo'],
          },
        ]),
      });
    const result = await runCli('aab', files, false);
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({ exit_code: 2, passed: false, release: false });
    expect(result.report.errors.length).toBeGreaterThan(0);
    expect(result.report.errors.join('\n')).toMatch(
      /unreadable|cannot.*pars|could not.*read|unresolved/i,
    );
  },
  30_000,
);

it.each(['missing-table', 'missing-name'] as const)(
  '[AC-QA-09e-ASSOC#8] HAP 签名字段引用 %s 经 CLI 退出 2 并报告读取失败',
  async (kind) => {
    const files: ZipFile[] = [
      {
        name: 'module.json',
        data: moduleJson([{ name: 'shared_salt', resource: '$string:build_value' }]),
      },
    ];
    if (kind === 'missing-name')
      files.push({
        name: 'resources.index',
        data: resourcesIndex([{ id: 0x01000000, name: 'other', value: 'Demo' }]),
      });
    const result = await runCli('hap', files, true);
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({ exit_code: 2, passed: false, release: true });
    expect(result.report.errors.length).toBeGreaterThan(0);
    expect(result.report.errors.join('\n')).toMatch(
      /unreadable|cannot.*pars|could not.*read|unresolved/i,
    );
  },
  30_000,
);

it('[AC-QA-09e-ASSOC#9] AAB resources.pb 自身的签名字段悬空引用也经 CLI 阻断', async () => {
  const result = await runCli(
    'aab',
    [
      { name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) },
      {
        name: 'base/resources.pb',
        data: resourcesPb([{ name: 'shared_salt', values: [{ ref: 0x7f010099 }] }]),
      },
    ],
    false,
  );
  expect(result.code).toBe(2);
  expect(result.report).toMatchObject({ exit_code: 2, passed: false });
  expect(result.report.errors.length).toBeGreaterThan(0);
  expect(result.report.errors.join('\n')).toMatch(
    /unreadable|cannot.*pars|could not.*read|unresolved/i,
  );
}, 30_000);
