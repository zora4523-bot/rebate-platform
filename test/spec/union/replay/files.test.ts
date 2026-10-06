import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createUnionFileReplay,
  createUnionReplayClient,
  loadUnionEndpoints,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  instant,
  platforms,
  provenance,
  recording,
  request,
  scenario,
  workspace,
  writeRecording,
} from './kit.ts';

it.each(platforms)(
  '[AC-B1-04c-FILES#1] %s 按平台和 X-Scenario 读取文件并原样回放状态、响应头与正文',
  async (platform) => {
    await workspace(async (root) => {
      const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
      for (const candidate of platforms) {
        await writeRecording(
          root,
          candidate,
          scenario,
          provenance(),
          recording(`synthetic-${candidate}`),
        );
        await writeRecording(
          root,
          candidate,
          'synthetic-other',
          provenance(),
          recording('synthetic-other'),
        );
      }
      expect(await replay.transport(request(platform))).toEqual(
        recording(`synthetic-${platform}`).response,
      );
      expect(await replay.transport(request(platform, 'synthetic-other'))).toEqual(
        recording('synthetic-other').response,
      );
      // Repeating the same input is deterministic and does not consume a global cursor.
      expect(await replay.transport(request(platform))).toEqual(
        recording(`synthetic-${platform}`).response,
      );
    });
  },
);

it('[AC-B1-04c-FILES#2] 配置读取、注入传输与文件回放完整串联且没有网络服务', async () => {
  await workspace(async (root) => {
    const directory = join(root, 'fixtures', 'union-recordings');
    const replay = createUnionFileReplay({ directory, clock: new FixedClock(instant) });
    const config = join(root, 'config', 'union-endpoints');
    await mkdir(config, { recursive: true });
    for (const platform of platforms) {
      await writeFile(
        join(config, `${platform}.json`),
        JSON.stringify({
          platform,
          mode: 'replay',
          baseUrl: `http://${platform}.synthetic.invalid/synthetic-api/`,
          quotaKey: `synthetic:${platform}`,
        }),
      );
      await writeRecording(directory, platform);
    }
    const client = createUnionReplayClient({
      endpoints: await loadUnionEndpoints(config, 'test'),
      transport: replay.transport,
    });
    for (const platform of platforms) {
      expect(
        await client.send(platform, {
          method: 'POST',
          path: 'echo?case=synthetic',
          scenario,
          body: 'synthetic-input',
        }),
      ).toEqual(recording().response);
    }
    expect(
      replay
        .report()
        .recordings.map((entry) => entry.platform)
        .sort(),
    ).toEqual([...platforms]);
    expect(replay.report().acceptanceEligible).toBe(false);
  });
});

it('[AC-B1-04c-FILES#3] X-Scenario 请求头大小写不影响选取文件', async () => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    await writeRecording(root);
    expect(await replay.transport({ ...request(), headers: { 'x-scenario': scenario } })).toEqual(
      recording().response,
    );
  });
});

it.each([
  { method: 'GET' as const },
  { url: 'https://synthetic.invalid/synthetic-api/another?case=synthetic' },
  { url: 'https://synthetic.invalid/synthetic-api/echo?case=other' },
  { body: 'synthetic-wrong-body' },
])('[AC-B1-04c-FILES#4] 请求不匹配录制时 %j 不得返回预设成功', async (override) => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    await writeRecording(root);
    await expect(replay.transport({ ...request(), ...override })).rejects.toMatchObject({
      code: 'recording_mismatch',
    });
    expect(replay.report().acceptanceEligible).toBe(false);
  });
});

it('[AC-B1-04c-FILES#13] 录制要求正文时不能把无正文请求视作匹配', async () => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    await writeRecording(root);
    const { platform, url, method, headers } = request();
    await expect(replay.transport({ platform, url, method, headers })).rejects.toMatchObject({
      code: 'recording_mismatch',
    });
  });
});

