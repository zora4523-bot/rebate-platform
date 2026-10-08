import { expect, it } from 'vitest';
import { chunk, stringPool, u16, u32 } from '../detect-assoc/android-fixtures.ts';
import { expectClean, expectMaterial, scan } from './fixtures.ts';

// ResXMLTree_cdataExt = data 字符串索引 + 8 字节 typedData。
// 真实资源中的文本 CDATA 可附全零 typedData（size=0、TYPE_NULL），文本仍在 data 指向的池内。
// 这里只合成格式，不复制真实制品内容，也不调用被测解析器构造期望。
function cdataXml(text: string, form: 'untyped' | 'typed' | 'bad-index' | 'truncated'): Buffer {
  const none = 0xffffffff;
  const typed =
    form === 'typed' ? Buffer.concat([u16(8), Buffer.from([0, 3]), u32(1)]) : Buffer.alloc(8);
  const cdata = chunk(
    0x0104,
    16,
    u32(2, none, form === 'bad-index' ? 2 : 1),
    form === 'truncated' ? typed.subarray(0, 4) : typed,
  );
  return chunk(
    3,
    8,
    stringPool(['resources', text]),
    chunk(0x0102, 16, u32(1, none, none, 0), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0)),
    cdata,
    chunk(0x0103, 16, u32(3, none, none, 0)),
  );
}

it.each(['res/xml/demo.xml', 'AndroidManifest.xml'])(
  '[AC-QA-09f-CDATA#1] %s 的合法 CDATA 不判损坏，CDATA 内签名盐仍不可豁免',
  async (file) => {
    // 首个断言复现本任务误报；同一用例随后校验标准 typedData 和真实材料，先红不靠占位接口。
    const clean = await scan('apk', [{ name: file, data: cdataXml('Demo', 'untyped') }]);
    expectClean(clean);
    const salt = ['demo', 'v1'].join('-');
    for (const form of ['untyped', 'typed'] as const) {
      const blocked = await scan('apk', [
        { name: file, data: cdataXml(`shared_salt='${salt}'`, form) },
      ]);
      expectMaterial(blocked, file, salt);
      expectClean(await scan('apk', [{ name: file, data: cdataXml('Demo', form) }]));
    }
    // 放宽只针对合法文本节点；字符串越界与 typedData 实际截断仍须读取失败。
    for (const form of ['bad-index', 'truncated'] as const) {
      const broken = await scan('apk', [{ name: file, data: cdataXml('Demo', form) }]);
      expect(broken.errors.some((error) => error.includes(file))).toBe(true);
      expect(broken.exit_code).toBe(2);
      expect(broken.passed).toBe(false);
    }
  },
);
