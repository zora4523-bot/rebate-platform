// Rule tests for the WireMock container, the entry point and the notes of QA-05a (规划/05 QA-05
// 「WireMock 容器（镜像按摘要锁定）……切换场景的命令行工具与说明」; AGENTS.md hard rule 9 exact
// versions; 09 README §0.2 hard rule 5 and 规划/02 §12.7: WireMock only, never a real upstream).
// The files are read as text; a missing file reads as '' so the assertions fail. Nothing is
// started. Top-level it() only.
import { expect, it } from 'vitest';
import { resolveAdminUrl } from '../../../infra/fault/fault.ts';
import { ALL_TARGETS, FAULTS, repoText } from './kit.ts';

const COMPOSE = 'infra/fault/compose.yaml';

it('[规划/05 QA-05 摘要锁定] compose 的每个镜像都写精确版本并按 sha256 摘要锁定，且确有 WireMock 镜像', () => {
  const text = repoText(COMPOSE);
  const images = [...text.matchAll(/^\s*image:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/gm)].map(
    (m) => m[1] ?? '',
  );
  const pinned = /^[a-z0-9./-]+:\d+\.\d+\.\d+[\w.-]*@sha256:([0-9a-f]{64})$/;
  expect(images.some((image) => image.startsWith('wiremock/wiremock:'))).toBe(true);
  for (const image of images) {
    const digest = pinned.exec(image)?.[1] ?? '';
    expect({ image, pinned: digest !== '', placeholder: /^(.)\1*$/.test(digest) }).toEqual({
      image,
      pinned: true,
      placeholder: false,
    });
  }
  expect(text).not.toMatch(/:latest\b/);
});

it('[规划/02 §12.7] compose 单独成项目：不叫 couli-local，端口只绑 127.0.0.1，不用宿主网络', () => {
  const text = repoText(COMPOSE);
  const project = /^name:\s*['"]?([\w-]+)/m.exec(text)?.[1] ?? '';
  expect({ project: project !== '', local: project === 'couli-local' }).toEqual({
    project: true,
    local: false,
  });
  const ports = [...text.matchAll(/^\s*-\s*['"]?([\d.:[\]]+:\d+(?:\/\w+)?)['"]?\s*$/gm)].map(
    (m) => m[1] ?? '',
  );
  expect(ports.length).toBeGreaterThan(0);
  expect(ports.filter((p) => !p.startsWith('127.0.0.1:'))).toEqual([]);
  expect(text).not.toMatch(/network_mode:\s*['"]?host/);
});

it('[09 README §0.2 硬规则 5] WireMock 不开代理与录制：不能借它把请求转到真实联盟或百炼', () => {
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
});

it('[规划/05 QA-05] 命令行默认管理地址完整等于 http://127.0.0.1:<compose 发布的 WireMock 端口>（普通 HTTP）', () => {
  const published = /['"]?127\.0\.0\.1:(\d+):8080['"]?/.exec(repoText(COMPOSE))?.[1];
  expect(published ?? '', 'compose publishes 127.0.0.1:<port>:8080').toMatch(/^\d+$/);
  expect(resolveAdminUrl({}).replace(/\/$/, '')).toBe(`http://127.0.0.1:${published ?? ''}`);
});

it('[规划/05 QA-05 命令行] 入口 infra/fault/cli.ts 只把参数交给 fault.ts 的 runCli', () => {
  const text = repoText('infra/fault/cli.ts');
  expect(text).toMatch(/from '\.\/fault\.ts'/);
  expect(text).toMatch(/\brunCli\(/);
});

it('[规划/05 QA-05 说明] README 写明启动、命令、环境变量、X-Scenario 头、全部目标与场景', () => {
  const text = repoText('infra/fault/README.md');
  const missing = [
    'docker compose -f infra/fault/compose.yaml',
    'node infra/fault/cli.ts',
    'FAULT_WIREMOCK_URL',
    'X-Scenario',
    ...ALL_TARGETS,
    'normal',
    ...FAULTS,
  ].filter((term) => !text.includes(term));
  expect(missing).toEqual([]);
});

it('[规划/05 QA-05] 本地栈 infra/local 不加 WireMock：故障注入容器只在 infra/fault', () => {
  expect(repoText(COMPOSE)).toMatch(/wiremock\/wiremock:/);
  expect(repoText('infra/local/compose.yaml')).not.toMatch(/image:\s*['"]?wiremock\//);
});