it.each(['recording.json', 'provenance.json'])(
  '[AC-B1-04c-FILES#5] 缺少 %s 拒绝回放，不默认合成或 probe 来源',
  async (file) => {
    await workspace(async (root) => {
      const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
      const directory = await writeRecording(root);
      await rm(join(directory, file));
      await expect(replay.transport(request())).rejects.toMatchObject({
        code: 'recording_missing',
      });
      expect(replay.report().acceptanceEligible).toBe(false);
    });
  },
);

it.each([
  ['recording.json', 'invalid_recording'],
  ['provenance.json', 'invalid_provenance'],
])('[AC-B1-04c-FILES#6] %s 不是合法 JSON 时拒绝回放', async (file, code) => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    const directory = await writeRecording(root);
    await writeFile(join(directory, file), '{synthetic-invalid-json');
    await expect(replay.transport(request())).rejects.toMatchObject({ code });
    expect(replay.report().acceptanceEligible).toBe(false);
  });
});

it.each([
  null,
  {},
  { ...recording(), response: { status: 202, headers: {}, body: { synthetic: true } } },
  { ...recording(), response: { status: '202', headers: {}, body: 'synthetic' } },
  { ...recording(), response: { status: 202, headers: { synthetic: 42 }, body: 'synthetic' } },
  { ...recording(), request: null },
])('[AC-B1-04c-FILES#7] 文件外壳无效时不得当作有效录制 %j', async (envelope) => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    await writeRecording(root, 'jd', scenario, provenance(), envelope);
    await expect(replay.transport(request())).rejects.toMatchObject({ code: 'invalid_recording' });
  });
});

it.each([
  { source: 'unknown' },
  { source: 'probe', probeRunId: null },
  { originalSha256: 'synthetic-bad-digest' },
])('[AC-B1-04c-FILES#8] 加载路径实际校验 provenance 字段 %j', async (override) => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    await writeRecording(root, 'jd', scenario, { ...provenance(), ...override });
    await expect(replay.transport(request())).rejects.toMatchObject({ code: 'invalid_provenance' });
    expect(replay.report().acceptanceEligible).toBe(false);
  });
});

it('[AC-B1-04c-FILES#9] 不存在的场景不回退到其他录制或演示数据', async () => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    await writeRecording(root);
    await expect(replay.transport(request('jd', 'synthetic-absent'))).rejects.toMatchObject({
      code: 'recording_missing',
    });
    expect(replay.report().recordings).toEqual([]);
  });
});

it.each([
  '',
  '../synthetic-other',
  '../../pdd/synthetic-smoke',
  '/synthetic-absolute',
  'synthetic/child',
  '..\\synthetic-other',
  '%2e%2e%2fsynthetic-other',
])('[AC-B1-04c-FILES#10] 不安全的场景路径 %s 不能逃出平台目录', async (selectedScenario) => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    await writeRecording(root, 'pdd');
    await expect(replay.transport(request('jd', selectedScenario))).rejects.toMatchObject({
      code: 'invalid_replay_request',
    });
    expect(replay.report().recordings).toEqual([]);
  });
});

it('[AC-B1-04c-FILES#11] 缺少场景头不能隐式加载默认文件', async () => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    await writeRecording(root);
    await expect(replay.transport({ ...request(), headers: {} })).rejects.toMatchObject({
      code: 'invalid_replay_request',
    });
  });
});

it.each(['scenario', 'provenance.json', 'recording.json'])(
  '[AC-B1-04c-FILES#12] %s 符号链接不能读取录制根目录之外的文件',
  async (target) => {
    await workspace(async (root) => {
      const directory = join(root, 'recordings');
      const replay = createUnionFileReplay({ directory, clock: new FixedClock(instant) });
      const outside = await writeRecording(join(root, 'outside'));
      const inside = await writeRecording(directory);
      const link = target === 'scenario' ? inside : join(inside, target);
      await rm(link, { recursive: true, force: true });
      await symlink(target === 'scenario' ? outside : join(outside, target), link);
      await expect(replay.transport(request())).rejects.toMatchObject({
        code: 'invalid_replay_request',
      });
      expect(replay.report().recordings).toEqual([]);
    });
  },
);
