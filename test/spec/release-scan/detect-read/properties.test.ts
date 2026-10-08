import { expect, it } from 'vitest';
import { detectSecrets } from '../../../../infra/release-scan/detect/index.ts';
import { expectClean, expectMaterial, scan } from './fixtures.ts';

it.each(['\n', '\r\n'])(
  '[AC-QA-09f-PROPERTIES#1] 换行 %j：空值键不冒充 Base64 续行，非空盐与 YAML 续行仍阻断',
  async (eol) => {
    const file = 'assets/config.properties';
    for (const gap of ['', `${eol}# comment${eol}  `]) {
      const cleanText = `shared_salt=${eol}${gap}mode=${eol}label=Demo${eol}`;
      expectClean(await scan('apk', [{ name: file, data: cleanText }]));
      expect(detectSecrets(file, cleanText)).toEqual([]);

      // 保持相邻空键，把前一行改为短盐，不能因修正跨行规则而整段忽略。
      const salt = ['demo', 'v1'].join('-');
      const populated = `shared_salt=${salt}${eol}${gap}mode=${eol}`;
      expectMaterial(await scan('apk', [{ name: file, data: populated }]), file, salt);
      expect(detectSecrets(file, populated)).toContainEqual({
        rule: 'request-sign-material',
        file,
        line: 1,
        match: salt,
        never_accepted: true,
      });
    }

    // 合法 YAML 缩进标量，分别带一个/两个填充等号；值在运行时拼接。
    for (const value of [['bW9k', 'ZQ=='].join(''), ['c2Fs', 'dDE='].join('')]) {
      for (const ext of ['yaml', 'yml']) {
        const yamlFile = `assets/config.${ext}`;
        const text = `shared_salt:${eol}  ${value}${eol}mode: demo${eol}`;
        expectMaterial(await scan('apk', [{ name: yamlFile, data: text }]), yamlFile, value);
        expect(detectSecrets(yamlFile, text)).toContainEqual({
          rule: 'request-sign-material',
          file: yamlFile,
          line: 2,
          match: value,
          never_accepted: true,
        });
      }
    }
  },
);
