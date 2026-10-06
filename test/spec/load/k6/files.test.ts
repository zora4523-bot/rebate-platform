// Rule tests for the committed k6 files of QA-06a (规划/05 QA-06; 02 §15.1 / 01 §7.1 / 01 §7.3 are
// pointers for peaks and P95 targets). QA-06a covers search, convert and Agent SSE; the sync scenario
// (admin manual order sync, not in contracts/ yet) is QA-06c, so nothing here asserts on it. Static only: config.json, script.ts, compose.yaml and
// README.md are read as text (a missing file reads as '' and the assertions fail); nothing is
// run, no k6 and no container (09 README §0.2 hard rule 5: never a real union API). k6 comes only
// from a digest-pinned container image, never from npm (AGENTS.md hard rule 9). The fault tool and
// WireMock stubs are QA-05a's (infra/fault), reused, not copied. Top-level it() only.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { configProblems, type LoadConfig } from '../../../../infra/load/k6/options.ts';

const DIR = 'infra/load/k6';

function repoText(path: string): string {
  const file = fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

interface ConfigView {
  multiplier?: unknown;
  base_urls?: Record<string, unknown>;
  scenarios?: Record<string, Record<string, unknown>>;
}

/** config.json parsed, or {} when missing or not JSON (the assertions then fail). */
function configJson(): ConfigView {
  try {
    const parsed: unknown = JSON.parse(repoText(`${DIR}/config.json`));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]', 'wiremock'];

/** Every http(s) URL literal in a text whose host is not loopback / the WireMock service. */
function foreignUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s'"`)<>]+/g)]
    .map((m) => m[0])
    .filter((raw) => {
      try {
        return !ALLOWED_HOSTS.includes(new URL(raw).hostname);
      } catch {
        return true;
      }
    });
}

it('[规划/05 QA-06] 同目录 config.json 有搜索、转链、Agent SSE 三个场景，系数为 3，并通过 configProblems', () => {
  const config = configJson();
  expect(Object.keys(config.scenarios ?? {})).toEqual(
    expect.arrayContaining(['agent_sse', 'convert', 'search']),
  );
  expect(config.multiplier).toBe(3);
  expect(configProblems(config as LoadConfig)).toEqual([]);
});

it('[01 §7.1 指针] 配置的 P95 不比 01 §7.1 目标宽：搜索 ≤1500ms、转链 ≤1500ms、SSE 首事件 ≤1000ms（按首字节计）；每个场景都有错误率', () => {
  const scenarios = configJson().scenarios ?? {};
  const caps: [string, number, string][] = [
    ['search', 1500, 'http_req_duration'],
    ['convert', 1500, 'http_req_duration'],
    ['agent_sse', 1000, 'http_req_waiting'],
  ];
  for (const [name, cap, metric] of caps) {
    const p95 = scenarios[name]?.['p95_ms'];
    expect(typeof p95 === 'number' && p95 > 0 && p95 <= cap, `${name} p95_ms ${String(p95)}`).toBe(
      true,
    );
    expect(scenarios[name]?.['latency_metric'], name).toBe(metric);
  }
  for (const name of ['search', 'convert', 'agent_sse']) {
    expect(typeof scenarios[name]?.['p95_ms'], `${name} p95_ms`).toBe('number');
    expect(typeof scenarios[name]?.['error_rate'], `${name} error_rate`).toBe('number');
  }
});

it('[规划/05 QA-06 场景] 搜索打 /v1/products/search，转链打 convert 或 open，Agent SSE 打 stream 的发消息接口且按并发流加压', () => {
  const s = configJson().scenarios ?? {};
  expect(String(s['search']?.['path'] ?? '')).toMatch(/^\/v1\/products\/search(\?|$)/);
  expect(s['search']?.['executor']).toBe('ramping-arrival-rate');
  expect(String(s['convert']?.['path'] ?? '')).toMatch(
    /^\/v1\/links\/(convert|[^/?]+\/open)(\?|$)/,
  );
  expect(s['convert']?.['executor']).toBe('ramping-arrival-rate');
  expect(s['agent_sse']?.['service']).toBe('stream');
  expect(String(s['agent_sse']?.['path'] ?? '')).toMatch(
    /^\/v1\/agent\/sessions\/[^/]+\/messages$/,
  );
  expect(s['agent_sse']?.['executor']).toBe('ramping-vus');
});

it('[09 README §0.2 硬规则 5] config.json 与 script.ts 里出现的 URL 只指向回环或 WireMock', () => {
  const config = repoText(`${DIR}/config.json`);
  const script = repoText(`${DIR}/script.ts`);
  expect(config.length * script.length).toBeGreaterThan(0);
  expect(foreignUrls(config)).toEqual([]);
  expect(foreignUrls(script)).toEqual([]);
});

it('[规划/05 QA-06] 入口 script.ts 读同目录 config.json、从 options.ts 取 options 与 base URL，并导出三个场景函数；options.ts 不用 Node 内置模块', () => {
  const script = repoText(`${DIR}/script.ts`);
  expect(script).toMatch(/open\(\s*['"]\.\/config\.json['"]\s*\)/);
  expect(script).toMatch(/from\s+['"]\.\/options\.ts['"]/);
  expect(script).toMatch(/\bbuildOptions\(/);
  expect(script).toMatch(/\bresolveBaseUrls\(/);
  expect(script).toMatch(/export\s+(const|let)\s+options\b/);
  for (const name of ['search', 'convert', 'agent_sse']) {
    expect(script, name).toMatch(
      new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`),
    );
  }
  expect(repoText(`${DIR}/options.ts`)).not.toMatch(/from\s+['"]node:|require\(/);
});

/** Source text without block and line comments (a URL's `//` inside a string literal is kept). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Body (between the outer braces) of `export function name` / `export const name = ... =>`; '' if absent. */
function exportedBody(script: string, name: string): string {
  return functionBody(script, `export\\s+`, name);
}

/** Body of `<prefix>function name` / `<prefix>const name = ... =>` in a script; '' if absent. */
function functionBody(script: string, prefix: string, name: string): string {
  const head = new RegExp(
    `${prefix}(?:async\\s+)?function\\s+${name}\\b[^{]*\\{|${prefix}const\\s+${name}\\b[^=]*=[^{]*=>\\s*\\{`,
  ).exec(script);
  if (head === null) return '';
  let depth = 1;
  const start = head.index + head[0].length;
  for (let i = start; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    else if (script[i] === '}') depth -= 1;
    if (depth === 0) return script.slice(start, i);
  }
  return '';
}

it('[规划/05 QA-06 场景产生负载] script.ts 三个场景函数体都不为空，并以本场景的配置调用 k6/http，或调用本脚本里直接调用 k6/http 的函数', () => {
  const script = stripComments(repoText(`${DIR}/script.ts`));
  expect(script).toMatch(/from\s+['"]k6\/http['"]/);
  expect(script).toMatch(/\bhttp\.(request|get|post|asyncRequest)\(/);
  for (const name of ['search', 'convert', 'agent_sse']) {
    const body = exportedBody(script, name).trim();
    expect(body.length, `${name} body`).toBeGreaterThan(0);
    // The body passes its own scenario to a request call: run('search'), http.post(url(config.scenarios.search)), …
    const ownScenario = new RegExp(
      `[\\w.$]+\\([^;]*(['"\`]${name}['"\`]|scenarios\\.${name}\\b|scenarios\\[['"]${name}['"]\\])`,
    );
    expect(body, `${name} body`).toMatch(ownScenario);
    // The callee is k6/http itself, or a function of this script whose body calls k6/http.
    const callee = (ownScenario.exec(body)?.[0] ?? '').replace(/\($/, '').split('(')[0] ?? '';
    const sends = /\bhttp\.(request|get|post|asyncRequest)\(/;
    const calleeBody = callee.startsWith('http.') ? `${callee}(` : functionBody(script, '', callee);
    expect(calleeBody, `${name} calls ${callee}`).toMatch(sends);
    for (const other of ['search', 'convert', 'agent_sse'].filter((n) => n !== name)) {
      expect(body, `${name} body uses ${other}`).not.toMatch(
        new RegExp(`['"\`]${other}['"\`]|scenarios\\.${other}\\b|scenarios\\[['"]${other}['"]\\]`),
      );
    }
  }
});

it('[规划/05 QA-06; AGENTS.md 硬规则 9] k6 只用 grafana/k6 1.x 精确版本并按 sha256 摘要锁定的镜像，不进 npm 依赖', () => {
  const compose = repoText(`${DIR}/compose.yaml`);
  const images = [...compose.matchAll(/^\s*image:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/gm)].map(
    (m) => m[1] ?? '',
  );
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    const digest = /^grafana\/k6:1\.\d+\.\d+@sha256:([0-9a-f]{64})$/.exec(image)?.[1] ?? '';
    expect({ image, pinned: digest !== '', placeholder: /^(.)\1*$/.test(digest) }).toEqual({
      image,
      pinned: true,
      placeholder: false,
    });
  }
  expect(compose).not.toMatch(/:latest\b/);
  expect(compose).toMatch(/script\.ts/);
  for (const manifest of ['package.json', 'test/package.json']) {
    expect(repoText(manifest), manifest).not.toMatch(/"(@types\/)?x?k6[\w-]*"\s*:/);
  }
  expect(repoText('pnpm-lock.yaml')).not.toMatch(/^\s+['"]?(@types\/)?x?k6[\w-]*@/m);
  expect(
    existsSync(fileURLToPath(new URL(`../../../../${DIR}/package.json`, import.meta.url))),
  ).toBe(false);
});

it('[规划/05 QA-06 复用 QA-05a] k6 目录不另起 WireMock、不写故障桩：上游与故障只用 infra/fault', () => {
  const dir = fileURLToPath(new URL(`../../../../${DIR}/`, import.meta.url));
  const files = existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' }) : [];
  expect(files).toContain('script.ts');
  const texts = files
    .filter((file) => /\.(ts|js|json|ya?ml)$/.test(file))
    .map((file) => repoText(`${DIR}/${file}`))
    .join('\n');
  expect(texts).not.toMatch(/wiremock\/wiremock:|__admin\b/);
});

it('[规划/05 QA-06 说明] README 写明运行命令、配置文件、三个场景、环境变量、复用 infra/fault 与不压真实联盟接口', () => {
  const text = repoText(`${DIR}/README.md`);
  const missing = [
    'docker compose -f infra/load/k6/compose.yaml',
    'config.json',
    'search',
    'convert',
    'agent_sse',
    'LOAD_API_BASE_URL',
    'LOAD_STREAM_BASE_URL',
    'infra/fault',
    '09 README §0.2',
  ].filter((term) => !text.includes(term));
  expect(missing).toEqual([]);
});
