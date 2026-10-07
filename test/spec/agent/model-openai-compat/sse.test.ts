// SSE 解析（OpenAI 兼容流式；09 CAP-X-07「stream」）：切分位置无关、兼容 CRLF、忽略注释与空行、
// 遇到 data: [DONE] 结束。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { createSseChunkParser } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { canonicalJson } from '../../../../packages/evals/src/index.ts';
import { sseChunks, sseText } from './kit.ts';

function feed(text: string, cuts: readonly number[]): { chunks: unknown[]; finished: boolean } {
  const parser = createSseChunkParser();
  const points = [0, ...[...cuts].sort((a, b) => a - b), text.length];
  const chunks: unknown[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    chunks.push(...parser.push(text.slice(points[i], points[i + 1])));
  }
  chunks.push(...parser.end());
  return { chunks, finished: parser.finished };
}

it('[09 CAP-X-07 SSE#1] 整段喂入：得到 [DONE] 之前的全部分片，注释与空行忽略，之后的内容不再解析', () => {
  const result = feed(sseText(), []);
  expect(result.chunks).toEqual(sseChunks());
  expect(result.finished).toBe(true);
});

it('[09 CAP-X-07 SSE#2] 还没遇到 [DONE] 时 finished 为 false', () => {
  const parser = createSseChunkParser();
  const head = sseText().split('data: [DONE]')[0] ?? '';
  expect(parser.push(head)).toEqual(sseChunks());
  expect(parser.finished).toBe(false);
});

it('[09 CAP-X-07 SSE#3] 同一段文本在任意位置切开喂入，结果相同（属性测试，LF 与 CRLF）', () => {
  const expected = canonicalJson(sseChunks());
  const texts = [sseText(), sseText().replace(/\n/g, '\r\n')];
  for (const text of texts) {
    const cutsArb = fc.uniqueArray(fc.integer({ min: 1, max: text.length - 1 }), {
      maxLength: 12,
    });
    expect(() =>
      fc.assert(
        fc.property(cutsArb, (cuts) => {
          const result = feed(text, cuts);
          return result.finished && canonicalJson(result.chunks) === expected;
        }),
        propParams(),
      ),
    ).not.toThrow();
  }
}, 900_000);

it('[09 CAP-X-07 SSE#4] 逐字符喂入 CRLF 文本（\\r 与 \\n 落在不同次 push）结果仍相同', () => {
  const text = sseText().replace(/\n/g, '\r\n');
  const cuts = Array.from({ length: text.length - 1 }, (_, i) => i + 1);
  const result = feed(text, cuts);
  expect(result.chunks).toEqual(sseChunks());
  expect(result.finished).toBe(true);
});
