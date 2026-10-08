import { expect, it } from 'vitest';
import { pb, protoManifest, resourcesPb } from '../detect-assoc/android-fixtures.ts';
import { expectClean, expectMaterial, scan } from './fixtures.ts';

// 独立编码 UTF-8 ResStringPool：source_pool.data 不是任意裸文本。
// 偏移表与记录逐项填充；夹具本身不对十几万个参数使用展开调用。
function sourcePool(count: number, replacements: ReadonlyMap<number, string>): Buffer {
  const records: Buffer[] = [];
  const offsets = Buffer.alloc(count * 4);
  let size = 0;
  for (let i = 0; i < count; i++) {
    const text = replacements.get(i) ?? `r/${String(i).padStart(6, '0')}.xml`;
    const bytes = Buffer.from(text);
    // 本夹具所有字符串均为 <128 字节 ASCII，两个长度各用一个字节。
    const record = Buffer.concat([
      Buffer.from([text.length, bytes.length]),
      bytes,
      Buffer.from([0]),
    ]);
    offsets.writeUInt32LE(size, i * 4);
    records.push(record);
    size += record.length;
  }
  const header = Buffer.alloc(28);
  const padding = Buffer.alloc((4 - (size % 4)) % 4);
  header.writeUInt16LE(1, 0);
  header.writeUInt16LE(28, 2);
  header.writeUInt32LE(28 + offsets.length + size + padding.length, 4);
  header.writeUInt32LE(count, 8);
  header.writeUInt32LE(0x100, 16);
  header.writeUInt32LE(28 + offsets.length, 20);
  return Buffer.concat([header, offsets, Buffer.concat(records), padding]);
}

it('[AC-QA-09f-SOURCE-POOL#1] 160000 条来源路径不因展开传参判损坏，池首中尾及后续资源的签名盐仍阻断', async () => {
  const file = 'base/resources.pb';
  const count = 160_000;
  const cleanPool = sourcePool(count, new Map());
  expect(cleanPool.readUInt32LE(8)).toBe(160_000);
  const manifest = { name: 'base/manifest/AndroidManifest.xml', data: protoManifest([]) };
  expectClean(
    await scan('aab', [
      manifest,
      {
        name: file,
        data: Buffer.concat([
          pb(1, pb(1, cleanPool)),
          resourcesPb([{ name: 'label', values: ['Demo'] }]),
        ]),
        method: 0,
      },
    ]),
  );

  const first = ['demo', 'first'].join('-');
  const middle = ['demo', 'middle'].join('-');
  const last = ['demo', 'last'].join('-');
  const afterPool = ['demo', 'after'].join('-');
  const pool = sourcePool(
    count,
    new Map([
      [0, `src/shared_salt='${first}'/values.xml`],
      [80_000, `src/shared_salt='${middle}'/values.xml`],
      [159_999, `src/shared_salt='${last}'/values.xml`],
    ]),
  );
  const blocked = await scan('aab', [
    manifest,
    {
      name: file,
      data: Buffer.concat([
        pb(1, pb(1, pool)),
        resourcesPb([{ name: 'shared_salt', values: [afterPool] }]),
      ]),
      method: 0,
    },
  ]);
  for (const salt of [first, middle, last, afterPool]) expectMaterial(blocked, file, salt);
}, 120_000);
