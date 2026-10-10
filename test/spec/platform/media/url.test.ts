import { expect, it } from 'vitest';
import { mediaUrlOf } from '../../../../apps/api/src/modules/platform/media/index.ts';

it.each(['svg', 'png'] as const)(
  '[AC-F1-06z#1] %s URL 保留路径前缀、去掉全部结尾斜杠并使用内容摘要',
  (format) => {
    const sha256 = '0123456789abcdef'.repeat(4);
    for (const base of [
      'https://media.example.invalid',
      'https://media.example.invalid/media/v1',
    ]) {
      for (const suffix of ['', '/', '///']) {
        expect(mediaUrlOf(base + suffix, sha256, format)).toBe(`${base}/${sha256}.${format}`);
      }
    }
  },
);
