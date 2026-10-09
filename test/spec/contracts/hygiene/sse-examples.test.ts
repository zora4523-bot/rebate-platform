import { expect, it } from 'vitest';
import { at, openapi, read, resolve, streamPath, text } from './kit.ts';

it.each(['accepted', 'duplicateEnded', 'duplicateInProgress'])(
  '[AC-CT-01e#2] SSE 示例 %s 经 parseYamlLite 原样读取后保留最后一帧的空行',
  (name) => {
    const doc = openapi();
    const response = resolve(doc, at(doc, 'paths', streamPath, 'post', 'responses', '200'));
    const examples = at(response, 'content', 'text/event-stream', 'examples');
    const value = text(at(examples, name)['value']);
    expect(value, '不得 trim 或替示例补换行再检查').toMatch(/\n\n$/u);
    // 所有新增例子也必须满足；三个既有场景不能通过删例子来规避检查。
    for (const [exampleName, example] of Object.entries(examples)) {
      expect(text(resolve(doc, example)['value']), exampleName).toMatch(/\n\n$/u);
    }
  },
  30_000,
);

it('[AC-CT-01e#3] README 规则 16 保留 SSE 与必填缓存头约定，并说明双引号字符串写法', () => {
  const match = /(?:^|\n)16\. [\s\S]*?(?=\n\d+\. |\n## |$)/u.exec(read('contracts/README.md'));
  expect(match, 'README 必须保留规则 16').not.toBeNull();
  const rule = match![0];
  expect(rule).toContain('200 只声明 `text/event-stream`');
  expect(rule).toContain('必填 `Cache-Control: no-cache`');
  expect(rule).not.toContain('用 `|` 字面块');
  expect(rule).toContain('双引号');
});
