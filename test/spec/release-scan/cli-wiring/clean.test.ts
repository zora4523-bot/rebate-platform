import { expect, it } from 'vitest';
import { protoManifest, resourcesPb } from '../detect-assoc/android-fixtures.ts';
import { moduleJson, resourcesIndex } from '../detect-assoc/harmony-fixtures.ts';
import type { ZipFile } from '../detect/fixtures.ts';
import { axmlApplication, mobileprovision } from '../residue/fixtures.ts';
import { expectClean, runCli } from './fixtures.ts';

// QA-09e §9 正例：真实走 CLI 与关联读取，防止用「二进制一律报错」满足负例。
it.each(['aab', 'hap', 'apk', 'ipa'] as const)(
  '[AC-QA-09e-CLEAN#1] 干净的 %s Release 制品退出 0，报告无错误、无命中',
  async (ext) => {
    const files: Record<typeof ext, ZipFile[]> = {
      aab: [
        {
          name: 'base/manifest/AndroidManifest.xml',
          data: protoManifest(
            [
              { name: 'title', attribute: 'value', value: { ref: 0x7f010000 } },
              { name: 'shared_salt', attribute: 'value', value: { ref: 0x7f010001 } },
            ],
            [{ name: 'debuggable', compiled: { bool: false } }],
          ),
        },
        {
          name: 'base/resources.pb',
          data: resourcesPb([
            { name: 'label', values: ['Demo'] },
            { name: 'empty', values: [''] },
          ]),
        },
      ],
      hap: [
        {
          name: 'module.json',
          data: moduleJson([
            { name: 'title', resource: '$string:label' },
            { name: 'shared_salt', value: '' },
          ]),
        },
        {
          name: 'resources.index',
          data: resourcesIndex([{ id: 0x01000000, name: 'label', value: 'Demo' }]),
        },
      ],
      apk: [
        { name: 'AndroidManifest.xml', data: axmlApplication(0) },
        { name: 'assets/config.txt', data: 'API_HOST=api.couliapp.Com\n' },
      ],
      ipa: [
        {
          name: 'Payload/Demo.app/Info.plist',
          data: '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.couli.app</string></dict></plist>',
        },
        // 包含 Apple DTD；接关联视图后仍应保留既有的合法 plist 处理。
        { name: 'Payload/Demo.app/embedded.mobileprovision', data: mobileprovision(false) },
      ],
    };
    const result = await runCli(ext, files[ext], true);
    expectClean(result);
    expect(result.report.release).toBe(true);
  },
  30_000,
);
