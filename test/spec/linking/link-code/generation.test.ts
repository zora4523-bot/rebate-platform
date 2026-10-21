import { randomInt } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { generateLinkCode } from '../../../../apps/api/src/modules/linking/infra/link-code.ts';
import { built } from './kit.ts';

vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomInt: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it('[AC-B1-08s#1] 六位逐位使用 crypto.randomInt(0,36)，保留前导零且不派生身份或时间', async () => {
  const draw = vi.mocked(randomInt as (min: number, max: number) => number);
  for (const n of [0, 9, 10, 25, 34, 35, 35, 34, 25, 10, 9, 0]) draw.mockReturnValueOnce(n);
  expect(await built(() => generateLinkCode())).toBe('09apyz');
  expect(await built(() => generateLinkCode())).toBe('zypa90');
  expect(draw.mock.calls).toEqual(Array.from({ length: 12 }, () => [0, 36]));
});

it('[AC-B1-08s#2] base36 全部字符可产生、固定六位，随机源故障不能降级为时间或主键', async () => {
  const draw = vi.mocked(randomInt as (min: number, max: number) => number);
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  for (let n = 0; n < 36; n += 1) {
    draw.mockReturnValue(n);
    expect(await built(() => generateLinkCode())).toBe(alphabet[n]!.repeat(6));
  }
  const fault = new Error('synthetic entropy failure');
  draw.mockImplementation(() => {
    throw fault;
  });
  expect(() => generateLinkCode()).toThrow(fault);
});
