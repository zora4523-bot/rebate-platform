import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { canonicalJson } from '../../../packages/evals/src/index.ts';
import type { AgentUnderTest, ModelRequest, Recording } from '../../../packages/evals/src/index.ts';
import type { CliDeps } from '../../../packages/evals/src/cli.ts';
import {
  AT,
  MODEL_TEXT,
  call,
  deps,
  digest,
  expectPrivateOutputAbsent,
  expectVerdict,
  invoke,
  jsonl,
  livePorts,
  output,
  putCases,
  readLines,
  readReport,
  recordArgs,
  replayArgs,
  request,
  sample,
  withFiles,
} from './kit.ts';

const passCounts = { total: 1, pass: 1, fail: 0, coverage_gap: 0, error: 0 };

const modelAgent: AgentUnderTest = async (input, ports) => {
  const response = (await ports.model(request({ messages: [{ text: input.text }] }))) as {
    text: string;
  };
  return output([response.text]);
};

it.each(['sync', 'async'] as const)(
  '[AC-B3-01h#6][AC-B3-01h#8][BR-AI-21] record 的 %s live 工厂只调用一次且无参数，生成录制和报告，只输出汇总',
  async (kind) => {
    const cases = [
      sample(),
      sample({ id: 'synthetic-factory-second', turns: [{ text: '合成第二题工厂复用' }] }),
    ];
    const counts = { total: 2, pass: 2, fail: 0, coverage_gap: 0, error: 0 };
    await withFiles(async (p) => {
      const factory = vi.fn(kind === 'sync' ? () => livePorts() : async () => livePorts());
      const got = await invoke(
        recordArgs(p),
        deps({ agent: () => modelAgent, livePorts: factory }),
      );
      expect(got.code).toBe(0);
      expect(factory.mock.calls).toEqual([[]]);
      expectVerdict(got.stdout, counts, true);
      expect(got.stderr).toBe('');
      expectPrivateOutputAbsent(got, p, cases);
      const report = readReport(join(p.out, 'report.json'));
      expect(report.meta.mode).toBe('integration');
      expect(report.meta).toMatchObject({
        vendor: 'synthetic-vendor',
        model_snapshot: 'synthetic-snapshot',
        prompt_sha256: 'b'.repeat(64),
        sampling: { temperature: 0 },
        tool_schema_version: 'synthetic-tools@1',
        code_commit: 'c'.repeat(40),
        grader_version: '1',
      });
      expect(report.summary).toMatchObject(counts);
      expect(readLines(join(p.out, 'recordings.jsonl'))).toEqual(
        cases
          .map((c) => ({
            kind: 'model',
            key: digest(canonicalJson(request({ messages: [{ text: c.turns[0]!.text }] }))),
            response: { text: MODEL_TEXT },
            recorded_at: AT,
          }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      );
    }, cases);
  },
);

it('[AC-B3-01h#2][AC-B3-01h#6][BR-AI-21] record 写出的模型与工具录制递归剥离身份和鉴权字段，保留其他字段', async () => {
  await withFiles(async (p) => {
    const response = {
      user_id: 'SYNTHETIC-CLI-USER-SECRET',
      nested: [
        {
          device_id: 'SYNTHETIC-CLI-DEVICE-SECRET',
          headers: {
            authorization: 'Bearer sk-SYNTHETIC-CLI-AUTH',
            'x-api-key': 'sk-SYNTHETIC-CLI-API',
            cookie: 'SYNTHETIC-CLI-COOKIE-SECRET',
            accept: 'application/json',
          },
          keep: ['合成公开商品', 0, false, null],
        },
      ],
    };
    const before = structuredClone(response);
    const model = vi.fn(async () => response);
    const tool = vi.fn(async () => response);
    const agent: AgentUnderTest = async (_input, ports) => {
      await ports.model(request());
      await ports.tool(call());
      return output();
    };
    const got = await invoke(
      recordArgs(p),
      deps({ agent: () => agent, livePorts: () => ({ model, tool }) }),
    );
    expect(got.code).toBe(0);
    expectVerdict(got.stdout, passCounts, true);
    expect(model).toHaveBeenCalledTimes(1);
    expect(tool).toHaveBeenCalledTimes(1);
    const records = readLines(join(p.out, 'recordings.jsonl'));
    expect(records.map((r) => r.kind)).toEqual(['model', 'tool']);
    for (const record of records) {
      expect(record.response).toEqual({
        nested: [
          { headers: { accept: 'application/json' }, keep: ['合成公开商品', 0, false, null] },
        ],
      });
    }
    const serialized = readFileSync(join(p.out, 'recordings.jsonl'), 'utf8');
    for (const secret of [
      'user_id',
      'device_id',
      'authorization',
      'x-api-key',
      'cookie',
      response.user_id,
      response.nested[0]!.device_id,
      response.nested[0]!.headers.authorization,
      response.nested[0]!.headers['x-api-key'],
      response.nested[0]!.headers.cookie,
    ]) {
      expect(serialized + got.stdout + got.stderr).not.toContain(secret);
    }
    expect(response).toEqual(before);
    expectPrivateOutputAbsent(got, p);
  });
});

it.each(['fail', 'coverage_gap', 'error', 'conflict'] as const)(
  '[AC-B3-01h#6][AC-B3-01h#8][BR-AI-21] record %s 退出 1，即使冲突时题目全过也不能回写通过',
  async (kind) => {
    const cases = [
      sample(
        kind === 'coverage_gap'
          ? { expect: { intent: 'search', forbid: ['banned_word_in_text'] } }
          : {},
      ),
    ];
    await withFiles(async (p) => {
      const agent: AgentUnderTest = async (_input, ports) => {
        if (kind === 'error') throw new Error(`${p.root} ${cases[0]!.id} ${MODEL_TEXT}`);
        await ports.model(request());
        if (kind === 'conflict') await ports.model(request());
        return kind === 'fail'
          ? output([], { trace: { intent: 'refine', tool_calls: [] } })
          : output();
      };
      const model = vi
        .fn()
        .mockResolvedValueOnce({ text: '合成第一条' })
        .mockResolvedValueOnce({ text: '合成冲突条' });
      const got = await invoke(
        recordArgs(p),
        deps({ agent: () => agent, livePorts: () => ({ model, tool: async () => null }) }),
      );
      expect(got.code).toBe(1);
      const counts = {
        total: 1,
        pass: 0,
        fail: 0,
        coverage_gap: 0,
        error: 0,
        [kind === 'conflict' ? 'pass' : kind]: 1,
      };
      expectVerdict(got.stdout, counts, false);
      expect(readReport(join(p.out, 'report.json')).summary).toMatchObject(counts);
      expect(got.stderr.trim()).not.toBe('');
      if (kind === 'conflict') {
        expect(got.stderr).toMatch(/\brecording_conflict\b/);
        expect(readLines(join(p.out, 'recordings.jsonl'))).toHaveLength(1);
        expect(readLines(join(p.out, 'recordings.jsonl'))[0]?.response).toEqual({
          text: '合成第一条',
        });
      }
      expectPrivateOutputAbsent(got, p, cases);
    }, cases);
  },
);

it.each(['no_agent', 'no_live_ports'] as const)(
  '[AC-B3-01h#6][AC-B3-01h#8][BR-AI-21] record 缺少依赖 %s 退出 2，只报问题码',
  async (code) => {
    await withFiles(async (p) => {
      const dependencies = deps();
      if (code === 'no_agent') delete dependencies.agent;
      else delete dependencies.livePorts;
      const got = await invoke(recordArgs(p), dependencies);
      expect(got.code).toBe(2);
      expect(got.stderr.trim().split(/\s+/)[0]).toBe(code);
      expectPrivateOutputAbsent(got, p);
    });
  },
);

it.each(['--cases', '--manifest', '--out'])(
  '[AC-B3-01h#6][BR-AI-21] record 缺少必填参数 %s 退出 2',
  async (flag) => {
    await withFiles(async (p) => {
      const args = recordArgs(p);
      args.splice(args.indexOf(flag), 2);
      const got = await invoke(args, deps());
      expect(got.code).toBe(2);
      expect(got.stderr.trim()).not.toBe('');
      expectPrivateOutputAbsent(got, p);
    });
  },
);

it.each(['cases', 'manifest'] as const)(
  '[AC-B3-01h#6][AC-B3-01h#8][BR-AI-21] record 无法读取 %s 退出 2，不打印路径',
  async (missing) => {
    await withFiles(async (p) => {
      rmSync(p[missing], { recursive: true, force: true });
      const got = await invoke(recordArgs(p), deps());
      expect(got.code).toBe(2);
      expect(got.stderr).toMatch(/\bio\b/);
      expectPrivateOutputAbsent(got, p);
    });
  },
);

it('[AC-B3-01h#6][AC-B3-01h#8][BR-AI-21] live 工厂意外异常只输出 internal、退出 2', async () => {
  await withFiles(async (p) => {
    const got = await invoke(
      recordArgs(p),
      deps({
        livePorts: () => {
          throw new Error(`${p.root} ${MODEL_TEXT}`);
        },
      }),
    );
    expect(got.code).toBe(2);
    expect(got.stderr.trim().split(/\s+/)[0]).toBe('internal');
    expectPrivateOutputAbsent(got, p);
  });
});

// 回放输入独立手写，避免 CLI record 与 replay 互相掩盖缺陷。
function replayFixture() {
  const req = request();
  const tc = call({ state: { turn: 1, result_set_ids: [], tool_set: [] } });
  const records: Recording[] = [
    {
      kind: 'model',
      key: digest(canonicalJson(req)),
      response: { text: MODEL_TEXT },
      recorded_at: AT,
    },
    {
      kind: 'tool',
      key: digest(canonicalJson(tc)),
      response: { title: '合成商品' },
      recorded_at: AT,
    },
  ];
  const agent: AgentUnderTest = async (_input, ports) => {
    const response = (await ports.model(req)) as { text: string };
    const product = (await ports.tool(tc)) as { title: string };
    return output([response.text, product.title]);
  };
  return { records, agent };
}

it('[AC-B3-01h#7][AC-B3-01h#8][BR-AI-21] replay 读取目录全部 jsonl、忽略其他文件、模式 A、摘要为 SHA256，禁止调用 live', async () => {
  await withFiles(async (p) => {
    const { records, agent } = replayFixture();
    writeFileSync(join(p.recordings, 'a.jsonl'), jsonl([records[0]]));
    writeFileSync(join(p.recordings, 'z.jsonl'), jsonl([records[1]]));
    writeFileSync(join(p.recordings, 'ignored.txt'), '合成非 JSON 文件');
    const forbiddenLive = vi.fn(() => {
      throw new Error('合成禁止调用 live');
    });
    const got = await invoke(replayArgs(p), deps({ agent: () => agent, livePorts: forbiddenLive }));
    expect(got.code).toBe(0);
    expect(forbiddenLive).not.toHaveBeenCalled();
    expectVerdict(got.stdout, passCounts, true);
    expect(got.stderr).toBe('');
    const report = readReport(p.report);
    expect(report.meta).toMatchObject({
      mode: 'A',
      unused_recordings: 0,
      recordings_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(report.summary).toMatchObject(passCounts);
    expectPrivateOutputAbsent(got, p);
  });
});

it.each(['fail', 'error'] as const)(
  '[AC-B3-01h#7][AC-B3-01h#8][BR-AI-21] replay 录制全部命中但题目为 %s 时退出 1，不能回写通过',
  async (result) => {
    await withFiles(async (p) => {
      const { records, agent: consumeRecordings } = replayFixture();
      writeFileSync(join(p.recordings, 'synthetic.jsonl'), jsonl(records));
      const agent: AgentUnderTest = async (input, ports) => {
        await consumeRecordings(input, ports);
        if (result === 'error') throw new Error(`${p.root} ${input.case_id} ${MODEL_TEXT}`);
        return output([], { trace: { intent: 'refine', tool_calls: [] } });
      };
      const got = await invoke(replayArgs(p), deps({ agent: () => agent }));
      expect(got.code).toBe(1);
      const counts = {
        total: 1,
        pass: 0,
        fail: result === 'fail' ? 1 : 0,
        coverage_gap: 0,
        error: result === 'error' ? 1 : 0,
      };
      expectVerdict(got.stdout, counts, false);
      const report = readReport(p.report);
      expect(report.summary).toMatchObject(counts);
      expect(report.meta).toMatchObject({ mode: 'A', unused_recordings: 0 });
      expect(report.cases.map((c) => c.result)).toEqual([result]);
      const code = result === 'fail' ? 'intent_mismatch' : 'agent_error';
      expect(report.cases[0]?.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code, layer: result === 'fail' ? 'L3' : null }),
        ]),
      );
      expect(report.cases.flatMap((c) => c.problems).map((problem) => problem.code)).not.toContain(
        'recording_miss',
      );
      expect(got.stderr).toContain(code);
      expect(got.stderr).not.toContain('recording_miss');
      expectPrivateOutputAbsent(got, p);
    });
  },
);

