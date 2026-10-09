import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  at,
  openapi,
  parseYamlLite,
  resolve,
  root,
  streamOperation,
  streamPath,
  testRequire,
  yaml,
  type Obj,
} from './kit.ts';

const { checkConformance } = testRequire(
  '../../../../packages/contracts-ts/scripts/conformance.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/conformance.ts');
const { loadEnums, loadErrorCodes } = testRequire(
  '../../../../packages/contracts-ts/scripts/catalog.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/catalog.ts');

// 只留下本用例的 operation；跨文件枚举等检查需要的 components 沿用真实契约。
// 每个用例先验证真实契约与未变异夹具，防止无关问题或全拒绝校验器造成假阳性。
function mutationProblems(
  method: string,
  path: string,
  prepare: (doc: Obj) => void,
  mutate: (doc: Obj) => void,
): string[] {
  const enums = loadEnums();
  const { codes } = loadErrorCodes();
  expect(checkConformance(enums, codes), '真实 openapi.yaml 必须继续通过').toEqual([]);
  const doc = openapi();
  const operation = at(doc, 'paths', path, method);
  doc['paths'] = { [path]: { [method]: operation } };
  prepare(doc);
  const parent = fileURLToPath(new URL('.tmp/ct-01e-hygiene/', root));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'contract-'));
  const file = join(directory, 'openapi.yaml');
  const write = (): string => {
    const source = yaml(doc);
    expect(parseYamlLite(source), '夹具序列化不得改变文档或破坏引用').toEqual(doc);
    writeFileSync(file, source);
    return source;
  };
  try {
    const original = write();
    expect(checkConformance(enums, codes, file), '合法夹具必须通过').toEqual([]);
    mutate(doc);
    expect(write()).not.toBe(original);
    return checkConformance(enums, codes, file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each([
  ['get', '/healthz', '200'],
  ['post', '/v1/devices', '4XX'],
  ['post', '/admin/v1/auth/login', '5XX'],
])(
  '[AC-CT-01e#4] 未登记的 %s %s 的 %s 经共享响应引用声明 SSE 时必须报错',
  (method, path, status) => {
    const problems = mutationProblems(
      method,
      path,
      (doc) => {
        const responses = at(doc, 'paths', path, method, 'responses');
        // 正向夹具也是共享响应，只有 content 的 SSE 变异造成拒绝。
        at(doc, 'components', 'responses')['HygieneResponse'] = structuredClone(
          resolve(doc, responses[status]),
        );
        responses[status] = { $ref: '#/components/responses/HygieneResponse' };
      },
      (doc) => {
        const content = at(doc, 'components', 'responses', 'HygieneResponse', 'content');
        content['text/event-stream'] = {
          schema: { type: 'string' },
          example: 'event: done\nid: 1\ndata: {}\n\n',
        };
      },
    );
    expect(
      problems.some(
        (problem) =>
          problem.includes(`${method.toUpperCase()} ${path}`) && /stream|SSE/iu.test(problem),
      ),
      JSON.stringify(problems),
    ).toBe(true);
  },
  30_000,
);

it('[AC-CT-01e#5] 流式接口 200 同时声明 JSON 时，conformance 必须指出该接口的媒体类型问题', () => {
  const problems = mutationProblems(
    'post',
    streamPath,
    () => {},
    (doc) => {
      at(doc, 'paths', streamPath, 'post', 'responses', '200', 'content')['application/json'] = {
        schema: { type: 'object' },
        example: { code: 0, msg: '', data: {}, trace_id: 'ct-01e' },
      };
    },
  );
  expect(
    problems.some(
      (problem) =>
        problem.includes(streamOperation) &&
        /stream|SSE|application\/json|content|媒体/iu.test(problem),
    ),
    JSON.stringify(problems),
  ).toBe(true);
}, 30_000);

it.each(['missing', 'optional', 'unspecified'])(
  '[AC-CT-01e#6] 流式接口 200 的 Cache-Control 为 %s 时必须报错',
  (mode) => {
    const problems = mutationProblems(
      'post',
      streamPath,
      () => {},
      (doc) => {
        const headers = at(doc, 'paths', streamPath, 'post', 'responses', '200', 'headers');
        if (mode === 'missing') {
          delete headers['Cache-Control'];
        } else {
          // 保留 Header $ref，确保 required 的检查读到了共享头定义。
          const header = resolve(doc, headers['Cache-Control']);
          if (mode === 'optional') header['required'] = false;
          else delete header['required'];
        }
      },
    );
    expect(
      problems.some(
        (problem) => problem.includes(streamOperation) && /Cache-Control/iu.test(problem),
      ),
      JSON.stringify(problems),
    ).toBe(true);
  },
  30_000,
);
