// Rule tests for the QA-06b WireMock container and its safety boundary (规划/05 QA-06「上游用
// WireMock」; 09 README §0.2 hard rule 5: load never reaches a real union or model endpoint;
// 规划/02 §12.7; AGENTS.md hard rule 9 exact versions). Files are read as text; a missing file
// reads as '' so the assertions fail. Nothing is started. Top-level it() only.
import { expect, it } from 'vitest';
import { buildLoadImport } from '../../../../infra/load/wiremock/stubs.ts';
import { fixtureRecordings, repoFiles, repoText } from './kit.ts';

const COMPOSE = 'infra/load/wiremock/compose.yaml';

function images(text: string): string[] {
  return [...text.matchAll(/^\s*image:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/gm)].map(
    (m) => m[1] ?? '',
  );
}

it('[规划/05 QA-06 摘要锁定] 压测 WireMock 镜像写精确版本并按 sha256 摘要锁定，与 QA-05a 已核实的镜像完全相同', () => {
  const verified = images(repoText('infra/fault/compose.yaml')).find((i) =>
    i.startsWith('wiremock/wiremock:'),
  );
  const ours = images(repoText(COMPOSE));
  expect(verified ?? '').toMatch(/^wiremock\/wiremock:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  expect(ours).toEqual([verified]);
  expect(repoText(COMPOSE)).not.toMatch(/:latest\b|\$\{/);
});

it('[规划/02 §12.7] compose 单独成项目（不叫 couli-local / couli-fault），端口只绑 127.0.0.1 且不占 QA-05a 的端口，不用宿主网络', () => {
  const text = repoText(COMPOSE);
  const project = /^name:\s*['"]?([\w-]+)/m.exec(text)?.[1] ?? '';
  expect({
    named: project !== '',
    taken: ['couli-local', 'couli-fault'].includes(project),
  }).toEqual({
    named: true,
    taken: false,
  });
  const ports = [...text.matchAll(/^\s*-\s*['"]?([\d.:[\]]+:\d+(?:\/\w+)?)['"]?\s*$/gm)].map(
    (m) => m[1] ?? '',
  );
  expect(ports.length).toBeGreaterThan(0);
  expect(ports.filter((p) => !p.startsWith('127.0.0.1:'))).toEqual([]);
  expect(ports.filter((p) => p.startsWith('127.0.0.1:18089:'))).toEqual([]);
  expect(text).not.toMatch(/network_mode:\s*['"]?host/);
});

it('[09 README §0.2 硬规则 5] WireMock 不开代理与录制，桩里没有 proxyBaseUrl：不能借它把压测打到真实联盟或百炼', () => {
  const text = repoText(COMPOSE);
  expect(text).toMatch(/wiremock\/wiremock:/);
  for (const flag of [
    '--proxy-all',
    '--record-mappings',
    '--enable-browser-proxying',
    '--proxy-via',
  ]) {
    expect(text, flag).not.toContain(flag);
  }
  const body = JSON.stringify(
    buildLoadImport(fixtureRecordings(), { faultPercent: 10, delayMs: 5 }),
  );
  expect(body).not.toContain('proxyBaseUrl');
});

it('[09 README §0.2 硬规则 5] infra/load/wiremock 下的文件与生成的桩里没有真实平台或模型域名、外部 URL 与密钥样式的值', () => {
  const files = repoFiles('infra/load/wiremock');
  expect(files.length).toBeGreaterThan(1);
  const texts = [
    ...files.map((f) => ({ where: f, text: repoText(f) })),
    {
      where: 'buildLoadImport',
      text: JSON.stringify(buildLoadImport(fixtureRecordings(), { faultPercent: 50 })),
    },
  ];
  const realHosts =
    /(?:aliyuncs\.com|dashscope|bigmodel\.cn|taobao\.com|tmall\.com|alimama\.com|jd\.com|jd\.hk|pinduoduo\.com|yangkeduo\.com|meituan\.com)/i;
  const allowedHost = /^(?:127\.0\.0\.1|localhost|\[::1\]|wiremock)(?::\d+)?$/;
  const secretLike = new RegExp(
    ['sk-[A-Za-z0-9]{16,}', 'Bearer\\s+[A-Za-z0-9._-]{12,}', 'AKIA[0-9A-Z]{16}'].join('|'),
  );
  const problems = texts.flatMap(({ where, text }) => [
    ...(realHosts.test(text) ? [`${where}: real host`] : []),
    ...[...text.matchAll(/\bhttps?:\/\/([^/\s'"`)]+)/g)]
      .map((m) => m[1] ?? '')
      .filter((host) => !allowedHost.test(host))
      .map((host) => `${where}: external URL host ${host}`),
    ...(secretLike.test(text) ? [`${where}: secret-like value`] : []),
  ]);
  expect(problems).toEqual([]);
});

it('[规划/05 QA-06 说明] README 写明启动命令、录制目录、X-Scenario、可配置项、导入入口与只打本地的边界', () => {
  const text = repoText('infra/load/wiremock/README.md');
  const missing = [
    'docker compose -f infra/load/wiremock/compose.yaml',
    'fixtures/union-recordings',
    'X-Scenario',
    'delayMs',
    'faultPercent',
    'faultKind',
    '/__admin/mappings/import',
    '[DONE]',
    '09 README §0.2',
  ].filter((term) => !text.includes(term));
  expect(missing).toEqual([]);
});