it('[AC-B3-01h#7][AC-B3-01h#8][BR-AI-21] replay 未命中退出 1、记录 coverage_gap，只回写 recording_miss 与汇总', async () => {
  await withFiles(async (p) => {
    const { agent } = replayFixture();
    const got = await invoke(replayArgs(p), deps({ agent: () => agent }));
    expect(got.code).toBe(1);
    expect(got.stderr).toMatch(/\brecording_miss\b/);
    expectVerdict(got.stdout, { total: 1, pass: 0, fail: 0, coverage_gap: 1, error: 0 }, false);
    expect(readReport(p.report).cases[0]?.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'recording_miss' })]),
    );
    expectPrivateOutputAbsent(got, p);
  });
});

it.each(['json', 'schema', 'recording_conflict', 'io'] as const)(
  '[AC-B3-01h#7][AC-B3-01h#8][BR-AI-21] replay 载入问题 %s 退出 2，跨文件冲突也拒绝',
  async (problem) => {
    await withFiles(async (p) => {
      const { records, agent } = replayFixture();
      writeFileSync(join(p.recordings, 'a.jsonl'), jsonl(records));
      if (problem === 'json')
        writeFileSync(join(p.recordings, 'b.jsonl'), `{"secret":"${MODEL_TEXT}",broken`);
      if (problem === 'schema')
        writeFileSync(join(p.recordings, 'b.jsonl'), jsonl([{ ...records[0], key: 'invalid' }]));
      if (problem === 'recording_conflict')
        writeFileSync(
          join(p.recordings, 'b.jsonl'),
          jsonl([{ ...records[0], response: '合成不同响应' }]),
        );
      if (problem === 'io') rmSync(p.recordings, { recursive: true });
      const got = await invoke(replayArgs(p), deps({ agent: () => agent }));
      expect(got.code).toBe(2);
      expect(got.stderr).toContain(problem);
      expectPrivateOutputAbsent(got, p);
    });
  },
);

