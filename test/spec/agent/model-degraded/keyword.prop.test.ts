// 规划/08 BR-AI-14 细则「无模型降级」取词的属性测试：对任意脱敏后文本与任意已开启平台，
// 以及任意取词上限配置（不传时默认 30，传入时取生成的上限 1–64），计划与本文件里独立写的参照
// 取词一致（去首尾空白与 Unicode P 类标点 → 按码点取前「上限」个），
// 并满足：q 非空、不超过上限个码点、首部没有空白与标点、是输入的子串；platforms 照抄、sort=relevance。
// 属性体只返回布尔，断言在 fc.check 之外做（反例连同实际返回一起报出）。
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  planKeywordSearch,
  type KeywordSearchPlan,
  type RedactedText,
} from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';

const DEFAULT_MAX_CHARS = 30;
const EDGE = /^[\s\p{P}]+|[\s\p{P}]+$/gu;
const LEADING = /^[\s\p{P}]/u;

/** 参照取词：只按 08 原文写，不调用被测函数。 */
function referenceQ(text: string, limit: number | undefined): string | null {
  const max = limit ?? DEFAULT_MAX_CHARS;
  const trimmed = text.replace(EDGE, '');
  return trimmed === '' ? null : Array.from(trimmed).slice(0, max).join('');
}

/** limit 为 undefined 时不传配置参数（走默认值），否则传 { maxChars: limit }。 */
function call(
  text: string,
  platforms: readonly string[],
  limit: number | undefined,
): KeywordSearchPlan | null | string {
  try {
    return limit === undefined
      ? planKeywordSearch(text as RedactedText, platforms)
      : planKeywordSearch(text as RedactedText, platforms, { maxChars: limit });
  } catch (error) {
    return `threw: ${String(error)}`;
  }
}

function holds(text: string, platforms: readonly string[], limit: number | undefined): boolean {
  const got = call(text, platforms, limit);
  const want = referenceQ(text, limit);
  if (want === null) return got === null;
  if (got === null || typeof got === 'string') return false;
  return (
    got.q === want &&
    got.q !== '' &&
    Array.from(got.q).length <= (limit ?? DEFAULT_MAX_CHARS) &&
    !LEADING.test(got.q) &&
    text.includes(got.q) &&
    got.sort === 'relevance' &&
    Object.keys(got).sort().join(',') === 'platforms,q,sort' &&
    got.platforms !== platforms &&
    got.platforms.length === platforms.length &&
    got.platforms.every((p, i) => p === platforms[i])
  );
}

// 一半是任意码点串，一半是由空白、标点、汉字、字母、emoji 拼成的串（更常命中首尾与 30 的边界）。
const pieces = fc.constantFrom(
  ' ',
  '　',
  '\t',
  '\n',
  '，',
  '。',
  '!',
  '?',
  '【',
  '】',
  '…',
  '·',
  '—',
  '蓝',
  '牙',
  'a',
  '1',
  '🎧',
  '<num_1>',
);
const text = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 80 }),
  fc.array(pieces, { maxLength: 60 }).map((parts) => parts.join('')),
);
const platforms = fc.subarray(['taobao', 'jd', 'pdd', 'meituan', 'vip']);
// 取词上限：一半不传（默认 30），一半是 1–64 的配置值（覆盖小于、等于与大于 30）。
const limit = fc.option(fc.integer({ min: 1, max: 64 }), { nil: undefined, freq: 2 });

const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

it(
  '[BR-AI-14] 任意脱敏后文本与任意取词上限（默认 30 或配置值）：q 与参照取词一致，非空、不超过上限个码点、首部无空白与标点、是输入的子串；platforms 是照抄的副本，sort=relevance',
  () => {
    const details = fc.check(
      fc.property(text, platforms, limit, (t, p, l) => holds(t, p, l)),
      propParams(),
    );
    const counterexample =
      details.counterexample === null
        ? null
        : {
            input: details.counterexample[0],
            platforms: details.counterexample[1],
            limit: details.counterexample[2],
            got: call(
              details.counterexample[0],
              details.counterexample[1],
              details.counterexample[2],
            ),
            want: referenceQ(details.counterexample[0], details.counterexample[2]),
          };
    expect({ failed: details.failed, counterexample }).toStrictEqual({
      failed: false,
      counterexample: null,
    });
  },
  PROPERTY_TIMEOUT_MS,
);
