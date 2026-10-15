import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  maskForTrace,
  redactForModel,
  restorePlaceholders,
} from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';

// 合成长数字以 28 开头，长度 >=11，避开手机号和 18 位身份证以便单独验证占位规则。
const digits = fc.oneof(
  fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 9, maxLength: 15 }),
  fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 17, maxLength: 18 }),
);
const longNumber = digits.map((rest) => `28${rest.join('')}`);
const freeText = fc
  .array(fc.constantFrom('合成', '耳机', '比较', '蓝色', ' ', '🧪'), { maxLength: 12 })
  .map((parts) => parts.join(''));

it('[AC-B3-05a#33][BR-AI-14] 随机混排自由文本、多条链接与长数字，模型不留链接或原数字，参数可还原', () => {
  fc.assert(
    fc.property(
      freeText,
      fc.array(longNumber, { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 0, max: 7 }),
      (prefix, numbers, linkCount) => {
        const links = Array.from(
          { length: linkCount },
          (_, index) => `https://example.invalid/9000000000${index}?q=synthetic`,
        );
        const segments = numbers.map((raw, index) => `${links[index] ?? ''} ${prefix} ${raw}`);
        const input = `${segments.join(' 合成 ')} ${links.slice(numbers.length).join(' ')}`;
        const result = redactForModel(input);
        const unique = [...new Set(numbers)];
        const expectedTable = Object.fromEntries(
          unique.map((raw, index) => [`<num_${index + 1}>`, raw]),
        );
        expect(result.placeholders).toEqual(expectedTable);
        expect(result.text).not.toMatch(/\d{11,}|https?:\/\/|example\.invalid/);
        if (prefix.trim() !== '') expect(result.text).toContain(prefix);
        for (const raw of numbers) expect(result.text).not.toContain(raw);
        const tokens = numbers.map((raw) => `<num_${unique.indexOf(raw) + 1}>`);
        expect(result.text.match(/<num_\d+>/g)).toEqual(tokens);
        const args = { orders: tokens.map((token) => ({ order_no: token })), extra: [null, 7] };
        expect(restorePlaceholders(args, result.placeholders)).toEqual({
          orders: numbers.map((raw) => ({ order_no: raw })),
          extra: [null, 7],
        });
        expect(args.orders.map((order) => order.order_no)).toEqual(tokens);
        expect(redactForModel(result.text).text).toBe(result.text);
      },
    ),
    propParams(),
  );
});

it('[AC-B3-05a#34][BR-AI-14][BR-AI-19] 随机长数字在 trace 仅保留后四位，深层输入不被修改且脱敏幂等', () => {
  fc.assert(
    fc.property(fc.array(longNumber, { minLength: 1, maxLength: 8 }), (numbers) => {
      const input = { nested: numbers.map((raw) => ({ order_no: raw })) };
      const result = maskForTrace(input);
      expect(result).toEqual({
        nested: numbers.map((raw) => ({
          order_no: expect.stringMatching(new RegExp(`^[^0-9]+${raw.slice(-4)}$`)),
        })),
      });
      expect(JSON.stringify(result)).not.toMatch(/\d{11,}|<num_/);
      expect(input).toEqual({ nested: numbers.map((raw) => ({ order_no: raw })) });
      expect(maskForTrace(result)).toEqual(result);
    }),
    propParams(),
  );
});