it('[AC-B3-01h#7][BR-AI-21] replay 无 agent 退出 2，不能无声回写全过', async () => {
  await withFiles(async (p) => {
    const got = await invoke(replayArgs(p), {});
    expect(got.code).toBe(2);
    expect(got.stderr).toMatch(/\bno_agent\b/);
    expectPrivateOutputAbsent(got, p);
  });
});

it.each(['injected', 'default'] as const)(
  '[AC-B3-01h#9][BR-AI-21] %s 时钟与逐题 id 支持清空模块状态后回放、重复录制和只回放第二题',
  async (mode) => {
    const cases = [
      sample({ id: 'synthetic-clock-a', turns: [{ text: '合成首轮甲' }, { text: '合成次轮甲' }] }),
      sample({ id: 'synthetic-clock-b', turns: [{ text: '合成首轮乙' }, { text: '合成次轮乙' }] }),
    ];
    await withFiles(async (p) => {
      const requests: ModelRequest[] = [];
      const factory: NonNullable<CliDeps['agent']> = (env) => async (input, ports) => {
        const req = request({
          messages: [{ text: input.text }],
          params: { at: env.clock.now().toISOString(), id: env.ids.next() },
        });
        requests.push(structuredClone(req));
        await ports.model(req);
        return output();
      };
      function dependencies(): CliDeps {
        const value = deps({ agent: factory });
        if (mode === 'default') delete value.clock;
        return value;
      }
      expect((await invoke(recordArgs(p), dependencies())).code).toBe(0);
      expect(requests.map((r) => r.params)).toEqual([
        { at: mode === 'default' ? '2000-01-01T00:00:00.000Z' : AT, id: 'eval-1' },
        { at: mode === 'default' ? '2000-01-01T00:00:00.000Z' : AT, id: 'eval-2' },
        { at: mode === 'default' ? '2000-01-01T00:00:00.000Z' : AT, id: 'eval-1' },
        { at: mode === 'default' ? '2000-01-01T00:00:00.000Z' : AT, id: 'eval-2' },
      ]);
      const original = readLines(join(p.out, 'recordings.jsonl'));
      expect(original).toHaveLength(4);
      expect(
        original.every(
          (r) => r.recorded_at === (mode === 'default' ? '2000-01-01T00:00:00.000Z' : AT),
        ),
      ).toBe(true);
      vi.resetModules();
      const replayed = await invoke(replayArgs(p, p.out), dependencies());
      expect(replayed.code).toBe(0);
      expect(replayed.stderr).toBe('');
      expect(readReport(p.report).meta.unused_recordings).toBe(0);
      vi.resetModules();
      const secondOut = join(p.root, 'second-out');
      expect((await invoke(recordArgs({ ...p, out: secondOut }), dependencies())).code).toBe(0);
      expect(readLines(join(secondOut, 'recordings.jsonl'))).toEqual(original);
      putCases(p, [cases[1]!]);
      vi.resetModules();
      const single = await invoke(replayArgs(p, p.out), dependencies());
      expect(single.code).toBe(0);
      expect(single.stderr).not.toContain('recording_miss');
      expectVerdict(single.stdout, passCounts, true);
    }, cases);
  },
);

it('[AC-B3-01h#10][AC-B3-01h#8][BR-AI-21] 不读取环境密钥，产物和输出不泄漏合成 key，源码无 process.env', async () => {
  const secret = 'sk-SYNTHETIC-ENV-DO-NOT-READ';
  vi.stubEnv('OPENAI_API_KEY', secret);
  vi.stubEnv('DASHSCOPE_API_KEY', secret);
  try {
    await withFiles(async (p) => {
      const got = await invoke(recordArgs(p), deps({ agent: () => modelAgent }));
      expect(got.code).toBe(0);
      const artifacts =
        readFileSync(join(p.out, 'recordings.jsonl'), 'utf8') +
        readFileSync(join(p.out, 'report.json'), 'utf8');
      expect(artifacts + got.stdout + got.stderr).not.toContain(secret);
      expectPrivateOutputAbsent(got, p);
      const root = new URL('../../../packages/evals/src/', import.meta.url);
      const files = readdirSync(root, { recursive: true }).filter(
        (name): name is string =>
          typeof name === 'string' && name.endsWith('.ts') && !name.endsWith('.test.ts'),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const file of files)
        expect(readFileSync(new URL(file, root), 'utf8'), file).not.toMatch(/process\s*\.\s*env/);
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
