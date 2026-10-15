import { expect, it } from 'vitest';
import { asset, noInlineCredentials } from '../staging/kit.ts';

/** Scope checks to the new preparation section, not unrelated keyring/JWT instructions. */
function preparation(): string {
  const readme = asset('infra/staging/README.md');
  const heading = /^(#{1,6})\s+[^\n]*拼多多[^\n]*准备[^\n]*$/m.exec(readme);
  expect(heading, 'README needs a Pinduoduo preparation section').not.toBeNull();
  const depth = heading![1]!.length;
  const remaining = readme.slice(heading!.index + heading![0].length);
  const next = new RegExp(`^#{1,${String(depth)}}\\s+`, 'm').exec(remaining);
  return heading![0] + remaining.slice(0, next?.index ?? remaining.length);
}

it('[AC-B1-04y-README#1] 明示准备而不切 live，三个端点保持 demo，IP 白名单只加不删', () => {
  const section = preparation();
  expect(section).toContain('不切 live');
  expect(section).toContain('pdd 切 live 暂不可用 — blocked on 真实返利报价器（B2-03）');
  expect(section).toMatch(/IP\s*白名单[^\n]*(?:只加不删|只增不删|只新增[^\n]*不删)/);
  for (const platform of ['jd', 'pdd', 'taobao']) {
    expect(section).toMatch(new RegExp(`\\b${platform}(?:\\.json|\\b)`));
  }
  expect(section).toContain('demo');
  expect(section).toMatch(/(?:三个|三平台|全部|都)[^\n]*demo|demo[^\n]*(?:三个|三平台|全部|都)/);
  expect(section).toMatch(/pdd(?:\.json)?[^\n]*(?:demo|不例外|也一样)|demo[^\n]*pdd(?:\.json)?/);
  for (const block of section.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    expect(block[1]).not.toMatch(/["']?mode["']?\s*[:=]\s*["']?live\b|s[|/]demo[|/]live/);
  }
});

it('[AC-B1-04y-README#2] 节点文件由负责人准备，说明属主及目录/文件权限，不把内容放进命令行或环境变量', () => {
  const section = preparation();
  expect(section).toContain('/etc/couli-pdd/client_secret');
  expect(section).toContain('/etc/couli-pdd/union-endpoints');
  expect(section).toContain('负责人');
  expect(section).toMatch(/1000/);
  expect(section).toMatch(/(?:目录[^\n]*500|500[^\n]*目录|chmod\s+0?500)/);
  expect(section).toMatch(/(?:文件[^\n]*400|400[^\n]*文件|chmod\s+0?400)/);
  expect(section).toMatch(
    /(?:子目录|union-endpoints)[\s\S]*(?:1000|500)|(?:1000|500)[\s\S]*union-endpoints/,
  );
  expect(section).toMatch(/(?:不|禁止|不得)[^\n]*命令行/);
  expect(section).toMatch(/(?:不|禁止|不得)[^\n]*环境变量/);
  noInlineCredentials(asset('infra/staging/README.md'));
  expect(section).not.toMatch(/\bclient_secret\s*[:=]\s*\S/i);
});

it('[AC-B1-04y-README#3] 先备齐文件再配置共享 staging.env，给出四项变量及容器内路径', () => {
  const section = preparation();
  expect(section).toMatch(/先[^。\n]*文件[^。\n]*再[^。\n]*staging\.env/);
  for (const name of [
    'PDD_CLIENT_ID',
    'PDD_CLIENT_SECRET_FILE',
    'PDD_QUERY_CUSTOM_PARAMETERS',
    'UNION_ENDPOINT_OVERRIDE_DIR',
  ]) {
    expect(section).toContain(name);
  }
  // Accept either env-file examples or a variable/value table; no secret value is required.
  expect(section).toMatch(/PDD_CLIENT_SECRET_FILE[^\n]*\/run\/couli-pdd\/client_secret/);
  expect(section).toMatch(/UNION_ENDPOINT_OVERRIDE_DIR[^\n]*\/run\/couli-pdd\/union-endpoints/);
});
