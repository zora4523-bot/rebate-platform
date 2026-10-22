// BR-AI-21 / B3-01h §9：仅合成素材与进程内替身；临时文件由容器内测试创建。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { computeManifest } from '../../../packages/evals/src/index.ts';
import type { AgentPorts, EvalCase, Recording, Report } from '../../../packages/evals/src/index.ts';
import type { CliDeps } from '../../../packages/evals/src/cli.ts';
import { meta, output, sample } from '../evals-replay/fixtures.ts';

export { call, digest, jsonl, meta, output, request, sample } from '../evals-replay/fixtures.ts';

export const AT = '2026-10-22T03:04:05.000Z';
export const clock = { now: () => new Date(AT) };
export const MODEL_TEXT = '合成模型响应-SYNTHETIC-OUTPUT';

export function runMeta(cases: EvalCase[]) {
  return {
    ...meta(computeManifest('smoke', 'synthetic-v1', cases)),
    mode: 'integration' as const,
    recordings_sha256: null,
    started_at: AT,
    finished_at: AT,
  };
}

export function livePorts(): AgentPorts {
  return {
    model: async () => ({ text: MODEL_TEXT }),
    tool: async () => ({ title: '合成商品', url: 'https://example.invalid/synthetic' }),
  };
}

export function deps(patch: CliDeps = {}): CliDeps {
  return {
    agent: () => async () => output(),
    livePorts,
    clock,
    meta: {
      vendor: 'synthetic-vendor',
      model_snapshot: 'synthetic-snapshot',
      prompt_sha256: 'b'.repeat(64),
      sampling: { temperature: 0 },
      tool_schema_version: 'synthetic-tools@1',
      code_commit: 'c'.repeat(40),
      grader_version: '1',
    },
    ...patch,
  };
}

type Validate = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvLike {
  compile(schema: object): Validate;
}

// 同 stream-writer kit，从已安装的 api 依赖加载 Ajv；不添加依赖，不联网取 schema。
export function recordingValidator(): Validate {
  const root = new URL('../../../', import.meta.url);
  const apiRequire = createRequire(new URL('apps/api/package.json', root));
  const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
    Ajv2020: new (opts: { strict: true; allErrors: true }) => AjvLike;
  };
  const addFormats = apiRequire('ajv-formats') as (ajv: AjvLike) => void;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(
    JSON.parse(
      readFileSync(new URL('packages/evals/schema/recording.schema.json', root), 'utf8'),
    ) as object,
  );
}

export interface Paths {
  root: string;
  cases: string;
  manifest: string;
  out: string;
  recordings: string;
  report: string;
}

export function putCases(p: Paths, cases: EvalCase[]): void {
  writeFileSync(join(p.cases, 'synthetic.jsonl'), cases.map((c) => JSON.stringify(c)).join('\n'));
  writeFileSync(p.manifest, JSON.stringify(computeManifest('smoke', 'synthetic-v1', cases)));
}

export async function withFiles(
  run: (p: Paths) => Promise<void>,
  cases: EvalCase[] = [sample()],
): Promise<void> {
  const parent = resolve('.tmp/evals-record');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-'));
  const p: Paths = {
    root,
    cases: join(root, 'cases'),
    manifest: join(root, 'manifest.json'),
    out: join(root, 'out'),
    recordings: join(root, 'recordings'),
    report: join(root, 'replay-report.json'),
  };
  try {
    mkdirSync(p.cases);
    mkdirSync(p.recordings);
    putCases(p, cases);
    await run(p);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function recordArgs(p: Paths): string[] {
  return ['record', '--cases', p.cases, '--manifest', p.manifest, '--out', p.out];
}

export function replayArgs(p: Paths, recordings = p.recordings): string[] {
  return [
    'replay',
    '--cases',
    p.cases,
    '--manifest',
    p.manifest,
    '--recordings',
    recordings,
    '--report',
    p.report,
  ];
}

export async function invoke(args: string[], dependencies: CliDeps) {
  // 动态加载允许时钟/id 测试 resetModules 后使用全新的模块状态，不 spawn 进程。
  const { runCli } = await import('../../../packages/evals/src/cli.ts');
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, dependencies, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

export function readReport(path: string): Report {
  return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

export function readLines(path: string): Recording[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Recording);
}

export function expectPrivateOutputAbsent(
  got: { stdout: string; stderr: string },
  p: Paths,
  cases: EvalCase[] = [sample()],
): void {
  const text = got.stdout + got.stderr;
  for (const secret of [
    p.root,
    MODEL_TEXT,
    ...cases.flatMap((c) => [c.id, ...c.turns.map((t) => t.text)]),
  ]) {
    expect(text).not.toContain(secret);
  }
  const codes = got.stderr.trim().split('\n').filter(Boolean);
  for (const line of codes) expect(line).toMatch(/^[a-z][a-z0-9_]*(?: [1-9][0-9]*)?$/);
  expect(codes).toEqual([...codes].sort());
}

export function expectVerdict(
  stdout: string,
  counts: { total: number; pass: number; fail: number; coverage_gap: number; error: number },
  passed: boolean,
): void {
  expect(stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(stdout)).toEqual({ passed, ...counts });
}
