import { expect, it } from 'vitest';
import { asset, noInlineCredentials } from '../staging/kit.ts';

/** Scope checks to the Jingdong section; a shell comment inside a code fence is not a heading. */
function section(): string {
  let fenced = false;
  let depth = 0;
  const kept: string[] = [];
  for (const line of asset('infra/staging/README.md').split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      if (depth > 0 && level <= depth) break;
      if (depth === 0 && heading[2]?.includes('京东')) depth = level;
    }
    if (depth > 0) kept.push(line);
  }
  expect(depth, 'README needs a Jingdong section').toBeGreaterThan(0);
  return kept.join('\n');
}

it('[AC-B1-04zf#3] 京东小节写明节点目录与权限：属主 1000、目录 500，app_secret 文件 400 且只放这一个值', () => {
  const text = section();
  expect(text).toContain('/etc/couli-jd/app_secret');
  expect(text).toMatch(
    /\/etc\/couli-jd(?!\/app_secret)[^\n]*\b1000\b|chown[^\n]*\b1000\b[^\n]*\/etc\/couli-jd/,
  );
  expect(text).toMatch(/目录[^\n，；|]*\b500\b|chmod\s+0?500\s+\/etc\/couli-jd(?!\/app_secret)/);
  expect(text).toMatch(
    /(?:文件|app_secret)[^\n，；|]*\b400\b|chmod\s+0?400\s+\/etc\/couli-jd\/app_secret/,
  );
  expect(text).toContain('只放这一个值');
});

it('[AC-B1-04zf#4] 京东小节给出 staging.env 三项，密钥文件变量只写容器内路径', () => {
  const text = section();
  expect(text).toContain('staging.env');
  for (const name of ['JD_APP_KEY', 'JD_APP_SECRET_FILE', 'JD_SITE_ID']) {
    expect(text).toContain(name);
  }
  expect(text).toMatch(/JD_APP_SECRET_FILE[^\n]*\/run\/couli-jd\/app_secret/);
  expect(text).not.toMatch(/JD_APP_SECRET_FILE[^\n]*\/etc\/couli-jd/);
});

it('[AC-B1-04zf#5] 京东小节不含任何凭据或站点 id 的值', () => {
  const text = section();
  // Placeholders such as JD_SITE_ID=<值> and a bare `JD_APP_KEY=` are names, not values.
  expect(text).not.toMatch(/\b(?:JD_APP_KEY|JD_SITE_ID)`?[ \t]*=[ \t]*[^\s<`]/);
  expect(text).not.toMatch(/\b[0-9a-f]{16,}\b/i);
  expect(text).not.toMatch(/\b\d{5,}\b/);
  noInlineCredentials(asset('infra/staging/README.md'));
});

it('[AC-B1-04zf#6] 切 live 走 UNION_ENDPOINT_OVERRIDE_DIR 下的 jd.json，本单不切，打包的 jd.json 仍是 demo', () => {
  const text = section();
  expect(text).toContain('不切');
  expect(text).toMatch(
    /UNION_ENDPOINT_OVERRIDE_DIR[^\n]*jd\.json|jd\.json[^\n]*UNION_ENDPOINT_OVERRIDE_DIR/,
  );
  for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    expect(block[1]).not.toMatch(/["']?mode["']?\s*[:=]\s*["']?live\b|s[|/]demo[|/]live/);
  }
  const packaged: unknown = JSON.parse(asset('config/union-endpoints/jd.json'));
  expect(packaged).toEqual({
    platform: 'jd',
    mode: 'demo',
    baseUrl: null,
    quotaKey: 'account:jd',
  });
});

it('[AC-B1-04zf#7] 部署检查 CHK-JD-STAGING-CRED：live 而两变量都没设时不报错、jd 保持未实现，切 live 前人工核对三项', () => {
  const text = section();
  const start = text.indexOf('CHK-JD-STAGING-CRED');
  expect(start, 'the section must name the deployment check').toBeGreaterThanOrEqual(0);
  const check = text.slice(start);
  expect(check).toMatch(/live[^。\n]*(?:两个|两项|都)[^。\n]*(?:没设|未设|没有设)/);
  expect(check).toContain('不报错');
  expect(check).toMatch(/jd[^。\n]*未实现/);
  expect(check).toMatch(/切\s*live\s*前[^。\n]*人工[^。\n]*核对/);
  expect(check).toMatch(
    /核对[^。\n]*(?:三项|三个变量|JD_APP_KEY[^。\n]*JD_APP_SECRET_FILE[^。\n]*JD_SITE_ID)/,
  );
});
