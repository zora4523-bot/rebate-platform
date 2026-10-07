import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ReadResult } from '../../../../infra/release-scan/detect/index.ts';
import { readArtifact } from '../../../../infra/release-scan/detect/index.ts';
import { buildZip, tempDirs, writeTree, writeZip } from './fixtures.ts';

// 02 §12.6 发布制品密钥扫描：三端制品（.ipa / .apk / .aab / .hap / .app）解包扫描，H5 与后台扫描构建产物目录。
// 口径：zip 以中央目录为准，支持 stored、deflate 与数据描述符；目录条目不列出；包内嵌套制品继续解包、
// 路径写作「内层制品路径/内层条目路径」、内层制品本身不列出；目录递归、含点开头的文件、路径用 `/`。
// 读不了的（不认识的扩展名、路径不存在、zip 损坏、不支持的压缩方式、加密条目、符号链接）都要报错（fail-closed）。

const newDir = tempDirs();

/** 把读取结果换成「路径 → utf8 文本」并按路径排序，便于与独立写出的期望比较。 */
function listing(result: ReadResult): Array<[string, string]> {
  return result.entries
    .map((e): [string, string] => [e.path, Buffer.from(e.content).toString('utf8')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

it('[02 §12.6 制品#2] stored、deflate、数据描述符三种条目都按原字节读出，目录条目不列出', async () => {
  const path = writeZip(newDir(), 'demo.ipa', [
    { name: 'Payload/', data: '', method: 0 },
    { name: 'Payload/Demo.app/a.txt', data: 'stored-entry\n', method: 0 },
    { name: 'Payload/Demo.app/b.json', data: '{"k":"deflated"}' },
    { name: 'Payload/Demo.app/c.js', data: 'console.log("descriptor");', descriptor: true },
  ]);
  const result = await readArtifact(path);
  expect(result.errors).toEqual([]);
  expect(listing(result)).toEqual([
    ['Payload/Demo.app/a.txt', 'stored-entry\n'],
    ['Payload/Demo.app/b.json', '{"k":"deflated"}'],
    ['Payload/Demo.app/c.js', 'console.log("descriptor");'],
  ]);
});

it('[02 §12.6 制品#3] 五种扩展名都按 zip 解包', async () => {
  const dir = newDir();
  for (const ext of ['ipa', 'apk', 'aab', 'hap', 'app']) {
    const result = await readArtifact(
      writeZip(dir, `demo.${ext}`, [{ name: 'x/y.txt', data: ext }]),
    );
    expect(result.errors, ext).toEqual([]);
    expect(listing(result), ext).toEqual([['x/y.txt', ext]]);
  }
});

it('[02 §12.6 制品#4] 鸿蒙 .app 里的 .hap、iOS 包里的 .zip、Android 包里的 .jar 继续解包，内层制品本身不列出', async () => {
  const inner = buildZip([
    { name: 'resources/rawfile/config.json', data: '{"a":1}' },
    { name: 'ets/modules.abc', data: 'abc-bytes', method: 0 },
  ]);
  const cases: Array<[string, string]> = [
    ['demo.app', 'entry-default.hap'],
    ['demo.ipa', 'Payload/Demo.app/res.zip'],
    ['demo.apk', 'lib/sdk.jar'],
  ];
  const dir = newDir();
  for (const [name, nested] of cases) {
    const path = writeZip(dir, name, [
      { name: nested, data: inner },
      { name: 'pack.info', data: 'info' },
    ]);
    const result = await readArtifact(path);
    expect(result.errors, name).toEqual([]);
    expect(listing(result), name).toEqual([
      [`${nested}/ets/modules.abc`, 'abc-bytes'],
      [`${nested}/resources/rawfile/config.json`, '{"a":1}'],
      ['pack.info', 'info'],
    ]);
  }
});

it('[02 §12.6 制品#5] 构建产物目录递归读取，含点开头的文件，路径相对根目录并用 / 分隔', async () => {
  const root = writeTree(join(newDir(), 'dist'), {
    'index.html': '<html></html>',
    'assets/js/app.js': 'app()',
    'assets/js/app.js.map': '{}',
    '.well-known/apple-app-site-association': '{"applinks":{}}',
    '.env.production': 'MODE=prod',
  });
  const result = await readArtifact(root);
  expect(result.errors).toEqual([]);
  expect(listing(result)).toEqual([
    ['.env.production', 'MODE=prod'],
    ['.well-known/apple-app-site-association', '{"applinks":{}}'],
    ['assets/js/app.js', 'app()'],
    ['assets/js/app.js.map', '{}'],
    ['index.html', '<html></html>'],
  ]);
});

it('[02 §12.6 制品#6] 读不了的一律报错：不支持的压缩方式、加密条目、截断的 zip、不认识的扩展名、路径不存在', async () => {
  const dir = newDir();
  const good = { name: 'ok.txt', data: 'ok' };
  const truncated = buildZip([good, { name: 'b.txt', data: 'b'.repeat(200) }]);
  writeFileSync(join(dir, 'cut.apk'), truncated.subarray(0, Math.floor(truncated.length / 2)));
  const paths = [
    writeZip(dir, 'bzip.ipa', [good, { name: 'packed.bin', data: 'x'.repeat(64), method: 12 }]),
    writeZip(dir, 'locked.hap', [
      good,
      { name: 'locked.bin', data: 'y', method: 0, encrypted: true },
    ]),
    join(dir, 'cut.apk'),
    writeZip(dir, 'demo.zip', [good]),
    join(dir, 'missing.ipa'),
    join(dir, 'missing-dir'),
  ];
  for (const path of paths) {
    const result = await readArtifact(path);
    expect(result.errors.length, path).toBeGreaterThan(0);
  }
});

it('[02 §12.6 制品#7] 构建产物目录里有符号链接时报错、不跟随', async () => {
  const dir = newDir();
  const root = writeTree(join(dir, 'dist'), { 'index.html': '<html></html>' });
  writeTree(join(dir, 'outside'), { 'secret.txt': 'outside' });
  symlinkSync(join(dir, 'outside'), join(root, 'linked'));
  const result = await readArtifact(root);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.entries.some((e) => e.path.startsWith('linked/'))).toBe(false);
});
