import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { agreementTextUrl } from '../../../../apps/api/src/modules/content/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

for (const type of ['privacy', 'agreement', 'labor_agreement'] as const) {
  it(`[AC-F1-02n#14] ${type} 地址参数顺序固定，基址有无尾斜杠结果相同`, () => {
    const expected = `https://h5.example.test/agreement?type=${type}&version=12`;
    expect(agreementTextUrl('https://h5.example.test/', type, 12)).toBe(expected);
    expect(agreementTextUrl('https://h5.example.test', type, 12)).toBe(expected);
  });
}

it('[AC-F1-02n#15] 保留基址路径且只去掉末尾一个斜杠', () => {
  expect(agreementTextUrl('https://h5.example.test/mobile/', 'privacy', 1)).toBe(
    'https://h5.example.test/mobile/agreement?type=privacy&version=1',
  );
  expect(agreementTextUrl('https://h5.example.test/mobile', 'privacy', 1)).toBe(
    'https://h5.example.test/mobile/agreement?type=privacy&version=1',
  );
  expect(agreementTextUrl('https://h5.example.test/mobile//', 'agreement', 2)).toBe(
    'https://h5.example.test/mobile//agreement?type=agreement&version=2',
  );
});

for (const base of [
  '',
  'http://h5.example.test',
  '/mobile',
  '//h5.example.test',
  'https://',
  'https://h5.example.test/?q=1',
  'https://h5.example.test/#legal',
  'https://h5.example.test/?',
  'https://h5.example.test/#',
]) {
  it(`[AC-F1-02n#16] 非 https 绝对地址或带 query/fragment 的基址返回 null：${base}`, () => {
    expect(agreementTextUrl(base, 'privacy', 1)).toBeNull();
  });
}

it('[AC-F1-02n#17] 生成地址的路径和参数符合 routes.json 的 Agreement', () => {
  const document = JSON.parse(
    readFileSync(new URL('../../../../contracts/routes.json', import.meta.url), 'utf8'),
  ) as {
    routes: Record<string, { h5_path: string; params: JsonSchema }>;
  };
  const route = document.routes['Agreement']!;
  const check = createValidatorCompiler()({ schema: route.params, httpPart: 'body' });
  for (const type of ['privacy', 'agreement', 'labor_agreement'] as const) {
    const result = agreementTextUrl('https://h5.example.test', type, 1);
    expect(result).not.toBeNull();
    const url = new URL(result!);
    expect(url.pathname).toBe(route.h5_path);
    expect([...url.searchParams.keys()]).toEqual(['type', 'version']);
    const params = {
      type: url.searchParams.get('type'),
      version: Number(url.searchParams.get('version')),
    };
    expect(check(params), JSON.stringify(check.errors)).toBe(true);
  }
});
