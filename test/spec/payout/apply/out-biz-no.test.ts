import { expect, it } from 'vitest';
import { generateOutBizNo } from '../../../../apps/api/src/modules/payout/domain/out-biz-no.ts';

it('[AC-B2-05d#40] 商户单号固定 W 加 20 位大写 ASCII 字母数字，随机源可注入', () => {
  const requested: number[] = [];
  const first = generateOutBizNo((size) => {
    requested.push(size);
    return new Uint8Array(size).fill(1);
  });
  const second = generateOutBizNo((size) => new Uint8Array(size).fill(2));
  expect(first).toMatch(/^W[A-Z0-9]{20}$/);
  expect(second).toMatch(/^W[A-Z0-9]{20}$/);
  expect(first).not.toBe(second);
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.every((size) => Number.isInteger(size) && size > 0)).toBe(true);
});

it('[AC-B2-05d#41] 不依赖全局时钟或调用次数，同一随机字节流产生同一商户单号', () => {
  const source = (size: number) => Uint8Array.from({ length: size }, (_, i) => i % 36);
  const first = generateOutBizNo(source);
  expect(generateOutBizNo(source)).toBe(first);
  expect(first).toMatch(/^W[A-Z0-9]{20}$/);
});
