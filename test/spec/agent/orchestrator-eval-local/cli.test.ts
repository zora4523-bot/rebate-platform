import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { runLocalEval } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import type { RunLocalEvalDeps } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import { runCli } from '../../../../packages/evals/src/cli.ts';
import { fixedClock } from '../../../../packages/evals/src/record.ts';
import { validateReport } from '../../../../packages/evals/src/report.ts';
import { parseJsonl } from '../../../../packages/evals/src/cases.ts';
import {
  withFiles,
  readReport,
  readLines,
  recordArgs,
  replayArgs,
  sample,
  expectPrivateOutputAbsent,
} from '../../evals-record/kit.ts';
import { AT, MODEL_TEXT, modelOptions, ports } from './kit.ts';

function wiring(patch: Partial<RunLocalEvalDeps> = {}) {
  let stdout = '';
  let stderr = '';
  const live = ports();
  const livePorts = vi.fn(() => live);
  const deps: RunLocalEvalDeps = {
    runCli,
    io: {
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    },
    clock: fixedClock(AT),
    livePorts,
    agent: modelOptions(),
    meta: {
      vendor: 'qwen',
      model_snapshot: 'synthetic-snapshot',
      prompt_sha256: 'b'.repeat(64),
      sampling: { temperature: 0 },
      tool_schema_version: 'synthetic@1',
      code_commit: 'c'.repeat(40),
      grader_version: '1',
    },
    ...patch,
  };
  return { deps, live, livePorts, output: () => ({ stdout, stderr }) };
}

it('[AC-B3-05m#5][AC-B3-05m#6][BR-AI-21] 公开合成冒烟集通过本机装配 record/replay，报告合规且逐题结果一致，只输出摘要', async () => {
  const casesDir = fileURLToPath(
    new URL('../../../../packages/evals/samples/smoke', import.meta.url),
  );
  const manifest = join(casesDir, 'manifest.json');
  const cases = readdirSync(casesDir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => parseJsonl(readFileSync(join(casesDir, name), 'utf8'), name).cases);
  await withFiles(async (p) => {
    const paths = { ...p, cases: casesDir, manifest };
    const record = wiring();
    const recordedCode = await runLocalEval(recordArgs(paths), record.deps);
    expect([0, 1]).toContain(recordedCode);
    expect(record.livePorts).toHaveBeenCalledTimes(1);
    expect(record.live.model.mock.calls.length).toBeGreaterThan(0);
    expect(record.live.tool.mock.calls.length).toBeGreaterThan(0);
    const recorded = readReport(join(p.out, 'report.json'));
    const replay = wiring();
    const replayCode = await runLocalEval(replayArgs(paths, p.out), replay.deps);
    expect(replayCode).toBe(recordedCode);
    const report = readReport(p.report);
    expect(validateReport(recorded)).toEqual([]);
    expect(validateReport(report)).toEqual([]);
    expect(report.summary.total).toBe(32);
    expect(report.summary.error).toBe(0);
    expect(report.summary.coverage_gap).toBe(0);
    expect(report.meta.unused_recordings).toBe(0);
    expect(report.cases).toEqual(recorded.cases);
    expect(
      report.cases.flatMap((item) => item.problems).map((problem) => problem.code),
    ).not.toContain('recording_miss');
    expect(replay.livePorts).not.toHaveBeenCalled();
    for (const run of [record, replay]) {
      const output = run.output();
      expectPrivateOutputAbsent(output, p, cases);
      expect(output.stdout + output.stderr).not.toContain(MODEL_TEXT);
      expect(output.stdout + output.stderr).not.toContain('合成工具响应');
      expect(output.stdout + output.stderr).not.toContain(casesDir);
      expect(output.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(output.stdout)).toEqual({
        passed: report.summary.pass === 32,
        total: 32,
        pass: report.summary.pass,
        fail: report.summary.fail,
        coverage_gap: 0,
        error: 0,
      });
    }
  });
});

it.each(['--cases', '--manifest', '--recordings'])(
  '[AC-B3-05m#6][BR-AI-21] replay 缺 %s 返回 2，不初始化被测 Agent 或 live 工厂，不寻找默认私有目录',
  async (missing) => {
    const route = vi.fn(modelOptions().route!);
    const run = wiring({ agent: { ...modelOptions(), route } });
    const args = [
      'replay',
      ...['--cases', '--manifest', '--recordings', '--report']
        .filter((flag) => flag !== missing)
        .flatMap((flag) => [flag, 'synthetic-must-not-read']),
    ];
    expect(await runLocalEval(args, run.deps)).toBe(2);
    expect(run.livePorts).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(run.output()).toEqual({ stdout: '', stderr: 'usage 1\n' });
  },
);

it('[AC-B3-05m#7][BR-AI-14] 装配和回放不读取 process.env，也不触碰 live 工厂', async () => {
  await withFiles(async (p) => {
    const recorded = wiring();
    await runLocalEval(recordArgs(p), recorded.deps);
    const replay = wiring();
    const original = process.env;
    const reads: PropertyKey[] = [];
    let code: number;
    // Proxy only surrounds the awaited call; assertions/framework output run after restoration.
    process.env = new Proxy(original, {
      get(target, key) {
        reads.push(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        reads.push(key);
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        reads.push('*');
        return Reflect.ownKeys(target);
      },
    });
    try {
      code = await runLocalEval(replayArgs(p, p.out), replay.deps);
    } finally {
      process.env = original;
    }
    expect(reads).toEqual([]);
    expect([0, 1]).toContain(code);
    expect(replay.livePorts).not.toHaveBeenCalled();
    expect(readReport(p.report).meta.unused_recordings).toBe(0);
  });
});

it('[AC-B3-05m#3][BR-AI-21] 工具录制缺失在本机报告中为 recording_miss，不伪装为成功降级', async () => {
  await withFiles(async (p) => {
    const record = wiring();
    await runLocalEval(recordArgs(p), record.deps);
    const lines = readLines(join(p.out, 'recordings.jsonl'));
    expect(lines.some((line) => line.kind === 'tool')).toBe(true);
    writeFileSync(
      join(p.recordings, 'models-only.jsonl'),
      lines
        .filter((line) => line.kind === 'model')
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    const run = wiring();
    const code = await runLocalEval(replayArgs(p), run.deps);
    expect(code).toBe(1);
    const report = readReport(p.report);
    expect(report.cases[0]).toMatchObject({
      result: 'coverage_gap',
      problems: [{ code: 'recording_miss' }],
    });
    expect(report.summary.pass).toBe(0);
    expect(run.livePorts).not.toHaveBeenCalled();
  });
});

it('[AC-B3-05m#8][BR-AI-21] 默认空提示词与无模型路由录制零模型行，逐题如实判分，保留调用方 meta', async () => {
  await withFiles(
    async (p) => {
      const run = wiring({ agent: {} });
      expect(await runLocalEval(recordArgs(p), run.deps)).toBe(1);
      expect(run.live.model).not.toHaveBeenCalled();
      expect(
        readLines(join(p.out, 'recordings.jsonl')).filter((line) => line.kind === 'model'),
      ).toEqual([]);
      const report = readReport(join(p.out, 'report.json'));
      expect(validateReport(report)).toEqual([]);
      expect(report.summary.total).toBe(1);
      expect(report.summary.pass).toBe(0);
      expect(report.cases[0]!.result).toBe('fail');
      expect(report.meta).toMatchObject({
        model_snapshot: 'synthetic-snapshot',
        prompt_sha256: 'b'.repeat(64),
      });
    },
    [sample({ expect: { intent: 'search', tools: [{ name: 'search_products' }] } })],
  );
});
